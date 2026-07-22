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
- **Session-scoped client cache:** `ensureClient` lazily connects a `HubClient` and replaces it when the resolved base URL changes.
- **Explicit membership state:** `A2aOperations.#membership` is either `null` or `{ project, agentId }`. Join establishes or replaces it; leave clears it before attempting remote unregister.
- **Heartbeat/lease presence:** stored members are classified from `lastSeenAt` using `STALE_MS` and `OFFLINE_MS`; periodic client heartbeats renew online presence.
- **Polling consumer:** the extension polls the inbox every second, prevents overlapping polls with `polling`, injects each message, and acknowledges it after delivery.
- **File-backed registry:** projects have metadata files and members have one JSON file each. `writeJsonAtomic` writes a process/UUID-specific temporary file, renames it into place, and best-effort applies mode `0600`.

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
2. `refreshHubUrl` calls `loadLocalConfig(cwd)` and takes its optional `hubUrl`.
3. `ensureClient` resolves the target with `resolveHubUrl`, reuses a matching `HubClient`, or calls `HubClient.connect`.
4. Hub connection failure produces a warning but does not abort the hook.
5. The config is loaded again. Missing config or `autoJoin === false` ends auto-join.
6. Otherwise `run({ action: "join", ... }, context)` calls `A2aOperations.execute`.
7. Join calls `HubClient.register` (or `heartbeat` for the same identity), stores membership, and calls `listMembers`.
8. `membershipChanged: "joined"` causes `startBackground` to install heartbeat and inbox timers.

### Active-session background flow

- Every `HEARTBEAT_MS` (5 seconds), `A2aOperations.heartbeat` calls `HubClient.heartbeat` for the current membership. Failures are logged.
- Every second, the inbox timer calls `A2aOperations.receive` unless a prior poll is active.
- `receive` calls `HubClient.readInbox`, invokes the supplied delivery callback for each envelope in order, then calls `HubClient.ack` for that message.
- A `delivery_receipt` becomes an informational UI notification.
- A message envelope goes through `injectEnvelope` to `pi.sendMessage` as custom type `a2a-inbound`, with `triggerTurn: true`. Delivery is `"followUp"` while the agent is idle and `"steer"` otherwise.

### Interactive command and tool flow

- `/a2a` input passes through `parseArgs` and `commandRequest`, then through `run` to `A2aOperations.execute`. Results are shown through `context.ui.notify`; parsing and operation errors become error notifications.
- The registered `a2a` tool validates a structured Zod object, builds the same `A2aOperationRequest`, and uses the same `run` function. It returns result text and details, or an `isError` tool result.
- Supported operations are `project_create`, `project_delete`, `project_list`, `join`, `leave`, `list`, `status`, `send`, `inbox`, and `hub`. The command also accepts `help`; its parser maps the same operational set from command syntax.

### Leave and shutdown

- Explicit join or leave first stops existing timers.
- Leave copies and clears local membership before calling `HubClient.unregister`. If unregister fails, it returns `cleanupPending: true` and relies on Hub lease expiry rather than restoring local membership.
- `session_shutdown` stops background work and executes leave. A shutdown leave failure is logged.

## Data and Control Flow

### Project operations

- Create: request → `A2aOperations.execute` → `HubClient.createProject` → Hub HTTP server → `registry.createProject` → project metadata JSON.
- Delete: request → `HubClient.deleteProject` → `registry.deleteProject`. Deletion returns `false` for a missing project and throws `RegistryConflictError` while any member is online or stale.
- List: `HubClient.listProjects` returns project metadata; `A2aOperations` calls `listMembers` for every project in parallel and reports each online count.

### Membership operations

- Join: validate request → optionally unregister the previous identity → `HubClient.register` → Hub server → `registry.joinProject` → member JSON → retain `{ project, agentId }` locally → list online members.
- Rejoining the same identity does not re-register; it calls `HubClient.heartbeat`.
- Registry join rejects an already-online identity with `RegistryConflictError`, but permits takeover of an offline or stale stored identity by writing a fresh member record.
- Heartbeat rewrites `lastSeenAt` and `status: "online"`; a member explicitly stored as offline cannot heartbeat.
- Registry leave preserves the member record but writes `status: "offline"` and a new `lastSeenAt`.
- `listMembers` returns only online members by default; `all` includes stale and offline members. Results are sorted by `agentId`.

### Messaging operations

- Send requires a membership, non-self recipient, and non-empty text. It forwards optional `messageId`, `replyTo`, and `replyToRef` to `HubClient.send`.
- The returned queued envelope supplies `msgId`, optional agent-friendly `messageRef`, and causal reply metadata. `ASYNC_REPLY_GUIDANCE` tells callers not to wait or poll for replies because the extension injects inbound work.
- Manual inbox inspection calls `HubClient.readInbox`, formats messages and delivery receipts, and acknowledges the returned message IDs as one batch. `receive` instead delivers and acknowledges each envelope sequentially.

### Configuration flow

`loadLocalConfig(cwd)` checks `localConfigCandidates` in this order:

1. `.omp/a2a.yml`
2. `.omp/a2a.yaml`
3. `.omp/a2a.json`

The first existing file wins. JSON uses `JSON.parse`; YAML uses the private `parseSimpleYaml`, which supports scalar keys, inline arrays, and one-level dash lists. `normalizeConfig`:

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

Reads return `null` for missing, unreadable, or invalid JSON. `refreshMember` derives presence without rewriting the file: non-offline records become stale after `STALE_MS` and offline after `OFFLINE_MS`; records already marked offline remain offline.

## Direct File Map

### `extension.ts`

**Responsibility:** OMP extension adapter and lifecycle owner.

**Principal export:**

- default `a2aExtension(pi: ExtensionAPI)`.

**Important private functions:**

- `parseArgs` splits command text into positional arguments and `--key`, `--key=value`, or boolean flags.
- `usage` builds command help text.
- `commandRequest` validates command syntax and translates it to `A2aOperationRequest`.
- Inside `a2aExtension`: `refreshHubUrl`, `ensureClient`, `stopBackground`, `injectEnvelope`, `startBackground`, and `run` coordinate connection, delivery, and timers.

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

**Responsibility:** Discovery, parsing, normalization, and validation of repository-local A2A configuration.

**Principal export:**

- `loadLocalConfig(cwd: string): A2aLocalConfig | null`.

**Dependencies:** Node `fs`, `localConfigCandidates`, `A2aLocalConfig`, `PROJECT_NAME_RE`, and `AGENT_ID_RE`. It is consumed by `extension.ts`.

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

- Error: `RegistryConflictError`.
- Project API: `createProject`, `deleteProject`, `getProject`, `listProjects`.
- Member API: `readMember`, `listMembers`, `joinProject`, `heartbeat`, `leaveProject`.
- Presentation/diagnostic helpers: `formatMembersTable`, `hostnameHint`.
- Re-exported path helpers: `projectDir`, `projectsRoot`.

**Dependencies:** Node `fs`, `os`, and `path`; storage helpers from `paths.ts`; contracts and constants from `types.ts`.

**Consumer:** `src/hub/server.ts` imports the registry's project and membership operations plus `RegistryConflictError` to implement its HTTP endpoints.

## Hub Integration Boundary

Direct `src/*.ts` modules interact with `src/hub/**` in both directions:

- `extension.ts` imports `HubClient` and `resolveHubUrl` from `hub/client.ts`, plus `HubEnvelope` and `HubMessageEnvelope` from `hub/types.ts`.
- `operations.ts` accepts a lazy `HubClient` provider and uses Hub envelope and metadata types. Its client calls cover project CRUD/listing, registration, heartbeat, unregister, member listing, send, inbox read/ack, and metadata.
- `hub/client.ts` imports `a2aRoot` from `paths.ts` to resolve global Hub configuration and imports `A2aMember`/`A2aProject` from `types.ts` for its public responses.
- `hub/server.ts` imports the registry API and runtime/storage paths to connect HTTP requests to persistent project/member state.
- `hub/data-lock.ts` and `hub/inbox.ts` import `ensureDir`; `hub/message-ref.ts` imports `AGENT_ID_RE`.

This boundary keeps the extension and operation dispatcher HTTP-client-facing, while the standalone Hub server is the consumer of the direct modules' local persistence API.
