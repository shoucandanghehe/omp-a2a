# `src/` Codemap

## Responsibility

The direct modules in `src/` form the client-facing and shared foundation of the A2A project mesh:

- adapt the mesh to the Oh My Pi extension lifecycle;
- translate commands and tool calls into stateful A2A operations;
- load per-repository client configuration;
- define shared project/member contracts and validation constants;
- provide the filesystem layout and file-backed project/member registry used by the Hub.

The transport, HTTP server, inbox, and wire-envelope implementation live under `src/hub/`. They are outside this map except where they consume or are consumed by direct `src/*.ts` modules.

## Architecture and Design

### Layering

1. **Extension adapter — `extension.ts`**
   Registers the `/a2a` command, the `a2a` tool, and session lifecycle hooks with `ExtensionAPI`. It owns session-scoped timers and converts Hub envelopes into injected OMP messages or UI notifications.
2. **Application service — `operations.ts`**
   `A2aOperations` is the shared dispatcher used by both extension entry surfaces. It validates action-specific requirements, tracks the current membership, calls `HubClient`, and returns presentation-ready text plus structured details.
3. **Hub boundary — `hub/client.ts` and `hub/types.ts`**
   The extension and operations layer communicate with the standalone Hub only through `HubClient` and Hub envelope types.
4. **Shared domain and infrastructure — `types.ts`, `config.ts`, `paths.ts`, `registry.ts`**
   These modules define project/member data, local configuration, storage locations, and the Hub server's file-backed membership registry.

### Patterns and State

- **Adapter pattern:** `a2aExtension` adapts OMP command, tool, event, timer, UI, logger, and message-injection APIs to one `A2aOperations` instance.
- **Command dispatcher:** `A2aOperationRequest.action` is the discriminant handled by `A2aOperations.execute`.
- **Session-scoped client cache:** `ensureClient` lazily connects a `HubClient` and replaces it when the selected base URL changes.
- **Hub-bound membership state:** `A2aOperations.#membership` retains the accepting `HubClient`, its base URL, and the opaque lease token. Public membership details expose only project, agent, and Hub URL.
- **Fenced presence:** stored members receive a fresh lease at registration. Heartbeat, unregister, Inbox read, and acknowledgment require the current lease; stale/offline takeover invalidates the predecessor.
- **Abortable background work:** the extension keeps at most one Inbox request and one heartbeat in flight. Both share a background abort signal and settle before membership transitions; delivery acknowledges only while the generation remains active.
- **File-backed registry:** projects have metadata files and members have one JSON file each. Stored member records include the private lease, while member listings strip it. `writeJsonAtomic` writes a process/UUID-specific temporary file, renames it into place, and best-effort applies mode `0600`.

## Entry Points and Extension Lifecycle

### Runtime entry point

`extension.ts` default-exports `a2aExtension(pi: ExtensionAPI)`. Registration performs the following:

1. Calls `pi.setLabel("A2A Project Mesh")`.
2. Creates session-local Hub connection state, timer handles, and one `A2aOperations`.
3. Registers `session_start` and `session_shutdown` handlers.
4. Registers the `/a2a` command.
5. Registers the model-callable `a2a` tool.

### Session start and automatic join

1. `session_start` records `context.cwd`.
2. `refreshHubUrl` loads local configuration once and takes its optional `hubUrl`; parse failures become an error notification and end the hook cleanly.
3. `ensureClient` resolves the target with `resolveHubUrl`, reuses a matching `HubClient`, or calls `HubClient.connect`.
4. Hub connection failure produces a warning but does not abort the hook.
5. Missing config or `autoJoin === false` ends auto-join.
6. Otherwise `run({ action: "join", ... }, context)` calls `A2aOperations.execute`.
7. Join calls `HubClient.register` (or `heartbeat` for the same identity), stores membership, and calls `listMembers`.
8. `membershipChanged: "joined"` causes `startBackground` to install exactly one heartbeat and one Inbox timer.

### Active-session background flow

- Every `HEARTBEAT_MS` (5 seconds), the extension starts `A2aOperations.heartbeat` only when no prior heartbeat is active. It passes the shared abort signal and logs non-cancellation failures.
- Every second, the Inbox timer starts a poll only when no prior poll is active.
- `receive` calls `HubClient.readInbox` with the lease and abort signal, invokes the delivery callback in order, rechecks cancellation, then acknowledges with the same lease. Ordinary Hub requests have a 15-second default deadline.
- A `delivery_receipt` becomes an informational UI notification.
- A message envelope goes through `injectEnvelope` to `pi.sendMessage` as custom type `a2a-inbound`, with `triggerTurn: true`. Delivery is `"followUp"` while the agent is idle and `"steer"` otherwise.

### Interactive command and tool flow

- Non-send `/a2a` input passes through `parseArgs`; `send` uses `parseSendRequest` so unknown flag-like tokens remain text and bare `--` ends recognized-option parsing. `commandRequest` then calls `run` and `A2aOperations.execute`. Results are shown through `context.ui.notify`; configuration, parsing, and operation errors become error notifications.
- The registered `a2a` tool validates a structured Zod object, builds the same `A2aOperationRequest`, and uses the same `run` function. It returns result text and details, while configuration or operation failures become an `isError` tool result.
- Supported operations are `project_create`, `project_delete`, `project_list`, `join`, `leave`, `list`, `status`, `send`, `inbox`, and `hub`. The command also accepts `help`; its parser maps the same operational set from command syntax.

### Leave and shutdown

- Explicit join or leave clears future timers, aborts active Inbox and heartbeat requests, and waits for both to settle before changing membership.
- Leave clears local membership and calls `unregister` through the bound Hub client and lease. If cleanup fails, it returns `cleanupPending: true` and relies on lease expiry.
- A failed join restores background work for the retained membership. `session_shutdown` stops background work and executes leave.

## Data and Control Flow

### Project operations

- Create: request → `A2aOperations.execute` → `HubClient.createProject` → Hub HTTP server → `registry.createProject` → project metadata JSON.
- Delete: request → `HubClient.deleteProject` → durable deletion marker → filesystem Registry removal → transactional Inbox/ledger purge → marker removal. Startup reconciliation completes interrupted markers before listening or permitting name reuse.
- List: `HubClient.listProjects` returns project metadata; `A2aOperations` calls `listMembers` for every project in parallel and reports each online count.

### Membership operations

- Join validates the request, registers through the selected Hub, verifies member listing, commits the new bound membership, then best-effort unregisters any predecessor through its original Hub and lease.
- Rejoining the same identity on the same Hub heartbeats with the retained lease rather than registering again.
- Registry join rejects an already-online identity, but permits takeover of an offline or stale stored identity by issuing a fresh lease and member record.
- Heartbeat requires the current lease before rewriting `lastSeenAt` and `status: "online"`; an explicitly offline member cannot heartbeat.
- Registry leave requires the current lease, preserves the record, and writes `status: "offline"` plus a new `lastSeenAt`.
- `listMembers` returns only public online member data by default; `all` includes stale and offline members. Lease tokens never appear and results are sorted by `agentId`.

### Messaging operations

- Send requires a bound membership, non-self recipient, and non-empty text. Sender identity remains a trusted claim and the call forwards optional `messageId`, `replyTo`, and `replyToRef`.
- The returned queued envelope supplies `msgId`, optional agent-friendly `messageRef`, and causal reply metadata. `ASYNC_REPLY_GUIDANCE` tells callers not to wait or poll for replies because the extension injects inbound work.
- Manual Inbox inspection and background receive both use the bound Hub and lease. Manual inspection acknowledges one batch; `receive` delivers and acknowledges each envelope sequentially and abortably.

### Configuration flow

`loadLocalConfig(cwd)` checks `localConfigCandidates` in this order:

1. `.omp/a2a.yml`
2. `.omp/a2a.yaml`
3. `.omp/a2a.json`

The first existing file wins. JSON must be an object. YAML uses the shared `parseSimpleYaml`, which supports scalar keys, inline arrays, one-level dash lists, and comments outside quoted values. Selected-file read, parse, and schema errors include the path and propagate to the adapter. `normalizeConfig`:

- requires `project` and `agentId`;
- accepts `agent_id` or `id` as identity aliases;
- validates names with `PROJECT_NAME_RE` and `AGENT_ID_RE`;
- accepts `caps` or `capabilities`;
- accepts camelCase and snake_case forms of `hubUrl`, `displayName`, and `autoJoin`;
- defaults `autoJoin` to `true`.

### Registry persistence flow

`paths.ts` derives all storage paths from `defaultDataDir()` (`~/.omp/a2a` by default). `registry.ts` uses:

- `projects/<project>/project.json` for `A2aProject`;
- `projects/<project>/members/<agentId>.json` for each `A2aMember`.

Reads return `null` only for missing files. Unreadable or invalid JSON raises `RegistryPersistenceError`; `refreshMember` derives presence without rewriting the file: non-offline records become stale after `STALE_MS` and offline after `OFFLINE_MS`; records already marked offline remain offline.

## Direct File Map

### `extension.ts`

**Responsibility:** OMP extension adapter and lifecycle owner.

**Principal export:**

- default `a2aExtension(pi: ExtensionAPI)`.

**Important private functions:**

- `parseArgs` splits non-send command text into positional arguments and `--key`, `--key=value`, or boolean flags.
- `parseSendRequest` extracts the three recognized send options, preserves unknown flag-like message text, and treats bare `--` as end-of-options.
- `usage` builds command help text.
- `commandRequest` validates command syntax and translates it to `A2aOperationRequest`.
- Inside `a2aExtension`: `refreshHubUrl`, `ensureClient`, `stopBackground`, `injectEnvelope`, `startBackground`, and `run` coordinate connection, delivery, and timers. Session, Slash, and Tool entry points convert local-config failures through their own error channels.

**Dependencies:** `@oh-my-pi/pi-coding-agent`, `loadLocalConfig`, `A2aOperations`, shared validation/timing constants, `HubClient`, and Hub envelope types.

### `operations.ts`

**Responsibility:** Transport-independent operation orchestration and current-membership state.

**Exports:**

- `ASYNC_REPLY_GUIDANCE`
- `A2aMembership`
- `A2aOperationRequest`
- `A2aOperationContext`
- `A2aOperationResult`
- `A2aOperations`

**`A2aOperations` surface:**

- `membership` returns a copy of the current membership.
- `execute` dispatches all command/tool actions.
- `heartbeat` renews the current membership or returns `null`.
- `receive` reads, delivers, and acknowledges pending Hub envelopes.
- `meta` returns Hub metadata.

**Dependencies:** the `HubClient` interface, `HubEnvelope`/`HubMeta`, and `A2aMember`. It is consumed by `extension.ts`.

### `config.ts`

**Responsibility:** Discovery, minimal YAML parsing, normalization, and validation of repository-local A2A configuration.

**Principal exports:**

- `parseSimpleYaml(text: string): Record<string, unknown>`.
- `loadLocalConfig(cwd: string): A2aLocalConfig | null`.

**Dependencies:** Node `fs`, `localConfigCandidates`, `A2aLocalConfig`, `PROJECT_NAME_RE`, and `AGENT_ID_RE`. It is consumed by `extension.ts` and the Hub client's global configuration resolver.

### `types.ts`

**Responsibility:** Shared domain contracts and presence/name constants.

**Exports:**

- `A2aMember`
- `A2aProject`
- `A2aLocalConfig`
- `JoinOptions`
- `ListMembersOptions`
- `HEARTBEAT_MS`
- `STALE_MS`
- `OFFLINE_MS`
- `PROJECT_NAME_RE`
- `AGENT_ID_RE`

`A2aMember.status` is `"online" | "offline" | "stale"`. `OFFLINE_MS` is `STALE_MS * 4`.

**Consumers:** direct config, extension, operations, and registry modules; the Hub client imports project/member types, and Hub message-reference validation imports `AGENT_ID_RE`.

### `paths.ts`

**Responsibility:** Centralized construction of Hub/client storage and configuration paths plus recursive directory creation.

**Exports:**

- Roots and project storage: `defaultDataDir`, `a2aRoot`, `projectsRoot`, `projectDir`, `projectMetaPath`, `membersDir`, `memberPath`.
- Hub runtime storage: `hubRunDir`, `hubMetaPath`, `hubPidPath`, `hubLockPath`, `inboxDatabasePath`.
- Utilities: `ensureDir`, `localConfigCandidates`.

**Consumers:** `config.ts` and `registry.ts`; the Hub client uses `a2aRoot`, while the Hub server, inbox, and data-lock modules use runtime paths and `ensureDir`.

### `registry.ts`

**Responsibility:** Synchronous, file-backed project and member registry used by the Hub server.

**Exports:**

- Errors: `RegistryOperationError` for expected request/domain failures, `RegistryConflictError` for ownership/name conflicts, and `RegistryPersistenceError` for unreadable or malformed persisted JSON.
- Project API: `createProject`, `deleteProject`, `getProject`, `listProjects`.
- Member API: `readMember`, `listMembers`, `joinProject`, `heartbeat`, `leaveProject`.
- Presentation/diagnostic helpers: `formatMembersTable`, `hostnameHint`.
- Re-exported path helpers: `projectDir`, `projectsRoot`.

**Dependencies:** Node `fs`, `os`, and `path`; storage helpers from `paths.ts`; contracts and constants from `types.ts`.

**Consumer:** `src/hub/server.ts` imports the registry's project and membership operations plus `RegistryOperationError` and `RegistryConflictError` to distinguish HTTP client errors from unexpected persistence failures; `RegistryPersistenceError` propagates through the generic HTTP `500` path.

## Hub Integration Boundary

Direct `src/*.ts` modules interact with `src/hub/**` in both directions:

- `extension.ts` imports `HubClient` and `resolveHubUrl` from `hub/client.ts`, plus `HubEnvelope` and `HubMessageEnvelope` from `hub/types.ts`.
- `operations.ts` accepts a lazy `HubClient` provider and uses Hub envelope and metadata types. Its client calls cover project CRUD/listing, registration, heartbeat, unregister, member listing, send, inbox read/ack, and metadata.
- `hub/client.ts` imports `a2aRoot` from `paths.ts` to resolve global Hub configuration and imports `A2aMember`/`A2aProject` from `types.ts` for its public responses.
- `hub/server.ts` imports the registry API and runtime/storage paths to connect HTTP requests to persistent project/member state.
- `hub/data-lock.ts` and `hub/inbox.ts` import `ensureDir`; `hub/message-ref.ts` imports `AGENT_ID_RE`.

This boundary keeps the extension and operation dispatcher HTTP-client-facing, while the standalone Hub server is the consumer of the direct modules' local persistence API.
