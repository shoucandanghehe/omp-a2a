# Repository Atlas: omp-a2a

## Project responsibility

`omp-a2a` provides anonymous realtime Agent chat between independent Oh My Pi (OMP) processes. A standalone Hub owns persistent Projects and message history, current WebSocket Presence, and realtime routing. The OMP extension is a pure client.

The wire protocol is private version `3`. It is not the standard A2A protocol, requires matching Hub and extension versions, and assumes a fully trusted private network.

## System entry points

- `src/extension.ts`: OMP extension registered by `package.json`; owns session activation, reconnect policy, `/a2a`, and the three model tools.
- `src/hub/cli.ts`: `omp-a2a-hub` and `bun run hub` process entry; parses explicit Hub options and owns signal shutdown.
- `src/hub/server.ts`: Express HTTP control/history surface and the HTTP server lifecycle used by the WebSocket Hub.
- `src/hub/realtime-server.ts`: WebSocket Presence, realtime routing, delivery outcomes, heartbeat, and shutdown.
- `src/operations.ts`: `A2aRuntime`, the extension-facing module over HTTP and WebSocket clients.
- `scripts/smoke.ts`: persistent SQLite Project-store smoke.
- `scripts/smoke-hub.ts`: in-process HTTP/WebSocket/persistence smoke.
- `scripts/smoke-docker.ts`: public boundary smoke against an already-running Hub.

## Architecture

```text
OMP session
  ├─ human /a2a commands
  └─ model a2a_peers / a2a_message / a2a_history
                 │
                 ▼
             A2aRuntime
       ┌─────────┴─────────┐
       │ HTTP              │ WebSocket
       │ Projects/history  │ Presence/messages/delivery
       ▼                   ▼
              standalone Hub
       ┌───────────────┴───────────────┐
       │                               │
    in-memory                       SQLite
    Presence              Project metadata + message history
```

### Control and history plane

`HubClient` uses bounded, caller-cancellable HTTP requests for Hub metadata, Project create/list/delete, and explicit history queries. It validates successful wire responses before exposing them to the runtime and never retries automatically. Project metadata, per-Project sequence, and Messages share `<dataDir>/messages.sqlite`. Deletion is rejected while a Project has an active Presence, then removes all three durable facts in one SQLite transaction.

### Realtime plane

1. `A2aConnection` opens `/v1/connect`, sends a versioned `hello`, and waits at most 5 seconds (or until caller cancellation) for the claim. The first handshake outcome remains authoritative while the failed socket is torn down.
2. `RealtimeHub` verifies the Project and atomically claims the name in `PresenceRegistry`.
3. The client receives its `presenceId` and the current peer snapshot; current peers receive `presence_joined`.
4. A direct request checks idempotency, resolves one current Presence, then persists. A Project broadcast persists first and, only for a new acceptance, enumerates current Project Presence once into a local array.
5. `HubStore` verifies the Project and atomically appends one immutable Message—including encoded attachment content—while assigning the next Project sequence; an identical existing `messageId` returns `replayed`.
6. The Hub synchronously enqueues the Message to the selected concrete sockets and keeps one bounded in-memory retry record per `(messageId, recipientPresenceId)`.
7. Each receiver coalesces duplicate frames, materializes attachments, injects the Message once into OMP, then reports or re-reports `delivered` or `delivery_failed`.
8. The sender receives one terminal in-memory `delivered`, `failed`, `disconnected`, or `unknown` outcome per selected Presence.
9. Graceful disconnect releases Presence and Delivery state, broadcasts `presence_left`, then acknowledges exact `goodbye` and bounds transport close/termination. Transport close and heartbeat timeout use the same idempotent release path.

A message acceptance request waits at most 15 seconds and accepts caller cancellation. Cancellation before dispatch sends nothing. Abort, timeout, or close after WebSocket dispatch reports that acceptance and Delivery outcomes are unknown, removes the client request, ignores late replies, and never retries.

A same-named later connection is a new Presence and never inherits pending Delivery. Transport write errors and missing ACKs retry the same Message only on the original socket while it still owns the original Presence, for at most three attempts in one Hub process; retry overrides may shorten, never extend, that protocol window. Receiver outcomes use one ordered earliest-expiry timer for their 10-second idle-cleaned cache. Receiver outcomes, either Presence leaving, and Hub shutdown cancel retry timers. Restart retains history but never resumes delivery.

### Persistent store contract

- `HubStore` is the single canonical owner of persistent Project metadata, Project sequence, and Messages.
- Message references are `<project>:<sequence>` and sequence is monotonic per Project.
- `messageId` is the persistent idempotency key; conflicting reuse fails and identical reuse returns the canonical Message as `replayed` without Presence enumeration or redelivery.
- `replyTo` must resolve inside the same Project.
- Direct messages are bound to the resolved `presenceId`; Project broadcasts persist before one local Presence enumeration and never persist their recipient array.
- History is append-only until Project deletion. Presence, recipient arrays, retry trackers, and delivery events are not persisted.
- Attachments are ordered immutable values inside a Message. Their names and bytes participate in `messageId` idempotency; they share the Message lifecycle.
- `messages.sqlite` has an independent storage version. Startup accepts only the exact current version and complete set of current non-internal schema objects; unsupported storage fails closed.

### Payload contract

Text smaller than 32 KiB remains identity encoded. Larger text uses gzip plus Base64. Attachment bytes use Base64 and use gzip when smaller. Encoding and decoding enforce a 4 MiB total decoded-content limit across text and at most eight attachments, including bounded decompression.

## Configuration and deployment

Hub URL precedence is:

1. repository-local `.omp/a2a.yml`, `.yaml`, or `.json` through `hubUrl`;
2. `OMP_A2A_HUB_URL`;
3. global `~/.omp/a2a/config.yml`, `.yaml`, or `.json`;
4. `http://127.0.0.1:4173`.

The resolved URL is authoritative for HTTP and WebSocket connections; Hub metadata validates protocol compatibility without replacing the route.

Repository-local connection defaults require `project` and `name`; `autoConnect` defaults to enabled. Removed `agentId` and `autoJoin` fields fail with an explicit migration error.

If a command reload finds the repository-local configuration invalid, the Extension closes the current Presence, clears reconnect intent, and blocks fallback Hub access until a successful reload or Session switch.

The Hub runs locally with `bun run hub` or in Docker Compose. Each Hub needs a unique URL and data directory. `HubDataLock` rejects concurrent ownership of one directory. The shared SQLite Hub store uses WAL with `synchronous = FULL`; new storage writes the complete current schema and version atomically, while mismatches fail closed.

## User surfaces

### Human commands

`/a2a` provides Hub status, Project create/list/delete, connect/disconnect, current status, peer listing, and explicit history. Its synchronous completion tree covers root commands, Project subcommands, `connect --as`, and compatible history flags.

### Model tools

- `a2a_peers`: current Presence names in the connected Project.
- `a2a_message`: direct message, Project broadcast, or causal reply, with optional current-session `local://` attachment sources; successful sends direct the model to continue independent work or end its turn.
- `a2a_history`: deliberate lookup of already-persisted context, never a reply-waiting primitive.

Connected model turns receive the current A2A roster name and use only `a2a_peers` results or inbound sender names to address peers; disconnected turns receive no A2A identity prompt.

Inbound messages are pushed through OMP `sendMessage` in Hub-assigned Project sequence using `steer` delivery: idle sessions start a turn and busy sessions queue the Message into the active turn. Injection rechecks the published connection token and Session generation after cancellable attachment materialization; stale work reports failed delivery. Models never wait, sleep, or poll history for replies.
The sender Extension snapshots attachment bytes before sending and fences the final send to the initiating Session and published connection. Receivers and history callers materialize new URLs in their own session-local storage; caller cancellation or Session/connection shutdown stops attachment I/O and removes every uncommitted output directory, including completed siblings of a failed batch. The Hub never resolves `local://`.

## Root asset map

| Asset | Responsibility |
| --- | --- |
| `package.json` | Bun metadata, OMP extension registration, Hub executable, and smoke scripts. |
| `bun.lock` | Locked dependency graph. |
| `AGENTS.md` | Repository map, commit-message style, signing, and history-rewrite rules. |
| `README.md` | Operator and user how-to plus public behavior contract. |
| `config.example.yml` | Global Hub URL example. |
| `.env.example` | Docker Compose environment defaults. |
| `Dockerfile` | Unprivileged standalone Hub image. |
| `docker-compose.yml` | Hub process, health check, published port, and persistent volume. |

## Directory map

| Directory | Responsibility | Detailed map |
| --- | --- | --- |
| `src/` | OMP adapter, runtime, configuration, Project domain names, and Hub storage paths. | [`src/codemap.md`](src/codemap.md) |
| `src/hub/` | HTTP/WebSocket protocol, Presence, routing, canonical SQLite persistence, payloads, locking, and process lifecycle. | [`src/hub/codemap.md`](src/hub/codemap.md) |
| `scripts/` | Executable SQLite-store, Hub, and Docker smoke scenarios. | [`scripts/codemap.md`](scripts/codemap.md) |
| `tests/` | Bun behavior tests for configuration, payloads, message history, realtime routing, control routes, runtime, and extension registration/completion. | Tests are excluded from generated map state. |
| `docs/` | Implemented architecture decisions and historical fixed-snapshot review material. | Documentation is excluded from generated map state. |

## Verification

The local release gate runs Biome, `bun run smoke`, both Bun entry-point builds, and `docker compose config`. It covers SQLite Project CRUD/reopen/sorting and atomic deletion, current storage creation/reopen and fail-closed schema guards, bounded WebSocket lifecycles, caller cancellation, Presence routing, replay and retries, receiver deduplication, terminal Delivery cleanup, attachment ownership and history, payload limits, Hub restart/cleanup, extension lifecycle, and command completion.

`bun run smoke:docker` crosses the public HTTP/WebSocket process boundary of the selected running Hub, verifies persisted history, and removes its temporary Project.

The implemented realtime model is documented in [`docs/realtime-presence-architecture.md`](docs/realtime-presence-architecture.md). The dated review in `docs/code-review-2026-07-19.md` is archival and does not define the current contract.

## Operational boundaries

- No authentication, authorization, tenant isolation, or confidentiality guarantee exists.
- Established WebSockets do not move when `hubUrl` changes; disconnect and reconnect.
- Ordinary Hub metadata, Project, and history HTTP calls have a 15-second default deadline; caller cancellation covers headers and response-body reading.
- The default Compose port publication binds all host interfaces unless the operator narrows it.
