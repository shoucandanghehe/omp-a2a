# Source Atlas

## Responsibility

`src/` contains the OMP-facing extension, its runtime module, strict local configuration, Project domain names, Hub storage paths, and the `src/hub/` transport/persistence modules.

The central seam is `A2aRuntime`: extension callbacks and commands depend on one stateful interface rather than coordinating HTTP and WebSocket clients independently.

## Module map

| File | Responsibility | Primary interface |
| --- | --- | --- |
| `extension.ts` | OMP registration, session lifecycle, UI notifications, reconnect policy, slash commands, completions, and model tools. | default extension factory |
| `local-attachments.ts` | Cancellable snapshot of uncapped sender-session `local://` file bytes and leak-free materialization of validated attachment basenames into the calling session. | `snapshotLocalAttachments`, `materializeLocalAttachments` |
| `operations.ts` | Connected runtime over one WebSocket plus HTTP Project/history operations. | `A2aRuntime`, `MessageView`, `RuntimeStatus` |
| `config.ts` | Strict repository-local YAML/JSON connection defaults. | `loadLocalConfig` |
| `config-document.ts` | Read YAML/JSON documents, apply an owner-supplied omptype schema, and report path-qualified errors. | `parseWithSchema` |
| `paths.ts` | Hub SQLite storage, data-lock, and local config candidate paths. | path functions |
| `types.ts` | Project/config domain shapes and name validation regexes. | `A2aProject`, `A2aLocalConfig` |
| `hub/` | HTTP/WebSocket clients plus the Hub's canonical Project/message store. | [`hub/codemap.md`](hub/codemap.md) |

## Extension lifecycle

`a2aExtension(pi)` owns the active OMP `ExtensionContext`, one Session lifecycle `AbortController`, one explicit `unloaded | invalid | ready` configuration state, the desired `{ hubUrl, client?, project, name }` reconnect target, and one bounded exponential reconnect timer from 500 ms to 10 seconds. `A2aRuntime`, not the Extension, owns connection transitions and published connection lifetime.

On `session_start` and `session_switch`, the extension:

1. replaces and aborts the prior Session lifecycle controller, then synchronously clears the active context, cached Hub selection, desired target, and reconnect timer;
2. cancels and awaits the published Presence or pending handshake;
3. activates the new context and loads its strict repository-local configuration only if that lifecycle is still current;
4. reports invalid or missing Hub configuration and preserves that error so Hub and Project operations cannot use a prior client;
5. captures the selected Hub URL in the desired target and auto-connects only when configuration is valid, present, and `autoConnect !== false`.

Commands reload the current Session configuration. A valid local `hubUrl` wins; otherwise the global config is required. An invalid reload publishes fail-closed state, cancels reconnect intent, and closes the current Presence before reporting its path-qualified error. `disconnect` and `help` remain available without reparsing configuration.

On `session_shutdown`, the extension aborts Session work, clears active and reconnect state, and disconnects the Runtime. Slash history and model attachment work combine caller, Session, and published-connection cancellation; stale work cannot inject, send, or notify a retired Session. Graceful close releases Presence before acknowledging `goodbye`, then bounds WebSocket teardown. Unexpected close reconnects only the current desired target using its captured accepting Hub client. A `name_in_use` candidate is terminal for that target; an older published connection becomes the reconnect intent.

### Inbound events

- Only events from the currently published connection reach the Extension; candidate and retired connection events are discarded.
- Successful publication, manual disconnect, invalid-config teardown, and unexpected close publish hidden `a2a-connection` state without changing the model's fixed system-prompt prefix. Idle transitions coalesce to the latest state for the next turn or inbound Message; busy transitions use `steer`. A simultaneous idle connection update and Presence delta become one ordered `a2a-context` message.
- `presence_joined` and `presence_left` always update the UI. Busy sessions receive each change as a hidden-display `a2a-presence` custom message through `steer`. Idle changes are collapsed into at most one joined/left roster delta between the last terminal `agent_end` snapshot and the current Presence; net-zero churn is discarded, and the delta is injected before the next inbound Message or returned by `before_agent_start` for the next model turn.
- `delivery` reports the selected peer name and terminal `delivered` or `failed` outcome; failures include an explicit receiver error or an unconfirmed write, disconnect, or ACK-timeout reason.
- Distinct Messages run serially in Hub-assigned Project sequence. Each callback captures the Session lifecycle token and Runtime-owned published-connection token, carries both through attachment materialization, then verifies both before injecting an `a2a-inbound` OMP custom message through `steer`. Idle sessions start a turn and busy sessions queue the Message into the active turn. Session changes, connection replacement, disconnect, or socket close cancel injection and dispose every uncommitted attachment directory. Candidate and retired sockets fail delivery rather than acknowledging work that never reached the current Session.
- Socket/protocol errors from the published connection are written to the extension logger.

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
| `a2a_message` | Requires a typed direct or Project target and text; accepts optional current-session `local://` attachment sources, `replyTo`, `messageId`, and an interactive per-Message user-signature request. Forked OMP uses its local-only, scrollable `localAskDialog`; original OMP falls back to host-local `confirm`/`input` without a message-size limit. Collaboration guests cannot approve either path. Approval creates an Extension-owned receipt before sending; rejection returns the user's optional reason without sending and suppresses identical repeat prompts for the Session. The tool forwards combined cancellation, fences the initiating connection, distinguishes new acceptance from replay, and keeps reply handling push-driven. |
| `a2a_history` | Accepts `before`, `after`, `limit`, and `from`; rematerializes persisted attachments into the calling session; it is only for deliberate review of persisted context, never waiting for a new reply. |

Every model turn receives byte-identical A2A system-prompt additions containing the exact `xd://` tool addresses, active-connection requirement, addressing rules, and collaboration boundary; connection status, Project, and roster name never change that prefix. The Extension instead appends hidden `a2a-connection` context messages and treats the latest as the operational state. No peer, including the receiver, is another's supervisor, subordinate, or final authority. Peer messages and the receiver's own prior conclusion are evaluated from evidence, repository constraints, and the user's established goals rather than privileged, obeyed, dismissed, accepted, or rejected by source. Peers cannot override or speak for the user; material conflicts, unresolved peer disagreements, and conflicting peer-reported changes to user direction go neutrally to the user, who is always the final arbiter. There is no model-side connect/disconnect or Project administration. Replies arrive automatically; after sending, the model continues independent work or ends its turn instead of waiting or polling history.

Only an Extension-injected structured metadata field with `userApproval: "confirmed"` represents explicit user approval. It binds the exact immutable Message and addressed recipient, does not propagate or override direct user instructions, and is preserved in realtime delivery and history. Peer text is JSON-escaped so unsigned content cannot manufacture a second confirmed record.

## Runtime interface

`A2aRuntime` is the sole owner of published connection state. A published value binds one `A2aConnection`, the `HubClient` that admitted it, and a Runtime-owned message-lifecycle `AbortController`.

- `connect(project, name, client?)` starts a cancellable candidate while preserving the published value. Every connect waits the shared teardown barrier, aborts and awaits superseded candidates, and publishes only the latest successful transition. Candidate failure leaves the predecessor and its lifecycle signal unchanged; an identical target is reused only when its accepting Hub URL also matches. The underlying handshake has a 5-second default deadline, and the first timeout, protocol, transport, cancellation, or successful-claim outcome remains authoritative through teardown.
- Candidate and retired connections cannot forward Presence, Message, Delivery, close, or error events. A Message arriving there reports failed delivery rather than acknowledging work that never reached the published connection.
- `disconnect()` is idempotent, supersedes pending connect work, aborts the published message lifecycle, clears the binding, and publishes one teardown barrier until candidate and socket closure complete. Concurrent close callers share one bounded goodbye/close Promise.
- Replacing or closing a published connection aborts the token used to fence asynchronous inbound and outbound work.
- `peers()` uses the published WebSocket. `message()` can require its initiating connection token, forwards caller cancellation, and returns a strong new/replayed acceptance union. Pre-dispatch abort sends nothing; abort, timeout, or close after dispatch reports an unknown acceptance outcome without caller retry.
- `history()` and connected `status()` use the bound `HubClient` and accept caller cancellation; Project create/list/delete and disconnected status use the currently selected client. Status reports the selected `HubClient.baseUrl`; metadata supplies only protocol compatibility and never replaces that URL.
- Project create/list/delete are thin HTTP operations and do not require a Presence.

Attachment snapshot and materialization combine caller, Session, and published-connection signals. Materialization returns explicit disposable/commit ownership so cancellation, a final fence failure, injection failure, or a failed history sibling removes every uncommitted output directory.

`MessageView` is the persistent realtime Message shape with decoded text and attachment bytes replacing encoded wire payloads. Matching private-protocol clients are trusted; codecs fail loudly on malformed data and do not enforce application resource caps.

## Configuration contract

`config-document.ts` delegates YAML syntax to Bun `YAML.parse` and JSON syntax to `JSON.parse`, applies an owner-supplied `@oh-my-pi/omptype` schema, and turns `OmpErrors` into path-qualified configuration errors. It assigns no schema itself.

`loadLocalConfig(cwd)` selects the first existing file in this order:

1. `.omp/a2a.yml`
2. `.omp/a2a.yaml`
3. `.omp/a2a.json`

The selected file is authoritative: read, syntax, and schema failures include its path and never fall through to a later candidate. The local omptype schema requires `project` and `name`, permits optional `hubUrl`, defaults `autoConnect` to enabled, trims strings, rejects blanks, narrows Project/name values through their regexes, and uses `"+": "reject"` for every undeclared field. Removed `agentId`/`agent_id` and `autoJoin`/`auto_join` error paths are rendered as explicit migration errors rather than aliases.

Global client configuration uses the same authoritative candidate order under `~/.omp/a2a/`. Its owner schema trims and requires one nonblank string `hubUrl` and uses `"+": "reject"`; the former `hub_url`/`url` aliases therefore fail as undeclared fields.

## Project metadata

`hub/store.ts` is the sole owner of persistent Project metadata. The same `<dataDir>/messages.sqlite` database owns Project rows, per-Project sequence, and immutable Messages. Project deletion uses one `BEGIN IMMEDIATE` transaction to remove history, sequence, and metadata; no filesystem CRUD, dual write, deletion marker, or reconciliation path exists.

`server.ts` and `realtime-server.ts` query the same synchronous `HubStore` fact. Because Presence claim and Project deletion perform their store checks without yielding the Node event loop, a claim that wins first makes deletion reject on active Presence, while a deletion that wins first makes claim reject the unknown Project.

## Naming contract

- Project: starts alphanumeric, then `[a-zA-Z0-9._-]`, maximum 64 characters.
- Agent name: starts with a Unicode letter or number, then Unicode letters, numbers, marks, or `._-`, maximum 32 characters.

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

- `extension.test.ts`: registered surfaces, strict invalid-configuration isolation, help and ArkType contracts, multi-level completion, Presence notifications, attachment ownership, Session/Project-switch cancellation, outbound send fencing, stale UI suppression, and reconnect intent.
- `local-attachments.test.ts`: materialization rejects unsafe or duplicate attachment names before writing files.
- `operations.test.ts`: published Hub bindings, shared transition teardown, peer snapshots, HTTP and realtime cancellation, new/replayed acceptance, ordered injection, Delivery outcomes, and disconnected-state errors.
- `config.test.ts`: strict configuration parsing and migration failures.
- `hub-client.test.ts`: strict global configuration parsing, exact fields, authoritative candidate selection, HTTP cancellation, and wire validation.
- `hub-control.test.ts`: public Project control, active-Presence deletion ordering, storage startup guards, cleanup, and concurrent stop behavior.
- `message-store.test.ts`: Project SQLite CRUD/reopen/sorting, transaction rollback, sequence/history behavior, idempotency, current schema creation/reopen, and fail-closed schema guards.

See the repository root `codemap.md` for deployment and verification contracts.
