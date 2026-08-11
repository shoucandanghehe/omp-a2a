# Smoke Script Atlas

## Responsibility

`scripts/` contains executable boundary scenarios. These are not duplicate unit-test suites: each script starts or targets real project modules and proves a runnable path with explicit assertions.

## Entry points

| Script | Invocation | Boundary exercised |
| --- | --- | --- |
| `smoke.ts` | `bun run scripts/smoke.ts` | Canonical SQLite Project store in a temporary data directory. |
| `smoke-hub.ts` | `bun run scripts/smoke-hub.ts` | Two real in-process HTTP/WebSocket Hubs with temporary persistent storage. |
| `smoke-docker.ts` | `bun run smoke:docker` | Public HTTP and WebSocket interfaces of an already-running selected Hub. |

`bun run smoke` executes `bun test`, `smoke.ts`, then `smoke-hub.ts`. Docker is intentionally separate because it needs an already-running container boundary.

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
- Start two `HubServerHandle` instances on ephemeral ports.
- Track every handle for asynchronous `finally` shutdown.
- Use `AsyncQueue` to await concrete Presence, message, and delivery events instead of sleeping.

### Covered scenario

1. **Independent Hubs**: create a Project on the first Hub and prove the second Hub does not see it.
2. **Realtime Presence**: connect named `api` and `web` sockets and observe peer snapshot plus join notification.
3. **Direct message**: send from `api` to current `web`, observe accepted Project sequence, realtime payload, and sender delivery result.
4. **Project broadcast**: connect another peer, freeze the recipient snapshot, and observe one message plus delivery outcome per selected Presence.
5. **Persistent history**: query accepted messages through HTTP and prove history survives Hub stop/restart while Presence does not.
6. **Safe Project deletion**: close Presence, delete the Project and its history, and verify name reuse starts empty.

### Cleanup

All Hub handles close in `finally`. Successful runs remove both data directories. Failed runs print their paths and preserve the data for diagnosis.

## `smoke-docker.ts`

### Goal

Cross the deployed process/network boundary rather than proving another in-process server path.

### Preconditions

- A Hub is already reachable through normal client URL resolution.
- For Compose, run `docker compose up -d --build` first.
- `OMP_A2A_HUB_URL` may select a non-default published URL.

### Scenario

1. Connect an HTTP `HubClient`.
2. Create a timestamped temporary Project.
3. Open `api` and `web` WebSocket Presences.
4. Send one direct Message with an explicit `messageId` and binary-safe attachment.
5. Assert the Hub assigned `<project>:1`.
6. Await and decode the realtime text and exact attachment bytes at `web`.
7. Close both sockets.
8. Query HTTP history and assert the Message and attachment bytes persisted.
9. Delete the temporary Project.

`finally` closes any surviving sockets and retries Project deletion. The script never owns or stops the external Hub.

## Verification matrix

| Behavior | Unit/behavior tests | `smoke.ts` | `smoke-hub.ts` | `smoke-docker.ts` |
| --- | --- | --- | --- | --- |
| SQLite Project persistence | yes | yes | yes | yes |
| Independent Hub state | yes | no | yes | no |
| WebSocket handshake/Presence | yes | no | yes | yes |
| Direct realtime routing | yes | no | yes | yes |
| Project broadcast snapshot | yes | no | yes | no |
| Delivery outcomes | yes | no | yes | no |
| Persistent history/restart | yes | no | yes | history only |
| Attachment wire/history bytes | yes | no | no | yes |
| Legacy message migration | yes | no | no | no |
| Payload boundaries | yes | no | representative payload | representative payload |
| Actual container/network process | no | no | no | yes |

## Design rules

- Await emitted protocol events; do not use wall-clock sleeps as synchronization.
- Allocate ephemeral ports and temporary directories for in-process scenarios.
- Fail loudly at the first violated contract.
- Leave failed Hub data available when it improves diagnosis.
- Keep Docker ownership outside `smoke-docker.ts`; the caller controls deployment lifecycle.
