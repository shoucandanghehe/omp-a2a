# Hub Atlas

## Responsibility

`src/hub/` implements the private versioned protocol and all Hub-owned runtime and persistent state:

- HTTP Project administration and explicit history;
- WebSocket Presence, realtime messages, and delivery outcomes;
- versioned SQLite Project metadata, sequence, and append-only message history;
- functional payload encoding, decoding, and structural validation without application resource caps;
- exclusive data-directory ownership and process lifecycle.

## Module map

| File | Responsibility | Primary interface |
| --- | --- | --- |
| `cli.ts` | Parse command/environment settings, start one Hub, and shut down on signals. | executable entry |
| `server.ts` | Express routes, explicit HTTP listener lifecycle, storage ownership, and WebSocket attachment. | `startHubServer`, `HubServerHandle` |
| `realtime-server.ts` | Upgrade handling, handshake, Presence events, routing, delivery tracking, heartbeat, and shutdown. | `RealtimeHub` |
| `connection.ts` | Extension-side WebSocket protocol client. | `A2aConnection`, `A2aConnectionEvents` |
| `presence.ts` | In-memory Project/name/socket indexes. | `PresenceRegistry`, `Presence` |
| `store.ts` | Versioned SQLite Project metadata, sequences, Messages, history, atomic deletion, idempotency, and fail-closed schema guard. | `HubStore` |
| `client.ts` | Hub URL resolution and HTTP meta/Project/history client. | `HubClient`, `connectHub`, `resolveHubUrl` |
| `realtime-types.ts` | Versioned WebSocket frames, canonical realtime Message decoding, public realtime/history shapes, message identifiers, and canonical references. | protocol types, `decodeRealtimeMessage`, `A2A_PROTOCOL_VERSION`, message reference helpers |
| `payload.ts` | Exact payload/attachment wire parsing, canonical Base64 decoding, structural attachment-name validation, and text/binary codecs. | codecs, `parseEncodedAttachments`, `validateAttachmentName` |
| `data-lock.ts` | Exclusive ownership of one Hub data directory. | `HubDataLock` |
| `types.ts` | Minimal Hub protocol metadata plus encoded text, binary, and attachment values. | `HubMeta`, encoded payload types |

## HTTP surface

`server.ts` configures Express JSON parsing without an application byte limit; deployment memory and container limits own resource isolation.

| Method and path | Behavior |
| --- | --- |
| `GET /healthz` | Exactly `{ok:true,service:"omp-a2a-hub"}`. |
| `GET /v1/meta` | Exactly `{protocolVersion}` for compatibility checks. |
| `GET /v1/projects` | Sorted persistent Project list. |
| `POST /v1/projects` | Create Project metadata; duplicate returns `409`. |
| `DELETE /v1/projects/:name` | Reject active Presence, then atomically remove metadata, sequence, and complete history. |
| `GET /v1/history` | Query one existing Project by cursor, sender name, and any explicit positive integer limit. |
| `GET /v1/connect` upgrade | Hand the socket to `RealtimeHub`. |

Neither public response contains a route, PID, port, start time, or data-directory detail. Clients retain their resolved configuration URL as the authoritative HTTP and WebSocket route.

## WebSocket protocol

`A2A_PROTOCOL_VERSION` is `3`.

### Handshake

1. A new socket must send `hello`; the client waits at most 5 seconds by default and may cancel through a caller `AbortSignal`.
2. The frame supplies protocol version, Project, and temporary name.
3. The Hub verifies the Project and protocol, then claims the name in `PresenceRegistry`.
4. The claimant receives `claimed` with a new `presenceId` and current peer snapshot.
5. Existing peers receive `presence_joined`.

Handshake failure, timeout, or cancellation terminates the unpublished socket and waits for its close before returning. The first settled handshake outcome remains authoritative through teardown: caller cancellation preserves its exact reason only when abort wins, and a later abort cannot replace a timeout, protocol, or transport failure. Lifecycle timeout overrides must be finite, positive, and no greater than the 5-second handshake, 1-second goodbye, and 2-second close bounds; invalid or over-limit options reject before opening a socket. One socket can claim one name. One name can be held by one current socket inside a Project. A duplicate fails with `name_in_use`; it never replaces the owner.

### Message request

The client sends `message` with `requestId`, opaque `messageId`, a non-empty target name list or `["@all"]`, encoded text payload, ordered encoded attachments, and optional `replyTo`.

- A repeated, content-identical `messageId` returns the canonical stored Message as `replayed: true` without resolving or enumerating Presence and without delivery. Target names are canonicalized to a sorted unique set before comparison.
- A new named target resolves every name and binds each resolved `presenceId` before persistence; any missing name, the sender's own name, an empty list, a duplicate, or mixing `@all` with names fails before persistence.
- A new `@all` target is validated and atomically persisted before `PresenceRegistry` is enumerated exactly once into a local array excluding the sender.
- `HubStore` validates the Project row, exact text and attachment wire shapes, canonical Base64, valid unique attachment basenames, decoded gzip data, and causal references, then atomically commits one immutable Message—including attachments—and the next Project sequence.
- New acceptance sends `accepted` with `replayed: false`, the canonical Message, and selected recipient names. Replay sends `replayed: true` with no recipients field.
- The Hub loops over the local array and immediately enqueues the canonical `message` frame to each concrete socket. Recipient arrays are never persisted.

The client waits 15 seconds by default for `accepted` or request-scoped `error`; a timeout override must be finite, positive, and no greater than 15 seconds or it rejects before dispatch. Caller abort before dispatch sends no frame. After dispatch, abort, timeout, or transport close reports that acceptance and Delivery outcomes are unknown, removes the request, ignores late replies, and never retries.

### Delivery

The Hub owns exactly one in-memory pending record per `(messageId, recipientPresenceId)`. It stores the original sender socket and selected recipient socket/Presence for at most two seconds. The Message frame is written once. A receiver `delivered` or `delivery_failed` frame terminalizes the record; a write callback error, recipient departure, or ACK timeout reports `failed` with an explicit unconfirmed reason.

Receiver `A2aConnection` processes distinct Message frames serially in Project sequence, invokes `onMessage` once per frame, and immediately returns `delivered` or `delivery_failed`. It keeps no duplicate cache because the Hub never retries.

`delivered` proves attachment materialization and injection into the receiving OMP extension. `failed` records either an explicit receiver failure or an unconfirmed write, disconnect, or timeout. Because an ACK can be lost after successful injection, unconfirmed failure does not prove the receiver missed the Message. Neither result proves model comprehension or task completion.

Receiver result, either Presence leaving, graceful goodbye, heartbeat cleanup, the ACK timeout, and Hub shutdown clear the pending record at most once. Sender departure deletes its records silently. A same-named reconnect never inherits a record, and Hub restart retains history without resuming delivery.

### Presence lifetime

Graceful client close sends one exact `goodbye`. The Hub queues its acknowledgement, atomically removes the Presence, cleans related Delivery entries, broadcasts one `presence_left`, and then starts its own bounded transport close/termination. The client waits at most 1 second for the acknowledgement, begins WebSocket close, and terminates after at most another 2 seconds if close stalls. Native close and that deadline enter one idempotent client finalizer for pending requests, the goodbye barrier, `onClose`, and the shared close Promise. A deadline with no native close reports abnormal code `1006` and its timeout reason; any later native close is ignored. Presence release is distinct from transport teardown, so the name can be reused while the old socket is still closing. Concurrent close calls share this one flow. An unpublished socket terminates directly.

Legacy transport close and heartbeat timeout enter the same idempotent Hub release path, so a later close callback cannot repeat Presence or Delivery events. Hub shutdown clears all remaining Presence and Delivery state with the distinct `hub_shutdown` reason.

Presence and Delivery events are realtime-only and never enter `HubStore`.

## PresenceRegistry invariants

`PresenceRegistry` keeps two synchronized indexes:

```text
Project -> name -> Presence
WebSocket -> Presence
```

`claim`, `remove`, and `close` are the only state transitions. A `Presence` contains Project, temporary name, random `presenceId`, socket, and connection timestamp. No member file, offline state, stale state, lease, or cursor exists.

## HubStore invariants

`HubStore` owns `<dataDir>/messages.sqlite` with WAL and `synchronous = FULL`. It is the only production owner of durable Project metadata, Project sequences, and Messages.

### Durable facts

- one Project row containing `name`, optional display metadata, creation time, and optional creator cwd;
- one monotonically increasing sequence per Project;
- one immutable message row per accepted message;
- globally idempotent `messageId` content comparison;
- sender name and accepting `presenceId`;
- the target name list or `@all`, including resolved target Presences for named targets;
- canonical encoded text and ordered attachment names/content;
- creation timestamp and optional same-Project causal parent sequence.

Project recipient arrays, pending ACK records, and Delivery events are not durable facts.

Message references use `<project>:<sequence>`. Parsing rejects invalid Project names, non-positive/unsafe sequences, and cross-Project history cursors.

### Project lifecycle

Project create/get/list/delete are synchronous store operations. Listing preserves name sorting. `deleteProject` uses one `BEGIN IMMEDIATE` transaction to delete Messages, Project sequence, and metadata, returning whether the Project existed. A failure in any delete statement rolls back all three. Recreating the name therefore starts with sequence `1` and empty history.

`server.ts` rejects deletion while `RealtimeHub` reports an active Presence. Both claim and delete consult this store fact synchronously without a second blocked/deleted set: claim-first rejects deletion, and delete-first rejects claim as an unknown Project.

### History

`history` supports:

- `before` or `after`, never both;
- optional exact sender-name filter;
- a default 50-item page or any explicit positive integer limit;
- deterministic Project-sequence ordering.

### Idempotency and causality

Reusing `messageId` with the same Project, sender name, target kind/names, text encoding/data, ordered attachment names/encoding/data, and causal parent returns the canonical stored Message with `replayed: true`. A difference in any compared field raises `MessageIdConflictError`.

`replyTo` must resolve to an existing message in the same Project or `UnknownReplyTargetError` is raised.

### Storage schema

`messages.sqlite` carries `MESSAGE_STORAGE_VERSION`, which is independent of `A2A_PROTOCOL_VERSION`. A new database creates both current tables, the sender-history index, and the storage version in one transaction.

Opening an existing database requires the exact current storage version and the complete, exclusive set of current non-internal tables and indexes. Any missing, changed, or unexpected schema object fails startup with `unsupported pre-release storage; start with an empty data directory`; no schema conversion or fallback runs. SQLite-owned autoindexes remain valid.

## Payload codec

- Text `< 32 KiB`: `{ encoding: "identity", data }`.
- Larger text: gzip plus Base64 only when smaller, otherwise identity.
- Attachment bytes: Base64, optionally gzip-compressed only when smaller.
- Payloads carry no derived byte metadata or application resource bounds; Base64 decoding rejects invalid and noncanonical input by canonical re-encoding.
- Express JSON parsing and both WebSocket endpoints are configured without an application payload cap.
- Matching private-protocol clients are trusted for resource use, not structural validity; malformed payloads fail loudly and deployment limits own resource isolation.

## HTTP client

`resolveHubUrl` precedence is explicit argument, then the first existing global config. Missing configuration fails explicitly. That resolved URL remains authoritative for HTTP and WebSocket connections; `HubClient` strictly decodes only `protocolVersion` from metadata and never replaces its `baseUrl`. Existing malformed global configuration fails immediately. `probeHub` uses a 1.5-second metadata deadline: only a classified `HubTransportError` means unavailable, while expiry propagates the named deadline error.

`HubClient` gives metadata, Project CRUD, and history requests a 15-second default deadline, composes caller cancellation with that deadline, and keeps the bound active through response-body reading. Fetch and body network failures become `HubTransportError` only after cancellation and deadline expiry are ruled out. One request/JSON seam preserves non-2xx status and URL details, then operation-specific decoders require exact response shapes. History snapshots its query before dispatch and verifies ordering, canonical references, and causal references. Requests are not retried. Realtime operations belong to `A2aConnection`; server routes and realtime claims use the same `HubStore`.

`cli.ts` alone resolves `--host`, `--port`, and `--data-dir` with flag → environment → default precedence, rejecting a selected blank value; direct `startHubServer` calls supply all three explicitly and never read the environment. The CLI readiness line reports status, service, and `A2A_PROTOCOL_VERSION` but no listener URL.

## Data-directory lifecycle

`startHubServer`:

1. validates its explicit host, port, and data directory;
2. acquires `HubDataLock` through an exclusive SQLite transaction;
3. opens `HubStore`, creating or validating the complete current versioned schema;
4. starts Express and attaches `RealtimeHub` to the same HTTP server;
5. returns a handle containing only the loopback-reachable `listenUrl` and an idempotent `stop`.

`HubDataLock` is the only runtime ownership record. No Hub JSON or PID metadata files are written. Startup failure and every concurrent `stop` call reuse one cleanup Promise. Cleanup attempts every acquired resource in reverse order, retains the first error, and releases realtime sockets, the HTTP listener, `HubStore`, and the directory lock.

## Test coverage

- `hub-realtime.test.ts`: bounded/cancellable handshake and teardown, exact goodbye ordering, Project claims, persist-before-enumerate routing, replay without redelivery, one-shot Delivery acknowledgement/failure cleanup, attachment persistence, large same-version payload/attachment-count paths, and restart.
- `message-store.test.ts`: Project CRUD/reopen/sorting, atomic delete rollback, ordering, idempotency, causality, cursor/filter/default/explicit-limit behavior, current schema creation/reopen, fail-closed guards, integrity, and deletion.
- `hub-control.test.ts`: minimal metadata/health, authoritative configured URLs, explicit/wildcard listeners, CLI parsing/executability, deployment limits, independent Hubs, uncapped HTTP request bodies, claim/delete ordering, active-Presence rejection with unchanged history, storage startup rejection, cleanup, and concurrent stop.
- `payload.test.ts`: identity/gzip/Base64 round trips, compression choice, uncapped attachment parsing, exact wire shapes, safe unique names, and malformed codec failures.
- `operations.test.ts`: client/runtime integration, HTTP caller cancellation, pre-dispatch message cancellation, strong new/replayed acceptance, and successful/failed Delivery callbacks.
- `hub-client.test.ts`: HTTP header/body deadlines, caller cancellation, error preservation, successful-response decoding, probe classification, and history wire validation.

See `scripts/codemap.md` for executable boundary scenarios.
