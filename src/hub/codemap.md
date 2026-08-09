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
| `server.ts` | Express routes, listener/public URL separation, recoverable Project deletion, storage lifecycle, and WebSocket attachment. | `startHubServer`, `HubServerHandle` |
| `realtime-server.ts` | Upgrade handling, handshake, Presence, routing, delivery tracking, heartbeat, graceful goodbye, and shutdown. | `RealtimeHub` |
| `connection.ts` | Extension-side WebSocket protocol client, bounded/cancellable handshake, bounded graceful close, and bounded/cancellable message requests. | `A2aConnection`, `A2aConnectionEvents` |
| `presence.ts` | In-memory Project/name/socket indexes. | `PresenceRegistry`, `Presence` |
| `messages.ts` | SQLite messages, durable recipient snapshots, bounded history, idempotency, references, deletion, and migration. | `MessageStore` |
| `client.ts` | Hub URL resolution plus bounded, cancellable, validated HTTP metadata/Project/history calls. | `HubClient`, `connectHub`, `resolveHubUrl` |
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
| `DELETE /v1/projects/:name` | Reject active Presence, durably journal deletion, remove metadata/history, then clear the journal. |
| `GET /v1/history` | Query one existing Project by strict cursor/sender/limit parameters and bounded page work. |
| `GET /v1/connect` upgrade | Hand the socket to `RealtimeHub`; claims are rejected while deletion is pending. |

The advertised public `baseUrl` can differ from the process-reachable `HubServerHandle.listenUrl`. Binding a wildcard host requires an explicit client-facing public URL. Clients retain their resolved configuration URL as the authoritative HTTP and WebSocket route rather than replacing it with Hub metadata. Programmatic startup accepts explicit options only; the CLI owns flag/environment/default precedence.

## WebSocket protocol

`A2A_PROTOCOL_VERSION` is `3`.

### Handshake

1. A new socket must send `hello` within 5 seconds.
2. The frame supplies protocol version, Project, and temporary name.
3. The Hub verifies the Project and protocol, then claims the name in `PresenceRegistry`.
4. The claimant receives `claimed` with a new `presenceId` and current peer snapshot.
5. Existing peers receive `presence_joined`.
6. The client bounds and can cancel its wait for `claimed` or `error`; either path terminates the unclaimed socket.

One socket can claim one name. One name can be held by one current socket inside a Project. A duplicate fails with `name_in_use`; it never replaces the owner.

### Message request

The client sends `message` with `requestId`, opaque `messageId`, typed target, encoded text payload, ordered encoded attachments, and optional `replyTo`.

- Direct target resolves the current name and freezes its `presenceId`.
- Project target snapshots all current Presence except the sender.
- A missing direct target fails before persistence.
- Text, attachment structure/content, total decoded size, and causal references are validated before append.
- `MessageStore.append` atomically commits one immutable Message—including attachments and its original recipient Presence snapshot—and the next Project sequence.
- The sender receives `accepted` with the canonical message and selected recipient names.
- Only a new append pushes to selected sockets; an identical retry returns the persisted recipient snapshot without redelivery or current-Presence resolution.

### Delivery

The Hub records pending delivery outcomes only in memory. Receiver `delivered` or `delivery_failed` frames resolve the matching `(messageId, recipientPresenceId)` entry and produce a sender Delivery event. If that exact recipient Presence disconnects first, the sender receives `disconnected`; if the sender leaves, its pending outcomes are discarded.

`delivered` proves attachment materialization and injection into the receiving OMP extension. `failed` proves that the accepted Message could not be materialized or injected. Neither proves model comprehension or task completion. Delivery outcomes are not history and are never transferred to a same-named replacement socket. The accepted recipient snapshot used for idempotent retries is persisted separately.

### Presence lifetime

`RealtimeHub` pings sockets every 10 seconds. A socket that does not answer is terminated. Graceful client `goodbye` removes Presence and outstanding delivery state before acknowledging close; missing acknowledgment falls back to WebSocket close and termination on bounded timers. Other close paths remove Presence in the socket callback. Hub shutdown uses the distinct `hub_shutdown` reason.

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
- the ordered `{ name, presenceId }` recipient snapshot selected at first acceptance;
- creation timestamp and optional same-Project causal parent sequence.

Message references use `<project>:<sequence>`. Parsing rejects invalid Project names, non-positive/unsafe sequences, and cross-Project history cursors.

### History

`history` supports:

- `before` or `after`, never both;
- optional exact sender-name filter;
- an integer item limit from 1 through 500;
- deterministic Project-sequence keyset iteration;
- a 4 MiB cumulative decoded-content budget, including attachments;
- a 6 MiB serialized JSON response budget.

Each indexed row is fetched and sized once. The canonical per-message payload contract ensures every maximum legal Message can make forward progress without violating the response cap.

### Idempotency and causality

Reusing `messageId` with the same Project, sender name, target kind/name, text encoding/data/size, ordered attachment names/encoding/data/size, and causal parent returns the canonical stored Message and original recipient snapshot without redelivery. A difference in any compared field raises `MessageIdConflictError`.

`replyTo` must be nonblank and resolve to an existing message in the same Project or the append is rejected before sequence allocation.

### Legacy migration

When `messages.sqlite` first encounters old `inbox.sqlite`, every ordinary `message_ledger` row is imported through deterministic ordered streaming passes inside one transaction. Receipt and delivery state lived outside that ledger and is not imported. Crash-atomic schema initialization records whether a pre-marker message database already existed, and a durable metadata marker prevents replay after deletion/reopen. Old pending messages become history only; no old Presence, recipient cursor, ACK, receipt-state, or offline-delivery state survives.

Opening a protocol version `2` `messages.sqlite` adds attachment JSON and total decoded-content columns in place. Existing rows receive `attachments = []` and `content_bytes = uncompressed_bytes`.

Migration validates canonical bounded payloads, imported reply relationships, row count, and `PRAGMA integrity_check`. The old database is not modified.

## Payload codec

- Text `< 32 KiB`: `{ encoding: "identity", data, uncompressedBytes }`.
- Larger text: canonical gzip bytes encoded as Base64.
- Attachment bytes: canonical Base64, optionally gzip-compressed first when smaller.
- At most eight attachments per Message.
- Text plus attachments `> 4 MiB`: rejected; encoded payloads reserve 64 KiB inside the 6 MiB frame/history envelope.
- gzip decode uses `maxOutputLength` so expansion is bounded during decompression.
- Base64 form and decoded byte counts must match exactly.

The WebSocket server also caps a complete frame at 6 MiB.

## HTTP client

`resolveHubUrl` precedence is explicit argument, environment, first existing global config, then loopback default. The first existing file is authoritative, uses the shared strict YAML/JSON boundary, and fails immediately when malformed. The resolved configured URL remains authoritative for HTTP and WebSocket connections; Hub metadata validates protocol compatibility without replacing it. `probeHub` uses a 1.5-second deadline; ordinary `HubClient` operations use a validated 15-second default deadline, preserve caller cancellation through body parsing, and validate successful external JSON.

`HubClient` exposes only metadata, Project CRUD, and history. Realtime operations belong to `A2aConnection`.

## Data-directory lifecycle

`startHubServer`:

1. validates explicit listener, public URL, and data-directory options;
2. acquires `HubDataLock` through an exclusive SQLite transaction;
3. opens `MessageStore` and performs once-only legacy migration;
4. reconciles durable Project deletion markers before listening;
5. starts Express and attaches `RealtimeHub`;
6. writes `run/hub.json` and `run/hub.pid` durably;
7. returns advertised metadata, independently reachable `listenUrl`, and an idempotent `stop`.

Stop closes realtime clients, the HTTP server, message storage, metadata files, and the directory lock. Every post-listen startup failure unwinds those same resources. A deletion marker blocks creation and realtime claims until both Registry and SQLite state are purged and marker removal is durable.

## Test coverage

- `hub-realtime.test.ts`: bounded/cancellable handshake, Presence lifetime, graceful-close fallback, cancellation outcomes, direct/broadcast snapshots, canonical retries, successful/failed/disconnected Delivery outcomes, attachment persistence, persistence errors, and restart.
- `message-store.test.ts`: ordering, attachment-aware idempotency, recipient snapshots, causal references, bounded history, protocol version `2` and legacy migration streaming/backfill/rollback, integrity, and deletion.
- `hub-control.test.ts`: independent Hubs, strict HTTP/URL boundaries, active/pending-deletion rejection, recovery, safe name reuse, and startup unwind.
- `payload.test.ts`: text/binary compression, attachment count, canonical Base64, encoded/decoded limits, compression expansion, and metadata mismatch.
- `operations.test.ts`: atomic transitions, accepting-Hub binding, stalled-handshake cancellation, client/runtime integration, successful and failed Delivery callbacks, cancellation, and disconnected errors.

See `scripts/codemap.md` for executable boundary scenarios.
