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
| `paths.ts` | Hub storage paths and local config candidates. | path functions |
| `registry.ts` | Filesystem-backed persistent Project metadata. | `createProject`, `getProject`, `listProjects`, `deleteProject` |
| `types.ts` | Project/config domain shapes and name validation regexes. | `A2aProject`, `A2aLocalConfig` |
| `hub/` | HTTP/WebSocket clients and Hub implementation. | [`hub/codemap.md`](hub/codemap.md) |

## Extension lifecycle

`a2aExtension(pi)` owns one session-local `A2aRuntime` and the following state:

- cached `HubClient`, invalidated when the resolved Hub URL changes;
- active OMP `ExtensionContext` for message injection and notifications;
- desired `{ project, name }` used by reconnect;
- one bounded exponential reconnect timer, from 500 ms to 10 seconds.

On `session_start` and `session_switch`, the extension:

1. clears the active context so in-flight inbound callbacks cannot inject into the new session;
2. cancels pending reconnect and disconnects the old Presence;
3. activates the new context and resolves its repository-local configuration;
4. clears prior desired connection state and auto-connects only when configuration exists and `autoConnect !== false`.

On `session_shutdown`, it clears the active context and desired state, cancels reconnect, and performs the shared graceful close. The close sends one exact `goodbye`, waits at most 1 second for its acknowledgement, starts the WebSocket close, and terminates after at most another 2 seconds if needed. The Hub releases Presence before completing its separately bounded transport teardown. Unexpected socket close schedules reconnect. A `name_in_use` response is terminal for that desired connection rather than repeatedly displacing or retrying the owner.

### Inbound events

- `presence_joined` and `presence_left` update the UI only.
- `delivery` reports the selected peer name and terminal `delivered`/`failed`/`disconnected`/`unknown` outcome; failures and unknown outcomes include their error.
- duplicate `message` frames for one `messageId` share one in-flight callback or a 10-second terminal outcome cache, so the callback runs once while each retry receives the same result. One earliest-expiry timer prunes completed outcomes in order while idle and is cancelled with the cache on socket close. Distinct Messages still run serially in Hub-assigned Project sequence. Each callback captures the active session, materializes attachment bytes, then verifies that the session is still active before injecting an `a2a-inbound` OMP custom message through `steer`; session changes cancel the injection. Idle sessions start a turn and busy sessions queue the Message into the active turn. Materialization or injection failure produces terminal `delivery_failed`.
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
| `a2a_message` | Requires a typed direct or Project target and text; accepts optional current-session `local://` attachment sources, `replyTo`, and `messageId`; forwards the model-call abort signal only to the WebSocket acceptance request; distinguishes a new acceptance with recipients from `replayed: true` without recipients or redelivery; every result states the push-driven reply control flow. |
| `a2a_history` | Accepts `before`, `after`, `limit`, and `from`; rematerializes persisted attachments into the calling session; it is only for deliberate review of persisted context, never waiting for a new reply. |

Connected model turns receive the current A2A roster name and use only `a2a_peers` results or inbound sender names to address peers; disconnected turns receive no A2A identity prompt. There is no model-side connect/disconnect or Project administration. Replies arrive automatically; after sending, the model continues independent work or ends its turn instead of waiting or polling history.

## Runtime interface

`A2aRuntime` owns at most one `A2aConnection`.

- `connect(project, name)` cleanly closes any old connection, obtains the current Hub client, and returns self plus peer snapshot after the WebSocket claim. The underlying handshake has a 5-second default deadline and supports caller cancellation at the `A2aConnection` seam. Whichever timeout, protocol, transport, cancellation, or successful claim outcome settles first remains authoritative through teardown.
- `disconnect()` is idempotent and clears the stored connection before awaiting close; the underlying `A2aConnection.close()` shares one goodbye/close Promise across concurrent callers.
- `peers()` returns the current client-side Presence map.
- `message()` requires a live connection, sends through it, forwards an optional caller signal, and decodes a strong accepted-result union: a new acceptance has `replayed: false` plus recipients, while a prior acceptance has `replayed: true` and no recipient field. The request has a 15-second default deadline; pre-dispatch abort sends nothing, while abort/timeout/close after dispatch reports unknown acceptance and Delivery outcomes without caller retry.
- `history()` requires a connected Project but uses HTTP through the current Hub client and does not receive the message caller signal.
- `status()` combines Hub metadata with connected Presence state.
- Project create/list/delete are thin HTTP operations and do not require a Presence.

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

- `extension.test.ts`: registered surfaces, help contract, ArkType schemas, multi-level completion, and cross-session attachment snapshot/materialization/history.
- `operations.test.ts`: runtime connect, peer lists, message cancellation before dispatch, new versus replayed acceptance, successful/failed Delivery callbacks, and disconnected errors.
- `config.test.ts`: strict configuration parsing and migration failures.
- `hub-control.test.ts`: public Project control behavior reached through `HubClient`.

See the repository root `codemap.md` for deployment and verification contracts.
