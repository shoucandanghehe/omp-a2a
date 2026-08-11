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
5. `MessageStore` atomically appends one immutable Message—including encoded attachment content—and assigns the next Project sequence.
6. The Hub pushes the Message to selected sockets. Each receiver materializes attachments, injects the Message into OMP, then reports `delivered` or `failed`.
7. The sender receives one in-memory `delivered`, `failed`, or `disconnected` outcome per selected Presence.
8. Socket close or heartbeat timeout deletes the Presence and broadcasts `presence_left`.

A same-named later connection is a new Presence and never inherits pending delivery. History is never replayed automatically.

### Persistent message contract

- Message references are `<project>:<sequence>` and sequence is monotonic per Project.
- `messageId` is the persistent idempotency key; conflicting reuse fails.
- `replyTo` must resolve inside the same Project.
- Direct messages are bound to the resolved `presenceId`; Project broadcasts freeze their recipient snapshot at acceptance.
- History is append-only until Project deletion. Presence and delivery events are not persisted.
- Attachments are ordered immutable values inside a Message. Their names and bytes participate in `messageId` idempotency; they share the Message lifecycle.
- Legacy `inbox.sqlite` message-ledger rows migrate once into `messages.sqlite`; old membership, cursor, ACK, receipt, and offline-delivery semantics do not migrate.

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

The Hub runs locally with `bun run hub` or in Docker Compose. Each Hub needs a unique URL and data directory. `HubDataLock` rejects concurrent ownership of one directory. SQLite message history uses WAL and `synchronous = FULL`.

## User surfaces

### Human commands

`/a2a` provides Hub status, Project create/list/delete, connect/disconnect, current status, peer listing, and explicit history. Its synchronous completion tree covers root commands, Project subcommands, `connect --as`, and compatible history flags.

### Model tools

- `a2a_peers`: current Presence names in the connected Project.
- `a2a_message`: direct message, Project broadcast, or causal reply, with optional current-session `local://` attachment sources; successful sends direct the model to continue independent work or end its turn.
- `a2a_history`: deliberate lookup of already-persisted context, never a reply-waiting primitive.

Connected model turns receive the current A2A roster name and use only `a2a_peers` results or inbound sender names to address peers; disconnected turns receive no A2A identity prompt.

Inbound messages are pushed through OMP `sendMessage` in Hub-assigned Project sequence using `steer` delivery: idle sessions start a turn and busy sessions queue the Message into the active turn. Models never wait, sleep, or poll history for replies.
The sender Extension snapshots attachment bytes before sending. Receivers and history callers materialize new URLs in their own session-local storage; the Hub never resolves `local://`.

## Root asset map

| Asset | Responsibility |
| --- | --- |
| `package.json` | Bun metadata, pinned toolchain, OMP extension registration, Hub executable, build, check, and smoke scripts. |
| `bun.lock` | Locked dependency graph. |
| `biome.json` | Canonical formatting, lint, and import-organization policy. |
| `tsconfig.json` | Strict TypeScript 7 no-emit project boundary for source, scripts, and tests. |
| `.github/workflows/ci.yml` | Read-only source quality and real container smoke gates. |
| `.github/dependabot.yml` | Weekly Bun, GitHub Actions, and Docker dependency updates. |
| `AGENTS.md` | Repository map, commit-message style, signing, and history-rewrite rules. |
| `README.md` | Operator and user how-to plus public behavior contract. |
| `config.example.yml` | Global Hub URL example. |
| `.env.example` | Docker Compose environment defaults. |
| `Dockerfile` | Unprivileged standalone Hub image pinned to an exact Bun release and image digest. |
| `docker-compose.yml` | Hub process, health check, published port, and persistent volume. |

## Directory map

| Directory | Responsibility | Detailed map |
| --- | --- | --- |
| `src/` | OMP adapter, runtime, configuration, Project metadata, and domain names. | [`src/codemap.md`](src/codemap.md) |
| `src/hub/` | HTTP/WebSocket protocol, Presence, routing, message history, payloads, locking, and process lifecycle. | [`src/hub/codemap.md`](src/hub/codemap.md) |
| `scripts/` | Executable Registry, Hub, and Docker smoke scenarios. | [`scripts/codemap.md`](scripts/codemap.md) |
| `tests/` | Bun behavior tests for configuration, payloads, message history, realtime routing, control routes, runtime, and extension registration/completion. | Tests are excluded from generated map state. |
| `docs/` | Implemented architecture decisions, dated CI research, and historical fixed-snapshot review material. | Documentation is excluded from generated map state. |

## Verification

`bun run check` enforces zero-warning Biome CI checks and strict TypeScript 7 no-emit checking. `bun run verify` adds both Bun entry-point builds, all Bun tests, the Project Registry smoke, and the live in-process Hub smoke. `bun run audit` rejects high or critical advisories in production dependencies.

GitHub Actions runs those source and dependency gates alongside an independent Docker Compose job that validates the model, waits for the real container health check, crosses its HTTP/WebSocket boundary with `bun run smoke:docker`, prints logs on failure, and always removes containers and volumes. Third-party actions are commit-SHA pinned; workflow permissions are read-only; superseded runs are cancelled. Dependabot checks the Bun lockfile, action pins, and Docker base image weekly.

The implemented realtime model is documented in [`docs/realtime-presence-architecture.md`](docs/realtime-presence-architecture.md). The dated review in `docs/code-review-2026-07-19.md` is archival and does not define the current contract.

## Operational boundaries

- No authentication, authorization, tenant isolation, or confidentiality guarantee exists.
- Established WebSockets do not move when `hubUrl` changes; disconnect and reconnect.
- Project metadata deletion and SQLite history deletion are separate operations rather than one transaction.
- Ordinary HTTP Project/history calls have no default deadline.
- The default Compose port publication binds all host interfaces unless the operator narrows it.
