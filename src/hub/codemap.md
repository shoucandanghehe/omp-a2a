# Hub Atlas

## Responsibility

`src/hub/` implements the private versioned protocol and all Hub-owned runtime and persistent state:

- HTTP Project administration and explicit history;
- WebSocket Presence, realtime messages, and delivery outcomes;
- append-only SQLite Project history and legacy migration;
- payload encoding limits;
- exclusive data-directory ownership and process lifecycle.

## Module map

| File | Responsibility | Primary interface |
| --- | --- | --- |
| `cli.ts` | Parse command/environment settings, start one Hub, and shut down on signals. | executable entry |
| `server.ts` | Express routes, HTTP server, metadata files, storage lifecycle, and WebSocket attachment. | `startHubServer`, `HubServerHandle` |
| `realtime-server.ts` | Upgrade handling, handshake, Presence events, routing, delivery tracking, heartbeat, and shutdown. | `RealtimeHub` |
| `connection.ts` | Extension-side WebSocket protocol client and peer/request state. | `A2aConnection`, `A2aConnectionEvents` |
| `presence.ts` | In-memory Project/name/socket indexes. | `PresenceRegistry`, `Presence` |
| `messages.ts` | SQLite append-only message log, history queries, idempotency, references, deletion, and migration. | `MessageStore` |
| `client.ts` | Hub URL resolution and HTTP meta/Project/history client. | `HubClient`, `connectHub`, `resolveHubUrl` |
| `realtime-types.ts` | Versioned WebSocket frames and public realtime/history shapes. | protocol types, `A2A_PROTOCOL_VERSION` |
| `payload.ts` | Text/binary encoding, attachment validation, and bounded decoded-content accounting. | text/binary codecs, `validateMessageContent` |
| `data-lock.ts` | Exclusive ownership of one Hub data directory. | `HubDataLock` |
| `types.ts` | Hub metadata plus encoded text, binary, and attachment values. | `HubMeta`, encoded payload types |

## HTTP surface

`server.ts` creates one Express app with a 6 MiB JSON body cap.

| Method and path | Behavior |
| --- | --- |
| `GET /healthz` | Health plus current `HubMeta`. |
| `GET /v1/meta` | Protocol, URL, process, start time, and data directory metadata. |
| `GET /v1/projects` | Sorted persistent Project list. |
| `POST /v1/projects` | Create Project metadata; duplicate returns `409`. |
| `DELETE /v1/projects/:name` | Reject active Presence, remove Project metadata, then delete message history. |
| `GET /v1/history` | Query one existing Project by cursor, sender name, and bounded limit. |
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
- Text, attachment structure/content, total decoded size, and causal references are validated by `MessageStore`.
- `MessageStore.append` atomically commits one immutable Message—including attachments—and the next Project sequence.
- New acceptance sends `accepted` with `replayed: false`, the canonical Message, and selected recipient names. Replay sends a distinct `replayed: true` shape with no recipients field.
- The Hub loops over the local array and immediately enqueues the canonical `message` frame to each concrete socket. Recipient arrays are never persisted.

The client waits 15 seconds by default for `accepted` or request-scoped `error`; a timeout override must be finite, positive, and no greater than 15 seconds or it rejects before dispatch. A caller abort before dispatch sends no frame. After `socket.send` succeeds, caller abort, timeout, or transport close reports ordinary error text that acceptance and Delivery outcomes are unknown, removes the request, ignores late replies, and never retries.

### Delivery

The Hub owns exactly one in-memory pending record per `(messageId, recipientPresenceId)`. It stores the original sender socket, original recipient socket and Presence, attempt count, one timer, and a terminal guard. A WebSocket write callback error or delivery ACK timeout retries the same frame only while that socket still owns that Presence. The default policy permits three attempts, with a two-second ACK window and a fixed 100 ms transport-error delay. `RealtimeHub` validates overrides before opening WebSocket or timer resources: attempts must be a finite positive integer no greater than three, and the ACK timeout must be finite, positive, no greater than two seconds, and bounded by the receiver outcome lifetime. Only scheduling is injectable for deterministic timer tests.

Receiver `A2aConnection` coalesces duplicate `messageId` frames with one in-flight Promise or a terminal outcome cache retained for 10 seconds. Completion order is expiry order, so one timer targets the earliest entry and amortizes cleanup while idle; socket close cancels that timer and clears the cache. Project sequence order remains serial, `onMessage` runs once, and each retry re-sends the cached `delivered` or `delivery_failed` frame. `delivery_failed` is terminal; no error-string retry classification exists.

`delivered` proves attachment materialization and injection into the receiving OMP extension. `failed` records an explicit terminal receiver failure. `disconnected` means the bound recipient Presence left. `unknown` means the finite attempt budget ended without a conclusive ACK or the transport write dispatch result remained uncertain. None proves model comprehension or task completion.

Receiver result, either Presence leaving, graceful goodbye, heartbeat cleanup, and Hub shutdown all cancel the one timer and terminalize the record at most once. Sender departure deletes its records silently. Recipient departure reports `disconnected` to a still-current sender. A same-named reconnect never inherits the record, and Hub restart retains history without resuming delivery.

### Presence lifetime

Graceful client close sends one exact `goodbye`. The Hub queues its acknowledgement, atomically removes the Presence, cleans related Delivery entries, broadcasts one `presence_left`, and then starts its own bounded transport close/termination. The client waits at most 1 second for the acknowledgement, begins WebSocket close, and terminates after at most another 2 seconds if close stalls. Native close and that deadline enter one idempotent client finalizer for pending requests, the goodbye barrier, `onClose`, and the shared close Promise. A deadline with no native close reports abnormal code `1006` and its timeout reason; any later native close is ignored. Presence release is distinct from transport teardown, so the name can be reused while the old socket is still closing. Concurrent close calls share this one flow. An unpublished socket terminates directly.

Legacy transport close and heartbeat timeout enter the same idempotent Hub release path, so a later close callback cannot repeat Presence or Delivery events. Hub shutdown clears all remaining Presence and Delivery state with the distinct `hub_shutdown` reason.

Presence events are realtime-only and never enter `MessageStore`.

## PresenceRegistry invariants

`PresenceRegistry` keeps two synchronized indexes:

```text
Project -> name -> Presence
WebSocket -> Presence
```

`claim`, `remove`, and `close` are the only state transitions. A `Presence` contains Project, temporary name, random `presenceId`, socket, and connection timestamp. No member file, offline state, stale state, lease, or cursor exists.

## MessageStore invariants

`MessageStore` owns `<dataDir>/messages.sqlite` with WAL and `synchronous = FULL`.

### Durable facts

- one monotonically increasing sequence per Project;
- one immutable message row per accepted message;
- globally idempotent `messageId` content comparison;
- sender name and accepting `presenceId`;
- direct/Project target, including resolved target Presence for direct messages;
- encoded text, ordered attachment names/content, and total decoded-content bytes;
- creation timestamp and optional same-Project causal parent sequence.

Project recipient arrays, pending Delivery, retry attempts, outcome caches, and terminal events are not durable facts.

Message references use `<project>:<sequence>`. Parsing rejects invalid Project names, non-positive/unsafe sequences, and cross-Project history cursors.

### History

`history` supports:

- `before` or `after`, never both;
- optional exact sender-name filter;
- positive bounded item limit;
- deterministic Project-sequence ordering;
- a 4 MiB cumulative decoded-content budget, including attachments, per history page.

### Idempotency and causality

Reusing `messageId` with the same Project, sender name, target kind/name, text encoding/data/size, ordered attachment names/encoding/data/size, and causal parent returns the canonical stored Message with `replayed: true`. A difference in any compared field raises `MessageIdConflictError`.

`replyTo` must resolve to an existing message in the same Project or `UnknownReplyTargetError` is raised.

### Legacy migration

When `messages.sqlite` is first created and old `inbox.sqlite` exists, ordinary `message_ledger` rows are imported in deterministic `(project, created_at, msg_id)` order. Delivery-receipt rows are excluded. Old pending messages become history only; no old Presence, recipient cursor, ACK, receipt, or offline-delivery state survives.

Opening a protocol version `2` `messages.sqlite` adds attachment JSON and total decoded-content columns in place. Existing rows receive `attachments = []` and `content_bytes = uncompressed_bytes`.

Migration runs in the new database transaction and validates imported row count plus `PRAGMA integrity_check`. The old database is not modified.

## Payload codec

- Text `< 32 KiB`: `{ encoding: "identity", data, uncompressedBytes }`.
- Larger text: gzip bytes encoded as Base64.
- Attachment bytes: Base64, optionally gzip-compressed first when smaller.
- At most eight attachments per Message.
- Text plus attachments `> 4 MiB`: rejected before persistence.
- gzip decode uses `maxOutputLength`, and decoded byte counts must match their metadata.
- The WebSocket server caps a complete frame at 6 MiB.

## HTTP client

`resolveHubUrl` precedence is explicit argument, environment, first existing global config, then loopback default. That resolved URL remains authoritative for HTTP and WebSocket connections; Hub metadata validates protocol compatibility without replacing it. Existing malformed global configuration fails immediately. `probeHub` uses a 1.5-second timeout; ordinary `HubClient` operations currently have no default deadline.

`HubClient` exposes only metadata, Project CRUD, and history. Realtime operations belong to `A2aConnection`.

## Data-directory lifecycle

`startHubServer`:

1. resolves and creates the data directory;
2. acquires `HubDataLock` through an exclusive SQLite transaction;
3. opens `MessageStore`, optionally migrating legacy Inbox history;
4. starts Express and attaches `RealtimeHub` to the same HTTP server;
5. writes `run/hub.json` and `run/hub.pid` atomically;
6. returns an idempotent `stop` closure.

Stop closes realtime clients, the HTTP server, message storage, metadata files, and the directory lock. Startup failures unwind already-opened resources.

## Test coverage

- `hub-realtime.test.ts`: bounded/cancellable handshake with winning-failure preservation, maximum-validated lifecycle and retry overrides, exact goodbye frames and ordering, separately bounded client/server teardown against normal and TCP-proxied nonresponsive peers, concurrent close, Presence release and name reuse before transport teardown, message request cancellation/timeout and late replies, rejected encoding failures, persist-before-enumerate broadcast routing, replay without redelivery, nonblocking batch enqueue, same-Presence ACK retries, receiver in-flight and retained-outcome deduplication, ordered idle outcome expiry and socket-close timer cleanup, terminal delivered/failed/disconnected/unknown cleanup, attachment persistence, and restart.
- `message-store.test.ts`: ordering, attachment-aware idempotency, causal references, filters, protocol version `2`/legacy migration, integrity, and deletion.
- `hub-control.test.ts`: independent Hubs, Project control, active-Presence deletion rejection, and safe name reuse.
- `payload.test.ts`: text/binary compression, attachment count, and decoded-size enforcement.
- `operations.test.ts`: client/runtime integration, pre-dispatch cancellation, strong new/replayed acceptance, and successful/failed Delivery callbacks.

See `scripts/codemap.md` for executable boundary scenarios.
