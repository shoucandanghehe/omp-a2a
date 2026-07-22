# `scripts/`

## Responsibility

This directory contains executable smoke scenarios for the two public operating modes of the project:

- `smoke.ts` exercises the filesystem-backed registry and local repository configuration directly.
- `smoke-hub.ts` exercises the same system through live Hub servers and `HubClient` HTTP calls, including messaging and restart durability.

Both scripts are assertion-driven end-to-end checks rather than test-framework suites. Each prints named scenario headings, throws an `Error` prefixed with `ASSERT:` when an invariant fails, reports a final success message only after every scenario passes, and sets `process.exitCode = 1` on failure.

## Design and Patterns

- **Isolated fixtures:** each run creates unique directories beneath `os.tmpdir()` with `fs.mkdtempSync`, so it does not use the caller's registry or repository state.
- **Sequential scenarios:** later checks intentionally consume state produced by earlier checks. These scripts therefore describe complete lifecycles, not independent test cases.
- **Black-box assertions:** `smoke.ts` calls exported registry/config APIs; `smoke-hub.ts` uses `HubClient` against actual `startHubServer` instances rather than reaching into server internals.
- **Explicit lifecycle management:** successful runs remove temporary state. Failed runs preserve it and print its location for diagnosis.
- **No testing-library dependency:** each file defines the same small `assert(condition, message)` helper and relies on thrown errors plus the process exit code.

## `smoke.ts`: Direct Registry and Configuration Smoke

### Setup and dependencies

At module load, `smoke.ts` creates one temporary registry `dataDir`. It depends on:

- Node.js `fs`, `os`, and `path` for fixture creation, YAML writing, and cleanup.
- `loadLocalConfig` from `../src/config`.
- `createProject`, `listProjects`, `joinProject`, `heartbeat`, `listMembers`, `formatMembersTable`, `leaveProject`, and `RegistryConflictError` from `../src/registry`.

Execution is synchronous and begins directly in the module-level `try` block.

### Invocation and control flow

1. **Create isolated projects**
   - Calls `createProject` for `billing-rewrite` (with display name `Billing`) and `other-mesh`, always passing the temporary `dataDir`.
   - Calls `listProjects(dataDir)` and requires exactly two results.
   - This proves that multiple projects can be created and enumerated in one isolated registry.

2. **Heartbeat-owned presence**
   - Calls `joinProject` for agents `api` and `web` in `billing-rewrite`, with distinct working directories and deliberately diagnostic PID values.
   - Calls `heartbeat("billing-rewrite", "api", dataDir)`.
   - Reads members with `listMembers`, prints them through `formatMembersTable`, and requires both joined agents to remain listed.
   - Separately requires `other-mesh` to have no members.
   - This proves that member presence is represented by registry/heartbeat state rather than treating the supplied PID as an authoritative liveness check, and that membership is isolated by project.

3. **Reject an online duplicate**
   - Attempts a second `joinProject` for agent ID `api` with replacement metadata.
   - Accepts the scenario only when the thrown value is a `RegistryConflictError`.
   - This proves that an online agent ID cannot be claimed again within the project.

4. **Idempotent leave**
   - Calls `leaveProject` twice for `api`.
   - Calls `listMembers` and requires that no returned member has `agentId === "api"`.
   - This proves that leaving removes the member from online results and that repeating the leave operation is safe.

5. **Load local configuration**
   - Creates `<dataDir>/repo/.omp/a2a.yml` containing `hubUrl`, `project`, `agentId`, and inline `caps`.
   - Calls `loadLocalConfig(repo)`.
   - Requires the parsed Hub URL to equal `http://127.0.0.1:4199` and the capabilities to preserve `api,db` order.
   - This proves discovery of `.omp/a2a.yml` from a repository path and parsing of scalar and array configuration fields.

### Teardown and outcome

The enclosing `catch` prints `SMOKE FAILED:` and sets `process.exitCode = 1`. The `finally` block recursively removes `dataDir` only on success; on failure it prints the retained directory. A complete pass prints `Registry smoke OK`.

## `smoke-hub.ts`: Live Hub and Messaging Smoke

### Setup and dependencies

At module load, `smoke-hub.ts` creates two independent temporary data directories and an initially empty `HubServerHandle[]`. It depends on:

- Node.js `fs`, `os`, and `path` for isolated persistent state and cleanup.
- `HubClient` from `../src/hub/client` for all Hub-facing operations.
- `startHubServer` and `HubServerHandle` from `../src/hub/server` for live server lifecycle management.

The module invokes asynchronous `main()`. Every started handle is appended to `handles`, including the first server, the independent second server, and the later restarted server. Passing `port: 0` asks each server to bind an available port; clients use the resulting `handle.meta.baseUrl`.

### Invocation and control flow

1. **Independent Hubs**
   - Starts two servers over different data directories and constructs one `HubClient` per server.
   - Creates `mesh-demo` through the first client, then requires the second client's project list to remain empty.
   - This proves that separate Hub instances do not share registry state.

2. **Registration and duplicate rejection**
   - Registers `api` and `web` in `mesh-demo` with distinct working directories and diagnostic PID values.
   - Attempts to register `api` again and requires the request to fail.
   - Requires `listMembers("mesh-demo")` to return both original members.
   - This proves online agent-ID exclusivity and that Hub membership presence does not depend on those supplied PIDs being live local processes.

3. **Trust-on-claim send and durable delivery receipt**
   - Sends `hello` from unregistered sender name `controller` to registered recipient `web`.
   - Reads `web`'s inbox and requires the original text, proving that send accepts the sender claim without prior sender registration.
   - Acknowledges the message by `msgId`, then requires `web`'s inbox to be empty.
   - Reads `controller`'s inbox and requires a `delivery_receipt` whose `receiptFor` points to the original `msgId`.
   - Acknowledges the receipt and verifies that this does not create another receipt in `web`'s inbox.
   - Together these calls prove recipient acknowledgement removes the queued message, creates a durable receipt for the claimed sender, and terminates rather than forming a receipt loop.

4. **Gzip large payload**
   - Builds a large, compressible string by repeating `compressible diff line\n` 2,000 times.
   - Sends it from `controller` to `web`, reads it back, and requires exact text equality before acknowledging it.
   - This exercises the client/server path labeled for gzip payload handling and proves lossless round-trip delivery for that large body.

5. **Persistent inbox across restart**
   - Sends an unacknowledged `survive restart` message to `web` and saves the returned `msgId`.
   - Stops the first Hub, restarts a Hub with the same `firstDataDir` on a newly assigned port, and creates a new client from the restarted server's `baseUrl`.
   - Reads `web`'s inbox and requires the persisted message ID, then acknowledges it.
   - This proves that queued inbox data is stored in the Hub data directory and remains available through server shutdown and restart.

6. **Fail closed for an unknown recipient**
   - Attempts to send to agent ID `missing` and requires the client call to reject.
   - This proves that the Hub does not silently enqueue a message for an unknown recipient.

7. **Safe project deletion**
   - Attempts to delete `mesh-demo` while `api` and `web` are still online and requires rejection.
   - Unregisters both members, deletes the project, and requires a `true` result.
   - Requires the project list to become empty, then repeats deletion and requires `false`.
   - This proves deletion is blocked while members are online, succeeds once the project is inactive, removes it from enumeration, and is idempotent for an absent project.

### Teardown and outcome

The `main()` rejection handler prints `HUB SMOKE FAILED:` and sets `process.exitCode = 1`. Its asynchronous `finally` stops every accumulated server handle with `Promise.all`. On success it recursively removes both temporary directories; on failure it retains and prints both paths. A complete pass prints `Custom Mesh Hub smoke OK`.

## Integration Points

| Boundary | Script | Interaction |
|---|---|---|
| Registry persistence | `smoke.ts` | Supplies an explicit `dataDir` to all project/member operations. |
| Local repository config | `smoke.ts` | Writes `.omp/a2a.yml`, then loads it through `loadLocalConfig(repo)`. |
| Hub server lifecycle | `smoke-hub.ts` | Starts/stops `HubServerHandle` instances and restarts one over existing data. |
| Hub transport API | `smoke-hub.ts` | Uses `HubClient` for project, membership, messaging, inbox, acknowledgement, and deletion calls. |
| Local filesystem | Both | Creates isolated persistent fixtures, cleans successful runs, and preserves failed runs. |

## File Map

| File | Role |
|---|---|
| `smoke.ts` | Synchronous direct-API smoke for registry projects, member presence/conflicts, idempotent leave, and local YAML configuration. |
| `smoke-hub.ts` | Asynchronous live-server smoke for Hub isolation, registration, messaging/receipts, large payloads, restart persistence, recipient validation, and safe deletion. |
| `codemap.md` | Architectural and scenario reference for the executable smoke scripts. |
