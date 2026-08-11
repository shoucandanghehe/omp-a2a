# Source Atlas

## Responsibility

`src/` contains the OMP-facing extension, its runtime module, strict local configuration, persistent Project metadata, and the `src/hub/` transport/persistence modules.

The central seam is `A2aRuntime`: extension callbacks and commands depend on one stateful interface rather than coordinating HTTP and WebSocket clients independently.

## Module map

| File | Responsibility | Primary interface |
| --- | --- | --- |
| `extension.ts` | OMP registration, session lifecycle, UI notifications, reconnect policy, slash commands, completions, and model tools. | default extension factory |
| `local-attachments.ts` | Cancellable snapshot of sender-session `local://` files and leak-free materialization of received/history attachment bytes into the calling session. | `snapshotLocalAttachments`, `materializeLocalAttachments` |
| `operations.ts` | Connected runtime over one WebSocket plus HTTP Project/history operations. | `A2aRuntime`, `MessageView`, `RuntimeStatus` |
| `config.ts` | Strict repository-local YAML/JSON connection defaults. | `loadLocalConfig` |
| `paths.ts` | Hub storage paths and local config candidates. | path functions |
| `registry.ts` | Filesystem-backed persistent Project metadata. | `createProject`, `getProject`, `listProjects`, `deleteProject` |
| `types.ts` | Project/config domain shapes and name validation regexes. | `A2aProject`, `A2aLocalConfig` |
| `hub/` | HTTP/WebSocket clients and Hub implementation. | [`hub/codemap.md`](hub/codemap.md) |

## Extension lifecycle

`a2aExtension(pi)` owns the active OMP `ExtensionContext`, an explicit Session generation and AbortController, the desired `{ hubUrl, client?, project, name }` target, and one bounded exponential reconnect timer from 500 ms to 10 seconds. `A2aRuntime`, not the Extension, owns connection transitions and published connection lifetime.

On `session_start` and `session_switch`, the extension:

1. increments the Session generation, aborts the prior Session controller, and synchronously clears the active context, desired target, and reconnect timer so obsolete work cannot occupy the new Session;
2. cancels and awaits the published Presence or pending handshake;
3. activates the new context and resolves its repository-local configuration only if no newer Session transition superseded it;
4. captures the selected Hub URL in the desired target and auto-connects only when configuration exists and `autoConnect !== false`.

On `session_shutdown`, it increments the Session generation, aborts the Session controller, synchronously clears the active context and desired target, cancels reconnect, and disconnects the Runtime. Slash history and model attachment work combine caller, Session, and published-connection cancellation; stale slash history cannot notify a retired Session. Unexpected close of the published socket reconnects only the current desired target using its captured accepting Hub client. A `name_in_use` candidate is terminal for that failed target; when an older connection remains published, its `{ hubUrl, client, project, name }` becomes the reconnect intent. Project administration continues to use the currently selected client.

### Inbound events

- Only events from the currently published connection reach the Extension; candidate and retired connection events are discarded.
- `presence_joined` and `presence_left` update the UI only.
- `delivery` reports the selected peer name and `delivered`/`failed`/`disconnected` outcome.
- `message` callbacks run serially in Hub-assigned Project sequence. Each callback captures the Session generation and the Runtime-owned published-connection token, combines both lifecycle signals through attachment materialization, then verifies generation and token before injecting an `a2a-inbound` OMP custom message through `steer`. Session changes, connection replacement, disconnect, or current socket close cancel injection and dispose every uncommitted attachment directory, including materialization that already returned. Idle sessions start a turn and busy sessions queue the Message into the active turn. Candidate and retired sockets fail delivery rather than acknowledging an injection that never happened.
- socket/protocol errors from the published connection are written to the extension logger.

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

`A2aRuntime` is the sole owner of published connection state. A published value binds one `A2aConnection`, the `HubClient` that admitted it, and a Runtime-owned message-lifecycle `AbortController`.

- `connect(project, name, client?)` starts a cancellable candidate while preserving the published value. Every connect waits the shared teardown barrier from any earlier connect or disconnect before resolving a client or opening another socket, so reverse overlap cannot reclaim a still-owned name. It aborts and awaits any superseded candidate's complete teardown. Only the latest transition may publish; candidate success atomically replaces the binding before retiring its predecessor, while candidate failure leaves the predecessor and its lifecycle signal unchanged. An identical target is reused only when the accepting Hub URL also matches.
- Candidate and retired connections cannot forward Presence, message, Delivery, close, or error events. A Message arriving there reports failed delivery rather than returning normally, and a candidate closed during predecessor cleanup cannot report success.
- `disconnect()` is idempotent, supersedes pending connect work, aborts the published message lifecycle, clears the binding, and publishes one teardown barrier until candidate and socket closure complete.
- Replacing a published connection or closing its current socket aborts the connection token passed to asynchronous inbound and outbound work; the Runtime exposes identity checks for final injection and send fences.
- `peers()` uses the published WebSocket. `message()` can require the initiating published-connection token so a slow attachment snapshot cannot send through a replacement.
- `history()` and connected `status()` use the bound `HubClient`; Project create/list/delete and disconnected status use the currently selected client.

`A2aConnection.connect` accepts a caller `AbortSignal` for an unpublished handshake and terminates that socket when cancelled. Established message/history requests retain their existing lifecycle behavior.

Attachment snapshot and materialization accept combined caller, Session, and published-connection `AbortSignal`s. Stable reads check cancellation around each non-cancellable file operation. Materialization returns explicit disposable/commit ownership: cancellation, a final fence failure, injection failure, or a failed history sibling removes every uncommitted output directory, while only a successful caller commits the returned URLs.

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

- `extension.test.ts`: registered surfaces, help contract, ArkType schemas, multi-level completion, attachment snapshot/materialization/history ownership, Session/Project-switch cancellation, outbound send fencing, stale UI suppression, and reconnect intent.
- `operations.test.ts`: published Hub bindings, shared connect/disconnect teardown ownership, message lifecycle signals, snapshots, ordered injection, Delivery outcomes, and disconnected errors.
- `config.test.ts`: strict configuration parsing and migration failures.
- `hub-control.test.ts`: public Project control behavior reached through `HubClient`.

See the repository root `codemap.md` for deployment and verification contracts.
