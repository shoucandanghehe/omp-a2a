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
| `server.ts` | Express routes, HTTP server, runtime metadata, canonical store lifecycle, and WebSocket attachment. | `startHubServer`, `HubServerHandle` |
| `realtime-server.ts` | Upgrade handling, handshake, Presence events, routing, delivery tracking, heartbeat, and shutdown. | `RealtimeHub` |
| `connection.ts` | Extension-side WebSocket protocol client. | `A2aConnection`, `A2aConnectionEvents` |
| `presence.ts` | In-memory Project/name/socket indexes. | `PresenceRegistry`, `Presence` |
| `store.ts` | Versioned SQLite Project metadata, sequences, Messages, history, atomic deletion, idempotency, and fail-closed schema guard. | `HubStore` |
| `client.ts` | Hub URL resolution and HTTP meta/Project/history client. | `HubClient`, `connectHub`, `resolveHubUrl` |
| `realtime-types.ts` | Versioned WebSocket frames, public realtime/history shapes, message identifiers, and canonical references. | protocol types, `A2A_PROTOCOL_VERSION`, message reference helpers |
| `payload.ts` | Exact payload/attachment wire parsing, canonical Base64 decoding, structural attachment-name validation, and text/binary codecs. | codecs, `parseEncodedAttachments`, `validateAttachmentName` |
| `data-lock.ts` | Exclusive ownership of one Hub data directory. | `HubDataLock` |
| `types.ts` | Hub metadata plus encoded text, binary, and attachment values. | `HubMeta`, encoded payload types |

## HTTP surface

`server.ts` configures Express JSON parsing without an application byte limit; deployment memory and container limits own resource isolation.

| Method and path | Behavior |
| --- | --- |
| `GET /healthz` | Health plus current `HubMeta`. |
| `GET /v1/meta` | Protocol, URL, process, start time, and data directory metadata. |
| `GET /v1/projects` | List persistent Projects in deterministic name order. |
| `POST /v1/projects` | Create Project metadata; duplicate returns `409`. |
| `DELETE /v1/projects/:name` | Reject active Presence, then atomically remove metadata, sequence, and complete history. |
| `GET /v1/history` | Query one existing Project by cursor, sender name, and any explicit positive integer limit. |
| `GET /v1/connect` upgrade | Hand the socket to `RealtimeHub`. |

The public `baseUrl` reported in Hub metadata can differ from the listen host. Clients retain their resolved configuration URL as the authoritative HTTP and WebSocket route.

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

The client sends `message` with `requestId`, opaque `messageId`, typed target, encoded text payload, ordered encoded attachments, and optional `replyTo`.

- A repeated, content-identical `messageId` returns the canonical stored Message as `replayed: true` without resolving or enumerating Presence and without delivery.
- A new direct target resolves the current name and binds its `presenceId` before persistence; a missing target fails before persistence.
- A new Project target is validated and atomically persisted before `PresenceRegistry` is enumerated exactly once into a local array excluding the sender.
- `HubStore` validates the Project row, exact text and attachment wire shapes, canonical Base64, valid unique attachment basenames, decoded gzip data, and causal references, then atomically commits one immutable Message—including attachments—and the next Project sequence.
- New acceptance sends `accepted` with `replayed: false`, the canonical Message, and selected recipient names. Replay sends `replayed: true` with no recipients field.
- The Hub loops over the local array and immediately enqueues the canonical `message` frame to each concrete socket. Recipient arrays are never persisted.

The client waits 15 seconds by default for `accepted` or request-scoped `error`; a timeout override must be finite, positive, and no greater than 15 seconds or it rejects before dispatch. Caller abort before dispatch sends no frame. After dispatch, abort, timeout, or transport close reports that acceptance and Delivery outcomes are unknown, removes the request, ignores late replies, and never retries.

### Delivery

The Hub owns exactly one in-memory pending record per `(messageId, recipientPresenceId)`. It stores the original sender socket, original recipient socket and Presence, attempt count, one timer, and a terminal guard. A WebSocket write callback error or delivery ACK timeout retries the same frame only while that socket still owns that Presence. The default policy permits three attempts, with a two-second ACK window and a fixed 100 ms transport-error delay. `RealtimeHub` validates overrides before opening WebSocket or timer resources: attempts must be a finite positive integer no greater than three, and the ACK timeout must be finite, positive, no greater than two seconds, and bounded by the receiver outcome lifetime. Only scheduling is injectable for deterministic timer tests.

Receiver `A2aConnection` coalesces duplicate `messageId` frames with one in-flight Promise or a terminal outcome cache retained for 10 seconds. Completion order is expiry order, so one timer targets the earliest entry and amortizes cleanup while idle; socket close cancels that timer and clears the cache. Project sequence order remains serial, `onMessage` runs once, and each retry re-sends the cached `delivered` or `delivery_failed` frame. `delivery_failed` is terminal; no error-string retry classification exists.

`delivered` proves attachment materialization and injection into the receiving OMP extension. `failed` records an explicit terminal receiver failure. `disconnected` means the bound recipient Presence left. `unknown` means the finite attempt budget ended without a conclusive ACK or the transport write dispatch result remained uncertain. None proves model comprehension or task completion.

Receiver result, either Presence leaving, graceful goodbye, heartbeat cleanup, and Hub shutdown all cancel the one timer and terminalize the record at most once. Sender departure deletes its records silently. Recipient departure reports `disconnected` to a still-current sender. A same-named reconnect never inherits the record, and Hub restart retains history without resuming delivery.

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
- direct/Project target, including resolved target Presence for direct messages;
- canonical encoded text and ordered attachment names/content;
- creation timestamp and optional same-Project causal parent sequence.

Project recipient arrays, pending Delivery, retry attempts, outcome caches, and terminal events are not durable facts.

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

Reusing `messageId` with the same Project, sender name, target kind/name, text encoding/data, ordered attachment names/encoding/data, and causal parent returns the canonical stored Message with `replayed: true`. A difference in any compared field raises `MessageIdConflictError`.

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

`resolveHubUrl` precedence is explicit argument, environment, first existing global config, then loopback default. That resolved URL remains authoritative for HTTP and WebSocket connections; Hub metadata validates protocol compatibility without replacing it. Existing malformed global configuration fails immediately. `probeHub` uses a 1.5-second metadata deadline: only a classified `HubTransportError` means unavailable, while expiry propagates the named deadline error.

`HubClient` gives metadata, Project CRUD, and history requests a 15-second default deadline, composes caller cancellation with that deadline, and keeps the bound active through response-body reading. Fetch and body network failures become `HubTransportError` only after cancellation and deadline expiry are ruled out. One request/JSON seam preserves non-2xx status and URL details, then operation-specific decoders require exact response shapes. History snapshots its query before dispatch and verifies ordering, canonical references, and causal references. Requests are not retried. Realtime operations belong to `A2aConnection`; server routes and realtime claims use the same `HubStore`.

## Data-directory lifecycle

`startHubServer`:

1. resolves and creates the data directory;
2. acquires `HubDataLock` through an exclusive SQLite transaction;
3. opens `HubStore`, creating or validating the complete current versioned schema;
4. starts Express and attaches `RealtimeHub` to the same HTTP server;
5. writes `run/hub.json` and `run/hub.pid` atomically;
6. returns the shared cleanup function as `stop`.

Startup failure and every concurrent `stop` call reuse one cleanup Promise. Cleanup attempts each acquired resource in reverse order, retains the first error, and consistently releases runtime metadata, realtime sockets, the HTTP listener, `HubStore`, and the directory lock.

## Test coverage

- `hub-realtime.test.ts`: bounded/cancellable handshake and teardown, exact goodbye ordering, Project claims, persist-before-enumerate routing, replay without redelivery, same-Presence retries, receiver deduplication, terminal Delivery cleanup, attachment persistence, large same-version payload/attachment-count paths, and restart.
- `message-store.test.ts`: Project CRUD/reopen/sorting, atomic delete rollback, ordering, idempotency, causality, cursor/filter/default/explicit-limit behavior, current schema creation/reopen, fail-closed guards, integrity, and deletion.
- `hub-control.test.ts`: independent Hubs, uncapped HTTP request bodies, claim/delete ordering, active-Presence rejection with unchanged history, storage startup rejection, cleanup, and concurrent stop.
- `payload.test.ts`: identity/gzip/Base64 round trips, compression choice, uncapped attachment parsing, exact wire shapes, safe unique names, and malformed codec failures.
- `operations.test.ts`: client/runtime integration, HTTP caller cancellation, pre-dispatch message cancellation, strong new/replayed acceptance, and successful/failed Delivery callbacks.
- `hub-client.test.ts`: HTTP header/body deadlines, caller cancellation, error preservation, successful-response decoding, probe classification, and history wire validation.

See `scripts/codemap.md` for executable boundary scenarios.
