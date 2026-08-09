# Source Atlas

## Responsibility

`src/` contains the OMP-facing extension, its runtime module, strict local configuration, persistent Project metadata, and the `src/hub/` transport/persistence modules.

The central seam is `A2aRuntime`: extension callbacks and commands depend on one stateful interface rather than coordinating HTTP and WebSocket clients independently.

## Module map

| File | Responsibility | Primary interface |
| --- | --- | --- |
| `extension.ts` | OMP registration, session lifecycle, UI notifications, reconnect policy, slash commands, completions, and model tools. | default extension factory |
| `local-attachments.ts` | Snapshot sender-session `local://` files and materialize received/history attachment bytes into the calling session. | `snapshotLocalAttachments`, `materializeLocalAttachments` |
| `operations.ts` | Connected runtime over one WebSocket plus HTTP Project/history operations. | `A2aRuntime`, `MessageView`, `RuntimeStatus` |
| `config.ts` | Strict repository-local YAML/JSON connection defaults. | `loadLocalConfig` |
| `simple-yaml.ts` | Shared quote-aware strict YAML subset for local and global Hub configuration. | `parseSimpleYaml` |
| `paths.ts` | Hub storage paths and local config candidates. | path functions |
| `registry.ts` | Filesystem-backed persistent Project metadata. | `createProject`, `getProject`, `listProjects`, `deleteProject` |
| `types.ts` | Project/config domain shapes and name validation regexes. | `A2aProject`, `A2aLocalConfig` |
| `hub/` | HTTP/WebSocket clients and Hub implementation. | [`hub/codemap.md`](hub/codemap.md) |

## Extension lifecycle

`a2aExtension(pi)` owns one session-local `A2aRuntime` and the following state:

- cached current-selection `HubClient`;
- active OMP `ExtensionContext` for message injection and notifications;
- desired `{ project, name }` used by reconnect;
- one bounded exponential reconnect timer, from 500 ms to 10 seconds;
- monotonic session and desired-state generations that fence every asynchronous transition and callback.

On `session_start` and `session_switch`, the extension:

1. advances both generations, clears the active context so in-flight inbound callbacks cannot inject into the new session, and clears reconnect intent;
2. disconnects the old Presence and clears the prior Hub selection;
3. activates the new context and loads its repository-local configuration exactly once;
4. contains malformed configuration as a UI error with no stale Presence or Hub client;
5. clears prior desired connection state and auto-connects only when configuration exists and `autoConnect !== false`.

On `session_shutdown`, it advances the generations, clears the active context and desired state, cancels reconnect, and closes the socket. Unexpected current-socket close schedules reconnect. A `name_in_use` response is terminal for that exact desired generation rather than repeatedly displacing or retrying the owner. Events, completions, and failures from retired sockets or superseded transitions are discarded.

### Inbound events

- `presence_joined` and `presence_left` update the UI only.
- `delivery` reports the selected peer name and `delivered`/`failed`/`disconnected` outcome.
- `message` callbacks run serially in Hub-assigned Project sequence. Each callback captures the active session, materializes attachment bytes, then verifies that the session is still active before injecting an `a2a-inbound` OMP custom message through `steer`; session changes cancel the injection. Idle sessions start a turn and busy sessions queue the Message into the active turn. Materialization or injection failure produces `failed`, not `delivered`.
- socket/protocol errors are written to the extension logger.

## Human command surface

`/a2a` is administration and inspection only:

- `hub`
- `project create <name>`
- `project list`
- `project delete <name>` with UI confirmation
- `connect <project> --as <name>`
- `disconnect`
- `status`
- `peers`
- `history [--before <ref> | --after <ref>] [--limit <n>] [--from <name>]`
- `help`

`completeA2aArguments` provides synchronous, context-sensitive completion. It preserves the full argument prefix in each returned value, removes already-used flags, and enforces the `before`/`after` mutual exclusion in suggestions.

## Model tool surface

The extension uses the injected ArkType module as the canonical schema authoring surface.

| Tool | Contract |
| --- | --- |
| `a2a_peers` | Returns current peer names from the connected Presence snapshot. |
| `a2a_message` | Requires a typed direct or Project target and text; accepts optional current-session `local://` attachment sources, `replyTo`, and `messageId`; every description and success result states the push-driven reply control flow. |
| `a2a_history` | Accepts `before`, `after`, `limit`, and `from`; rematerializes persisted attachments into the calling session; it is only for deliberate review of persisted context, never waiting for a new reply. |

Connected model turns receive the current A2A roster name and use only `a2a_peers` results or inbound sender names to address peers; disconnected turns receive no A2A identity prompt. There is no model-side connect/disconnect or Project administration. Replies arrive automatically; after sending, the model continues independent work or ends its turn instead of waiting or polling history.

## Runtime interface

`A2aRuntime` publishes at most one `{ A2aConnection, HubClient }` pair.

- `connect(project, name)` establishes a bounded and cancellable buffered candidate first, atomically publishes it, then gracefully closes the predecessor. Candidate failure preserves the working predecessor; a later connect/disconnect generation aborts and closes stale candidates, including sockets still awaiting the handshake.
- `disconnect()` invalidates in-flight candidates and clears the published pair before awaiting bounded graceful close.
- `peers()` returns the current client-side Presence map.
- `message()` requires a live connection and decodes the accepted persistent message. Pre-dispatch cancellation prevents sending; post-dispatch cancellation reports an explicit unknown outcome and removes the pending request.
- `history()` uses the HubClient bound to the published Presence, not a later configuration selection.
- `status()` combines metadata from that same bound Hub with connected Presence state; when disconnected it uses the current selection.
- Project create/list/delete use the current selected Hub and do not require a Presence.

`MessageView` is the persistent realtime Message shape with decoded text and attachment bytes replacing encoded wire payloads.

## Configuration contract

`loadLocalConfig(cwd)` selects the first existing file in this order:

1. `.omp/a2a.yml`
2. `.omp/a2a.yaml`
3. `.omp/a2a.json`

The selected file is authoritative: read, parse, validation, and unsupported-YAML failures propagate. Required fields are `project` and `name`; optional fields are `hubUrl` and boolean `autoConnect`. Removed `agentId`/`autoJoin` spellings fail with a migration error rather than being accepted as aliases.

The YAML parser supports a one-level mapping and string lists. It preserves quoted `#` and comma content and rejects unsupported nested syntax.

## Project metadata

`registry.ts` is the sole owner of persistent Project JSON:

```text
<dataDir>/projects/<project>/project.json
```

Creation validates the Project name, rejects an existing metadata file, and atomically renames a mode-`0600` temporary JSON file. Listing scans valid Project directories and sorts by name. Deletion recursively removes one Project directory and is idempotent for a missing Project.

The Hub, not the extension, calls these functions in normal operation.

## Naming contract

- Project: starts alphanumeric, then `[a-zA-Z0-9._-]`, maximum 64 characters.
- Agent name: starts alphanumeric, then `[a-zA-Z0-9._-]`, maximum 32 characters.

A name identifies only the lifetime of one current WebSocket Presence. It is not durable identity.

## Data flow

```text
OMP callbacks / slash / tools
            │
            ▼
       extension.ts
            │
            ▼
       A2aRuntime
       ├─ HubClient ───── HTTP meta / Projects / history
       └─ A2aConnection ─ WebSocket Presence / messages / delivery
                              │
                              ▼
                         standalone Hub
```

## Tests touching this directory

- `extension.test.ts`: registered surfaces, help contract, ArkType schemas, multi-level command parsing/completion, malformed-config containment, superseded session transitions, and cross-session attachment snapshot/materialization/history.
- `operations.test.ts`: atomic connection swaps, accepting-Hub binding, stalled-handshake cancellation, snapshots, message and successful/failed Delivery callbacks, cancellation, and disconnected errors.
- `config.test.ts` and `hub-client.test.ts`: strict shared YAML/JSON loading, authoritative precedence, migration failures, external response validation, deadlines, and cancellation.
- `hub-control.test.ts`: public Project control, listener/public URL separation, recoverable deletion, startup unwind, and strict HTTP errors reached through `HubClient`.

See the repository root `codemap.md` for deployment and verification contracts.
