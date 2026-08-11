# Hub Atlas

## Responsibility

`src/hub/` implements the private versioned protocol and all Hub-owned runtime and persistent state:

- HTTP Project administration and explicit history;
- WebSocket Presence, realtime messages, and delivery outcomes;
- versioned append-only SQLite Project history;
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
| `messages.ts` | Versioned SQLite append-only message log, schema guard, history queries, idempotency, references, and deletion. | `MessageStore` |
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
- `MessageStore.append` atomically commits one immutable Message—including attachments—and the next Project sequence.
- The sender receives `accepted` with the canonical message and selected recipient names.
- Each selected socket receives the canonical `message` frame.

### Delivery

The Hub records selected recipients only in memory. Receiver `delivered` or `delivery_failed` frames resolve the matching `(messageId, recipientPresenceId)` entry and produce a sender Delivery event. If that exact Presence disconnects first, the sender receives `disconnected`.

`delivered` proves attachment materialization and injection into the receiving OMP extension. `failed` proves that the accepted Message could not be materialized or injected. Neither proves model comprehension or task completion. Delivery state is not history and is never transferred to a same-named replacement socket.

### Presence lifetime

`RealtimeHub` pings sockets every 10 seconds. A socket that does not answer the heartbeat is terminated. Close removes the Presence immediately, emits `presence_left`, and resolves its outstanding deliveries as disconnected. Hub shutdown uses the distinct `hub_shutdown` reason.

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

Message references use `<project>:<sequence>`. Parsing rejects invalid Project names, non-positive/unsafe sequences, and cross-Project history cursors.

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

### Storage schema

`messages.sqlite` carries `MESSAGE_STORAGE_VERSION`, which is independent of `A2A_PROTOCOL_VERSION`. A new database creates both current tables, the sender-history index, and the storage version in one transaction.

Opening an existing database requires both the exact current storage version and the complete required schema. Any mismatch fails startup with `unsupported pre-release storage; start with an empty data directory`; no column detection, `ALTER TABLE`, backfill, import, or fallback runs. Pre-0.1 `inbox.sqlite` is never opened or detected and remains untouched.

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
3. opens `MessageStore`, creating or validating the current versioned schema;
4. starts Express and attaches `RealtimeHub` to the same HTTP server;
5. writes `run/hub.json` and `run/hub.pid` atomically;
6. returns an idempotent `stop` closure.

Stop closes realtime clients, the HTTP server, message storage, metadata files, and the directory lock. Startup failures unwind already-opened resources.

## Test coverage

- `hub-realtime.test.ts`: Presence lifetime, duplicate names, direct/broadcast snapshots, Delivery outcomes, attachment persistence, and restart.
- `message-store.test.ts`: ordering, attachment-aware idempotency, causal references, filters, current schema creation/reopen, fail-closed schema guards, and deletion.
- `hub-control.test.ts`: independent Hubs, Project control, active-Presence deletion rejection, safe name reuse, storage startup rejection, and ignored pre-0.1 Inbox files.
- `payload.test.ts`: text/binary compression, attachment count, and decoded-size enforcement.
- `operations.test.ts`: client/runtime integration plus successful and failed Delivery callbacks.

See `scripts/codemap.md` for executable boundary scenarios.
