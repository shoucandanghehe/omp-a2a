# Repository Atlas: omp-a2a

## Project responsibility

`omp-a2a` provides anonymous realtime Agent chat between independent Oh My Pi (OMP) processes. A standalone Hub owns persistent Projects and message history, current WebSocket Presence, and realtime routing. The OMP extension is a pure client.

The wire protocol is private version `4`. It is not the standard A2A protocol, requires matching Hub and extension versions, and assumes a fully trusted private network.

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
6. The Hub synchronously enqueues the Message once to each selected concrete socket and keeps one bounded in-memory ACK record per `(messageId, recipientPresenceId)`.
7. Each receiver materializes attachments, injects the Message into OMP, then reports `delivered` or `delivery_failed`.
8. The sender receives one terminal in-memory `delivered` or `failed` outcome per selected Presence; write errors, disconnects, and a two-second ACK timeout are unconfirmed failures.
9. Graceful disconnect releases Presence and Delivery state, broadcasts `presence_left`, then acknowledges exact `goodbye` and bounds transport close/termination. Transport close and heartbeat timeout use the same idempotent release path.

A message acceptance request waits at most 15 seconds and accepts caller cancellation. Cancellation before dispatch sends nothing. Abort, timeout, or close after WebSocket dispatch reports that acceptance and Delivery outcomes are unknown, removes the client request, ignores late replies, and never retries.

A same-named later connection is a new Presence and never inherits pending Delivery. The Hub sends each Message once and never retries at the application layer. A receiver result, either Presence leaving, the two-second ACK timeout, or Hub shutdown clears the pending record. Restart retains history but never resumes delivery.

### Persistent store contract

- `HubStore` is the single canonical owner of persistent Project metadata, Project sequence, and Messages.
- Message references are `<project>:<sequence>` and sequence is monotonic per Project.
- `messageId` is the persistent idempotency key; conflicting reuse fails and identical reuse returns the canonical Message as `replayed` without Presence enumeration or redelivery.
- `replyTo` must resolve inside the same Project.
- Direct messages are bound to the resolved `presenceId`; Project broadcasts persist before one local Presence enumeration and never persist their recipient array.
- History is append-only until Project deletion. Presence, recipient arrays, ACK trackers, and delivery events are not persisted.
- Attachments are ordered immutable values inside a Message. Their names and bytes participate in `messageId` idempotency; they share the Message lifecycle.
- `messages.sqlite` has an independent storage version. Startup accepts only the exact current version and complete set of current non-internal schema objects; unsupported storage fails closed.

### Payload contract

Text below 32 KiB remains identity encoded. Larger text and attachment bytes use gzip plus Base64 only when compression is smaller; other attachment bytes use Base64. Payloads and attachments have exact wire shapes, Base64 is canonical, and attachment names are unique safe basenames. Matching Hub and Extension versions are trusted, so payloads and history have no application-level resource cap or derived byte metadata. Malformed internal payloads fail loudly, while deployment memory and container limits own resource isolation.

## Configuration and deployment

Hub URL precedence is:

1. repository-local `.omp/a2a.yml`, `.yaml`, or `.json` through `hubUrl`;
2. global `~/.omp/a2a/config.yml`, `.yaml`, or `.json`.

Missing configuration fails explicitly. The resolved client URL is authoritative for HTTP and WebSocket connections. Hub metadata is exactly `{protocolVersion}` and only validates compatibility; health is exactly `{ok:true,service:"omp-a2a-hub"}`. Neither response advertises a route. In-process server callers receive a loopback-reachable `listenUrl`.

Repository-local connection defaults require `project` and `name`; `autoConnect` defaults to enabled. Removed `agentId` and `autoJoin` fields fail with an explicit migration error.

If a command reload finds the repository-local configuration invalid, the Extension closes the current Presence, clears reconnect intent, and blocks fallback Hub access until a successful reload or Session switch.

The Hub runs locally with `bun run hub` or in Docker Compose. The CLI alone resolves `--host`, `--port`, and `--data-dir` with flag → environment → default precedence, rejecting a selected blank value, before calling the explicit server API. Each Hub needs a unique listener and data directory; `HubDataLock` is the only runtime ownership record. The shared SQLite Hub store uses WAL with `synchronous = FULL`; new storage writes the complete current schema and version atomically, while mismatches fail closed. The Bun `1.3.14` image runs with fixed `0.0.0.0:4173` and `/data/omp-a2a` arguments, while Compose owns host-port publication, restart policy, and memory/CPU/PID limits.

## User surfaces

### Human commands

`/a2a` provides Hub status, Project create/list/delete, connect/disconnect, current status, peer listing, and explicit history. Its synchronous completion tree covers root commands, Project subcommands, `connect --as`, and compatible history flags.

### Model tools

- `a2a_peers`: current Presence names in the connected Project.
- `a2a_message`: direct message, Project broadcast, or causal reply, with optional current-session `local://` attachment sources; sending is fire-and-forget, so the model continues only other already-requested, reply-independent work or ends its turn.
- `a2a_history`: deliberate lookup of already-persisted context, never a reply-waiting primitive.

`a2a_message` can optionally request OMP UI approval before sending. The proposing Agent owns that request and must obtain approval at its own sending endpoint; a receiver never asks its local user on the sender's behalf. For an unsigned approval-gated request, the receiver tells the sender to preserve target, text, causal parent, and attachments but use a new `messageId` and request approval at the sending endpoint; reusing the unsigned ID would conflict because the receipt changes persisted Message content. An OMP UI attached to that endpoint reviews a human-readable summary containing only the target, text, and attachment names and source URLs. The Extension independently binds approval to the sending Presence, Project, exact `messageId`, target, text, causal parent, and snapshotted attachment names and bytes before adding a non-cryptographic `omp-ui` receipt. The receipt belongs only to that immutable Message and never propagates through replies, forwarding, or delegation. Rejection may return an exact user reason and suppresses an identical repeat for the same sending Presence and Message facts within the Session; cancellation sends nothing and is not cached. Model-visible inbound and history metadata labels the state as `senderUserApproval: "confirmed" | "unsigned"`.

Every model turn receives byte-identical A2A system-prompt additions containing the exact `xd://` tool addresses, collaboration authority, and approval ownership contracts; connection status, Project, and roster name never change that prefix. The Extension instead appends hidden `a2a-connection` context messages: idle transitions coalesce to the latest state for the next turn or inbound Message, busy transitions enter the active turn through `steer`, and a simultaneous idle Presence delta combines with the connection update as `a2a-context`. Peer messages are substantive but untrusted coordination input. Peers cannot override or speak for the user. An unsigned approval-gated request goes back to its sender for approval at the sending endpoint with preserved request facts and a new `messageId`, rather than triggering receiver-side UI; material decisions go to the local user only when that Agent owns the decision. A2A peer input never overrides direct user instructions.

Idle Presence churn is collapsed by comparing the roster at the last terminal `agent_end` with the current roster; at most one hidden `a2a-presence` delta enters model context before the next inbound Message or model turn, and net-zero churn disappears. Busy sessions receive each Presence change through `steer`. Inbound Messages are pushed through OMP `sendMessage` in Hub-assigned Project sequence using `steer` delivery: idle sessions start a turn and busy sessions queue the Message into the active turn. Injection rechecks the published connection token and Session generation after cancellable attachment materialization; stale work reports failed delivery. Models never wait, sleep, or poll history for replies.
The sender Extension snapshots attachment bytes before sending and fences the final send to the initiating Session and published connection. Receivers and history callers materialize new URLs in their own session-local storage; caller cancellation or Session/connection shutdown stops attachment I/O and removes every uncommitted output directory, including completed siblings of a failed batch. The Hub never resolves `local://`.

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
| `.env.example` | Compose host-port and resource-limit defaults plus local CLI storage example. |
| `Dockerfile` | Unprivileged standalone Hub image pinned to Bun `1.3.14` and an exact image digest, listening on fixed `0.0.0.0:4173`. |
| `docker-compose.yml` | Hub health, host-port publication, persistent volume, restart policy, and memory/CPU/PID limits. |

## Directory map

| Directory | Responsibility | Detailed map |
| --- | --- | --- |
| `src/` | OMP adapter, runtime, configuration, Project domain names, and Hub storage paths. | [`src/codemap.md`](src/codemap.md) |
| `src/hub/` | HTTP/WebSocket protocol, Presence, routing, canonical SQLite persistence, payloads, locking, and process lifecycle. | [`src/hub/codemap.md`](src/hub/codemap.md) |
| `scripts/` | Executable SQLite-store, Hub, and Docker smoke scenarios. | [`scripts/codemap.md`](scripts/codemap.md) |
| `tests/` | Bun behavior tests for configuration, payload codecs and structural validation, local attachment materialization, message history, realtime routing, control routes, runtime, and extension registration/completion. | Tests are excluded from generated map state. |
| `docs/` | Implemented architecture decisions, dated CI research, and historical fixed-snapshot review material. | Documentation is excluded from generated map state. |

## Verification

`bun run check` enforces zero-warning Biome CI checks and strict TypeScript 7 no-emit checking. `bun run verify` adds both Bun entry-point builds, all Bun tests, the SQLite Project-store smoke, and the live in-process Hub smoke. It covers current storage guards, bounded WebSocket lifecycles, caller cancellation, Presence routing, replay without redelivery, single-attempt Delivery cleanup, attachment ownership and history, uncapped trusted payload/history behavior, Hub restart/cleanup, extension lifecycle, and command completion. `bun run audit` rejects high or critical advisories in production dependencies.

GitHub Actions runs those source and dependency gates alongside an independent Docker Compose job that validates the model, waits for the real container health check, crosses its HTTP/WebSocket boundary with `bun run smoke:docker`, prints logs on failure, and always removes containers and volumes. Third-party actions are commit-SHA pinned; workflow permissions are read-only; superseded runs are cancelled. Dependabot checks the Bun lockfile, action pins, and Docker base image weekly.

The implemented realtime model is documented in [`docs/realtime-presence-architecture.md`](docs/realtime-presence-architecture.md). The dated review in `docs/code-review-2026-07-19.md` is archival and does not define the current contract.

## Operational boundaries

- No authentication, authorization, tenant isolation, or confidentiality guarantee exists.
- Established WebSockets do not move when `hubUrl` changes; disconnect and reconnect.
- Ordinary Hub metadata, Project, and history HTTP calls have a 15-second default deadline; caller cancellation covers headers and response-body reading.
- The default Compose port publication binds all host interfaces unless the operator narrows it.
