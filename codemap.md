# Repository Atlas: omp-a2a

## Project responsibility

`omp-a2a` provides anonymous realtime Agent chat between independent Oh My Pi (OMP) processes. A standalone Hub owns persistent Projects and message history, current WebSocket Presence, and realtime routing. The OMP extension is a pure client.

The wire protocol is private to this repository. It is not the standard A2A protocol and assumes a fully trusted private network.

## System entry points

- `src/extension.ts`: OMP extension registered by `package.json`; owns session activation, reconnect policy, `/a2a`, and the three model tools.
- `src/hub/cli.ts`: `omp-a2a-hub` and `bun run hub` process entry; parses explicit Hub options and owns signal shutdown.
- `src/hub/server.ts`: Express HTTP control/history surface and the HTTP server lifecycle used by the WebSocket Hub.
- `src/hub/realtime-server.ts`: WebSocket Presence, realtime routing, delivery outcomes, heartbeat, and shutdown.
- `src/operations.ts`: `A2aRuntime`, the extension-facing module over HTTP and WebSocket clients.
- `scripts/smoke.ts`: persistent Project Registry smoke.
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
       ┌─────────┼──────────────┐
       │         │              │
 filesystem   in-memory      SQLite
 Projects     Presence        append-only
 metadata     registry        message history
```

### Control and history plane

`HubClient` uses HTTP for Hub metadata, Project create/list/delete, and explicit history queries. Project metadata lives under `<dataDir>/projects/<name>/project.json`. Deletion is rejected while a Project has an active Presence, then removes Project metadata and its message history.

### Realtime plane

1. `A2aConnection` opens `/v1/connect` and sends a versioned `hello` with Project and name.
2. `RealtimeHub` verifies the Project and atomically claims the name in `PresenceRegistry`.
3. The client receives its `presenceId` and the current peer snapshot; current peers receive `presence_joined`.
4. A message request resolves either one current Presence or the current Project Presence snapshot.
5. `MessageStore` appends one immutable message and assigns the next Project sequence.
6. The Hub pushes the message to the selected sockets. The receiver reports successful OMP injection with `delivered`.
7. The sender receives one in-memory `delivered` or `disconnected` outcome per selected Presence.
8. Socket close or heartbeat timeout deletes the Presence and broadcasts `presence_left`.

A same-named later connection is a new Presence and never inherits pending delivery. History is never replayed automatically.

### Persistent message contract

- Message references are `<project>:<sequence>` and sequence is monotonic per Project.
- `messageId` is the persistent idempotency key; conflicting reuse fails.
- `replyTo` must resolve inside the same Project.
- Direct messages are bound to the resolved `presenceId`; Project broadcasts freeze their recipient snapshot at acceptance.
- History is append-only until Project deletion. Presence and delivery events are not persisted.
- Legacy `inbox.sqlite` message-ledger rows migrate once into `messages.sqlite`; old membership, cursor, ACK, receipt, and offline-delivery semantics do not migrate.

### Payload contract

Text smaller than 32 KiB remains identity encoded. Larger text uses gzip plus Base64. Encoding and decoding enforce a 4 MiB uncompressed limit, including bounded decompression.

## Configuration and deployment

Hub URL precedence is:

1. repository-local `.omp/a2a.yml`, `.yaml`, or `.json` through `hubUrl`;
2. `OMP_A2A_HUB_URL`;
3. global `~/.omp/a2a/config.yml`, `.yaml`, or `.json`;
4. `http://127.0.0.1:4173`.

Repository-local connection defaults require `project` and `name`; `autoConnect` defaults to enabled. Removed `agentId` and `autoJoin` fields fail with an explicit migration error.

The Hub runs locally with `bun run hub` or in Docker Compose. Each Hub needs a unique URL and data directory. `HubDataLock` rejects concurrent ownership of one directory. SQLite message history uses WAL and `synchronous = FULL`.

## User surfaces

### Human commands

`/a2a` provides Hub status, Project create/list/delete, connect/disconnect, current status, peer listing, and explicit history. Its synchronous completion tree covers root commands, Project subcommands, `connect --as`, and compatible history flags.

### Model tools

- `a2a_peers`: current Presence names in the connected Project.
- `a2a_message`: direct message, Project broadcast, or causal reply.
- `a2a_history`: explicit cursor/sender-filtered history lookup.

Inbound messages are pushed through OMP `sendMessage`; models never poll an Inbox.

## Root asset map

| Asset | Responsibility |
| --- | --- |
| `package.json` | Bun metadata, OMP extension registration, Hub executable, and smoke scripts. |
| `bun.lock` | Locked dependency graph. |
| `README.md` | Operator and user how-to plus public behavior contract. |
| `config.example.yml` | Global Hub URL example. |
| `.env.example` | Docker Compose environment defaults. |
| `Dockerfile` | Unprivileged standalone Hub image. |
| `docker-compose.yml` | Hub process, health check, published port, and persistent volume. |

## Directory map

| Directory | Responsibility | Detailed map |
| --- | --- | --- |
| `src/` | OMP adapter, runtime, configuration, Project metadata, and domain names. | [`src/codemap.md`](src/codemap.md) |
| `src/hub/` | HTTP/WebSocket protocol, Presence, routing, message history, payloads, locking, and process lifecycle. | [`src/hub/codemap.md`](src/hub/codemap.md) |
| `scripts/` | Executable Registry, Hub, and Docker smoke scenarios. | [`scripts/codemap.md`](scripts/codemap.md) |
| `tests/` | Bun behavior tests for configuration, payloads, message history, realtime routing, control routes, runtime, and extension registration/completion. | Tests are excluded from generated map state. |
| `docs/` | Historical fixed-snapshot review material. | Documentation is excluded from generated map state. |

## Verification

`bun run smoke` runs all Bun tests, the Project Registry smoke, and the live in-process Hub smoke. It covers Project isolation and deletion, WebSocket Presence and name conflicts, notifications, direct and broadcast routing, delivery outcomes, persistent history and migration, payload limits, and Hub restart.

`bun run smoke:docker` exercises the public HTTP and WebSocket surfaces of the selected running Hub and removes its temporary Project.

Biome, Bun builds, and a real Docker image/network smoke are separate release checks.

## Operational boundaries

- No authentication, authorization, tenant isolation, or confidentiality guarantee exists.
- Established WebSockets do not move when `hubUrl` changes; disconnect and reconnect.
- Project metadata deletion and SQLite history deletion are separate operations rather than one transaction.
- Ordinary HTTP Project/history calls have no default deadline.
- The default Compose port publication binds all host interfaces unless the operator narrows it.
