# Smoke Script Atlas

## Responsibility

`scripts/` contains executable boundary scenarios and operator tools. Smoke scenarios are not duplicate unit-test suites: each script starts or targets real project modules and proves a runnable path with explicit assertions. Operator tools change deployment state and fail loudly instead of guessing.

## Entry points

| Script | Invocation | Boundary exercised |
| --- | --- | --- |
| `smoke.ts` | `bun run scripts/smoke.ts` | Canonical SQLite Project store in a temporary data directory. |
| `smoke-hub.ts` | `bun run scripts/smoke-hub.ts` | Two real in-process HTTP/WebSocket Hubs with temporary persistent storage. |
| `smoke-docker.ts` | `bun run smoke:docker` | Public HTTP and WebSocket interfaces of an already-running selected Hub. |
| `migrate-storage.ts` | `bun run migrate:storage` | Version 2 `messages.sqlite` converted to the current storage version under the Hub data lock. |

`bun run smoke` executes `bun test`, `smoke.ts`, then `smoke-hub.ts`. Docker is intentionally separate because it needs an already-running container boundary.

`bun run verify` first enforces Biome and strict TypeScript checks, builds both executable entry points, then runs `bun run smoke`. CI owns the separate Compose lifecycle around `smoke:docker`.

## `smoke.ts`

### Goal

Prove Project metadata persists in the same SQLite owner used by the Hub, with deterministic listing and idempotent deletion, without starting a server.

### Scenario

1. Create a unique temporary data directory and open `HubStore`.
2. Create `billing` and `search` Projects.
3. Assert deterministic name order.
4. Close and reopen the store, then prove `billing` persisted.
5. Delete `billing`, assert a second deletion returns false, and prove `search` remains.
6. Close the store and remove the temporary directory in `finally`.

### Failure signal

The local assertion helper throws `ASSERT: <message>`. Temporary storage is always removed because this script has no post-failure forensic dependency.

## `smoke-hub.ts`

### Goal

Exercise the actual HTTP server, WebSocket protocol, realtime Presence, message history, and resource shutdown without Docker or fixed ports.

### Setup

- Create two temporary Hub data directories.
- Start two explicit loopback listeners on ephemeral ports and use each handle's `listenUrl`.
- Track every handle for asynchronous idempotent `finally` shutdown.
- Use `AsyncQueue` to await concrete Presence, message, and delivery events instead of sleeping.

### Covered scenario

1. **Minimal control responses**: assert metadata contains only `protocolVersion` and health contains only `ok` plus the service name.
2. **Independent Hubs**: create a Project on the first Hub and prove the second Hub does not see it.
3. **Realtime Presence**: connect named `api` and `web` sockets and observe peer snapshot plus join notification.
4. **Direct message**: send from `api` to current `web`, observe accepted Project sequence, realtime payload, and sender delivery result.
5. **Project broadcast**: connect another peer, freeze the recipient snapshot, and observe one message plus delivery outcome per selected Presence.
6. **Persistent history**: query accepted messages through HTTP and prove history survives Hub stop/restart while Presence does not.
7. **Safe Project deletion**: close Presence, delete the Project and its history, and verify repeated deletion is idempotent.

### Cleanup

All Hub handles close in `finally`. Successful runs remove both data directories. Failed runs print their paths and preserve the data for diagnosis.

## `smoke-docker.ts`

### Goal

Cross the deployed process/network boundary rather than proving another in-process server path.

### Preconditions

- A Hub is already reachable at the explicit `OMP_A2A_SMOKE_HUB_URL`, or through `HubClient`'s global configuration fallback (`~/.omp/a2a/config.yml`, `.yaml`, or `.json`).
- For Compose, run `docker compose --project-name omp-a2a-boundary-smoke up -d --build --wait --wait-timeout 90` first, then tear down with `docker compose --project-name omp-a2a-boundary-smoke down --volumes --remove-orphans`.

### Scenario

1. Decode exact minimal metadata and health responses through the configured client URL.
2. Create a timestamped temporary Project.
3. Open `api` and `web` WebSocket Presences.
4. Send one direct Message with an explicit `messageId` and binary-safe attachment.
5. Assert the Hub assigned `<project>:1`.
6. Await and decode the realtime text and exact attachment bytes at `web`.
7. Close both sockets.
8. Query HTTP history and assert the Message and attachment bytes persisted.
9. Delete the temporary Project.

`finally` closes any surviving sockets and retries Project deletion. The script never owns or stops the external Hub.

## `migrate-storage.ts`

### Goal

Convert version 2 `messages.sqlite` storage to the current version without changing the Hub's fail-closed startup contract.

### Scenario

1. Resolve the data directory exactly like the Hub (`--data-dir`, `OMP_A2A_HUB_DATA_DIR`, then `~/.omp/a2a`) and report `absent` without creating anything when the database is missing.
2. When the database exists, acquire the Hub data lock so a running Hub blocks conversion.
3. In one transaction, rename `target_name` to `target_names` and `target_presence_id` to `target_presence_ids`, convert `project` targets to `all` while clearing target columns, convert `agent` targets to `agents` with JSON-wrapped names and optional presence IDs, and set the current `user_version`.
4. After a `migrated` result, reopen through `HubStore` so its schema guard validates the converted schema; a `current` result is already a no-op and skips reopening.
5. Report `migrated` or `current`; any other storage version fails before the conversion transaction and therefore without writing.

### Design rules

- `ALTER TABLE ... RENAME COLUMN` preserves the stored schema text, so no table rebuild and no second copy of the current DDL.
- Re-running on current storage is a no-op.
- The migration is explicit operator work; `HubStore` never converts storage during startup.
- The migration transaction preserves Project metadata, sequences, payloads, attachments, approval receipts, timestamps, and causal references; it changes only the legacy target columns/kinds and storage version. Other target-kind values are not rewritten.
- The post-migration `HubStore` reopen is a schema check after the conversion transaction commits; if that check rejects the database, the committed conversion is not rolled back.

## Verification matrix

| Behavior | Unit/behavior tests | `smoke.ts` | `smoke-hub.ts` | `smoke-docker.ts` |
| --- | --- | --- | --- | --- |
| SQLite Project persistence | yes | yes | yes | CRUD only; no reopen |
| Independent Hub state | yes | no | yes | no |
| WebSocket handshake/Presence | yes | no | yes | yes |
| Direct realtime routing | yes | no | yes | yes |
| Project broadcast snapshot | yes | no | yes | no |
| Delivery outcomes | yes | no | yes | no |
| Persistent history/restart | yes | no | yes | history only |
| Attachment wire/history bytes | yes | no | no | yes |
| Current storage schema guard | yes | no | no | no |
| Version 2 storage migration | yes | no | no | no |
| Payload boundaries | yes | no | representative payload | representative payload |
| Actual container/network process | no | no | no | yes |

## Design rules

- Await emitted protocol events; do not use wall-clock sleeps as synchronization.
- Allocate ephemeral ports and temporary directories for in-process scenarios.
- Fail loudly at the first violated contract.
- Leave failed Hub data available when it improves diagnosis.
- Keep Docker ownership outside `smoke-docker.ts`; the caller controls deployment lifecycle.
