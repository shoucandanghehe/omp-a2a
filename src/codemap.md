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
| `config-document.ts` | Read YAML/JSON documents, apply an owner-supplied omptype schema, and report path-qualified errors. | `parseWithSchema` |
| `paths.ts` | Hub storage paths and local config candidates. | path functions |
| `registry.ts` | Filesystem-backed persistent Project metadata. | `createProject`, `getProject`, `listProjects`, `deleteProject` |
| `types.ts` | Project/config domain shapes and name validation regexes. | `A2aProject`, `A2aLocalConfig` |
| `hub/` | HTTP/WebSocket clients and Hub implementation. | [`hub/codemap.md`](hub/codemap.md) |

## Extension lifecycle

`a2aExtension(pi)` owns one session-local `A2aRuntime` and the following state:

- cached `HubClient`, invalidated when the resolved Hub URL changes or a Session activates;
- active local Hub URL selection plus a persistent invalid-config error distinct from absent configuration;
- active OMP `ExtensionContext` for message injection and notifications;
- desired `{ project, name }` used by reconnect;
- one bounded exponential reconnect timer, from 500 ms to 10 seconds.

On `session_start` and `session_switch`, the extension:

1. clears the active context, cached Hub selection/client, and desired connection so no state crosses into the new Session;
2. cancels pending reconnect and disconnects the old Presence;
3. activates the new context and loads its repository-local configuration;
4. reports invalid configuration to the UI and preserves that error so Hub and Project operations cannot fall back to environment, global, default, or a prior client;
5. auto-connects only when configuration is valid, present, and `autoConnect !== false`.

Commands reload the current Session configuration. A successful reload clears the invalid state; an absent configuration or a valid configuration without `hubUrl` retains environment → global → default Hub URL resolution. An invalid reload atomically publishes fail-closed config state, cancels reconnect intent, and closes the current Presence before reporting the path-qualified error. The local `disconnect` command remains available without reparsing invalid configuration.

On `session_shutdown`, it clears the active context and desired state, cancels reconnect, and closes the socket. Unexpected socket close schedules reconnect. A `name_in_use` response is terminal for that desired connection rather than repeatedly displacing or retrying the owner.

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

`A2aRuntime` owns at most one `A2aConnection`.

- `connect(project, name)` cleanly closes any old connection, obtains the current Hub client, and returns self plus peer snapshot.
- `disconnect()` is idempotent and clears the stored connection before awaiting close.
- `peers()` returns the current client-side Presence map.
- `message()` requires a live connection, sends through it, and decodes the accepted persistent message for callers.
- `history()` requires a connected Project but uses caller-cancellable HTTP through the current Hub client.
- `status()` combines Hub metadata with connected Presence state and accepts HTTP request options.
- Project create/list/delete are thin HTTP operations, accept HTTP request options, and do not require a Presence.

`MessageView` is the persistent realtime Message shape with decoded text and attachment bytes replacing encoded wire payloads.

## Configuration contract

`config-document.ts` delegates YAML syntax to Bun `YAML.parse` and JSON syntax to `JSON.parse`, applies an owner-supplied `@oh-my-pi/omptype` schema, and turns `OmpErrors` into path-qualified configuration errors. It assigns no schema itself.

`loadLocalConfig(cwd)` selects the first existing file in this order:

1. `.omp/a2a.yml`
2. `.omp/a2a.yaml`
3. `.omp/a2a.json`

The selected file is authoritative: read, syntax, and schema failures include its path and never fall through to a later candidate. The local omptype schema requires `project` and `name`, permits optional `hubUrl`, defaults `autoConnect` to enabled, trims strings, rejects blanks, narrows Project/name values through their regexes, and uses `"+": "reject"` for every undeclared field. Removed `agentId`/`agent_id` and `autoJoin`/`auto_join` error paths are rendered as explicit migration errors rather than aliases.

Global client configuration uses the same authoritative candidate order under `~/.omp/a2a/`. Its owner schema trims and requires one nonblank string `hubUrl` and uses `"+": "reject"`; the former `hub_url`/`url` aliases therefore fail as undeclared fields.

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

- `extension.test.ts`: registered surfaces, invalid Session configuration isolation and live-Presence fail-closed reloads, completion, and cross-session attachment snapshot/materialization/history.
- `operations.test.ts`: runtime connect, snapshots, message and successful/failed Delivery callbacks, and disconnected errors.
- `config.test.ts`: strict configuration parsing and migration failures.
- `hub-client.test.ts`: strict global configuration parsing, exact fields, and authoritative candidate selection.
- `hub-control.test.ts`: public Project control behavior reached through `HubClient`.

See the repository root `codemap.md` for deployment and verification contracts.
