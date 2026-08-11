# Hub Atlas

## Responsibility

`src/hub/` implements the private versioned protocol and all Hub-owned runtime and persistent state:

- HTTP Project administration and explicit history;
- WebSocket Presence, realtime messages, and delivery outcomes;
- canonical SQLite Project metadata, sequence, and message history;
- payload encoding limits;
- exclusive data-directory ownership and process lifecycle.

## Module map

| File | Responsibility | Primary interface |
| --- | --- | --- |
| `cli.ts` | Parse command/environment settings, start one Hub, and shut down on signals. | executable entry |
| `server.ts` | Express routes, HTTP server, runtime metadata, canonical store lifecycle, and WebSocket attachment. | `startHubServer`, `HubServerHandle` |
| `realtime-server.ts` | Upgrade handling, handshake, Presence events, routing, delivery tracking, heartbeat, and shutdown. | `RealtimeHub` |
| `connection.ts` | Extension-side WebSocket protocol client. | `A2aConnection`, `A2aConnectionEvents` |
| `presence.ts` | In-memory Project/name/socket indexes. | `PresenceRegistry`, `Presence` |
| `store.ts` | SQLite Project metadata, Project sequences, Messages, history, atomic deletion, and existing message migrations. | `HubStore` |
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
| `GET /v1/projects` | List persistent Projects in deterministic name order. |
| `POST /v1/projects` | Create Project metadata; duplicate returns `409`. |
| `DELETE /v1/projects/:name` | Reject active Presence, then atomically remove metadata, sequence, and complete history. |
| `GET /v1/history` | Query one existing Project by cursor, sender name, and bounded limit. |
| `GET /v1/connect` upgrade | Hand the socket to `RealtimeHub`. |

The public `baseUrl` reported in Hub metadata can differ from the listen host. Clients retain their resolved configuration URL as the authoritative HTTP and WebSocket route.

## WebSocket protocol

`A2A_PROTOCOL_VERSION` is `3`.

### Handshake

1. A new socket must send `hello` within 5 seconds.
2. The frame supplies protocol version, Project, and temporary name.
3. The Hub verifies the Project and protocol, then claims the name in `PresenceRegistry`.
4. The claimant receives `claimed` with a new `presenceId` and current peer snapshot.
5. Existing peers receive `presence_joined`.

One socket can claim one name. One name can be held by one current socket inside a Project. A duplicate fails with `name_in_use`; it never replaces the owner.

### Message request

The client sends `message` with `requestId`, opaque `messageId`, typed target, encoded text payload, ordered encoded attachments, and optional `replyTo`.

- Direct target resolves the current name and freezes its `presenceId`.
- Project target snapshots all current Presence except the sender.
- A missing direct target fails before persistence.
- Text, attachment structure/content, total decoded size, and causal references are validated before append.
- `HubStore.append` validates that the Project row exists, then atomically commits one immutable Message—including attachments—and the next Project sequence.
- The sender receives `accepted` with the canonical message and selected recipient names.
- Each selected socket receives the canonical `message` frame.

### Delivery

The Hub records selected recipients only in memory. Receiver `delivered` or `delivery_failed` frames resolve the matching `(messageId, recipientPresenceId)` entry and produce a sender Delivery event. If that exact Presence disconnects first, the sender receives `disconnected`.

`delivered` proves attachment materialization and injection into the receiving OMP extension. `failed` proves that the accepted Message could not be materialized or injected. Neither proves model comprehension or task completion. Delivery state is not history and is never transferred to a same-named replacement socket.

### Presence lifetime

`RealtimeHub` pings sockets every 10 seconds. A socket that does not answer the heartbeat is terminated. Close removes the Presence immediately, emits `presence_left`, and resolves its outstanding deliveries as disconnected. Hub shutdown uses the distinct `hub_shutdown` reason.

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
- encoded text, ordered attachment names/content, and total decoded-content bytes;
- creation timestamp and optional same-Project causal parent sequence.

Message references use `<project>:<sequence>`. Parsing rejects invalid Project names, non-positive/unsafe sequences, and cross-Project history cursors.

### Project lifecycle

Project create/get/list/delete are synchronous store operations. Listing preserves name sorting. `deleteProject` uses one `BEGIN IMMEDIATE` transaction to delete Messages, Project sequence, and metadata, returning whether the Project existed. A failure in any delete statement rolls back all three. Recreating the name therefore starts with sequence `1` and empty history.

`server.ts` rejects deletion while `RealtimeHub` reports an active Presence. Both claim and delete consult this store fact synchronously without a second blocked/deleted set: claim-first rejects deletion, and delete-first rejects claim as an unknown Project.

### History

`history` supports:

- `before` or `after`, never both;
- optional exact sender-name filter;
- positive bounded item limit;
- deterministic Project-sequence ordering;
- a 4 MiB cumulative decoded-content budget, including attachments, per history page.

### Idempotency and causality

Reusing `messageId` with the same Project, sender name, target kind/name, text encoding/data/size, ordered attachment names/encoding/data/size, and causal parent returns the canonical stored Message. A difference in any compared field raises `MessageIdConflictError`.

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

`HubClient` exposes only metadata, Project CRUD, and history. Realtime operations belong to `A2aConnection`. Server routes and realtime claims both use the same `HubStore`.

## Data-directory lifecycle

`startHubServer`:

1. resolves and creates the data directory;
2. acquires `HubDataLock` through an exclusive SQLite transaction;
3. opens `HubStore`;
4. starts Express and attaches `RealtimeHub` to the same HTTP server;
5. writes `run/hub.json` and `run/hub.pid` atomically;
6. returns the shared cleanup function as `stop`.

Startup failure and every concurrent `stop` call reuse one cleanup Promise. Cleanup attempts each acquired resource in reverse order, retains the first error, and consistently releases runtime metadata, realtime sockets, the HTTP listener, `HubStore`, and the directory lock.

## Test coverage

- `hub-realtime.test.ts`: Presence lifetime, duplicate names, direct/broadcast snapshots, Delivery outcomes, attachment persistence, and restart.
- `message-store.test.ts`: Project CRUD/reopen/sorting, atomic delete rollback, history/idempotency/causality, and existing message migrations.
- `hub-control.test.ts`: independent Hubs, claim/delete ordering, active-Presence rejection with unchanged history, startup cleanup, and concurrent stop.
- `payload.test.ts`: text/binary compression, attachment count, and decoded-size enforcement.
- `operations.test.ts`: client/runtime integration plus successful and failed Delivery callbacks.

See `scripts/codemap.md` for executable boundary scenarios.
