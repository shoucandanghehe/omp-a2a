# `src/hub/`

## Responsibility

This directory implements the A2A Hub's complete local messaging boundary:

- an Express HTTP/JSON server for project membership and point-to-point messaging;
- a typed `fetch` client that hides wire encoding and endpoint details;
- a SQLite-backed inbox with durable ordering, acknowledgments, delivery receipts, idempotency, and causal-reply validation;
- a process-wide data-directory lock that prevents two Hub instances from opening the same state;
- the wire/domain protocol types, message-reference grammar, and text compression codec;
- the executable CLI lifecycle for starting and stopping the server.

Project and member records remain owned by `../registry`; this directory exposes those operations over HTTP and owns only Hub transport and inbox state.

## Design and Protocol

### Transport boundary

`server.ts` is an HTTP façade over `../registry` and `InboxStore`. It accepts JSON through `express.json({ limit: "6mb" })` and exposes:

| Method and path | Operation |
| --- | --- |
| `GET /healthz` | Returns service health plus `HubMeta`. |
| `GET /v1/meta` | Returns `HubMeta`. |
| `GET /v1/projects` | Calls `listProjects`. |
| `POST /v1/projects` | Validates `name`, calls `createProject`, and returns `201`. |
| `DELETE /v1/projects/:name` | Persists a deletion marker, removes Registry state, purges all SQLite project state, then clears the marker. |
| `POST /v1/register` | Validates every required and optional member field, verifies the project, then calls `joinProject`. |
| `POST /v1/heartbeat` | Calls registry `heartbeat`. |
| `POST /v1/unregister` | Calls `leaveProject`. |
| `GET /v1/members` | Calls `listMembers`; `all=1` or `all=true` includes all statuses. |
| `POST /v1/send` | Validates identity syntax, payload, IDs, and causal fields, then durably enqueues a message. |
| `GET /v1/inbox` | Reads a recipient stream with an integer limit from 1 through 1,000 without advancing its cursor. |
| `POST /v1/inbox/read` | Typed body-based equivalent of Inbox reading. |
| `POST /v1/inbox/ack` | Atomically acknowledges messages in stream order. |

`HubClient` is the corresponding client façade. `fetchJson<T>` parses JSON, rejects malformed successful responses, and converts non-2xx responses into the internal `HubHttpError`. Client methods return project/member domain objects or decoded `HubEnvelope` values rather than raw response wrappers.

### Wire and domain envelopes

`types.ts` separates transport representation from application representation:

- `EncodedTextPayload` is either UTF-8 text with `encoding: "identity"` or compressed Base64 data with `encoding: "gzip+base64"`; both carry `uncompressedBytes`.
- `HubWireMessageDraft` is an unsequenced message accepted by persistence.
- `HubWireMessageEnvelope` and `HubWireDeliveryReceipt` are sequenced persisted transport records.
- `HubWireEnvelope` is their discriminated union on `kind`.
- `HubMessageEnvelope`, `HubDeliveryReceipt`, and `HubEnvelope` are decoded equivalents whose `payload` is replaced by `text`.
- `HubWireInboxBatch`/`HubInboxBatch` pair ordered envelopes with the recipient's current cursor.
- `HubAcknowledgment` and `HubAckBatch` report each message as `acknowledged` or `already_acknowledged`, together with the resulting cursor.
- `HubRegisterBody`, `HubSendBody`, and `HubSendInput` define registration, raw-wire send, and decoded client-send inputs.
- `HubMeta` identifies the live process, actual TCP port, advertised base URL, data directory, and start time.

Messages carry a caller-supplied or generated `msgId`, project, sender, recipient, creation time, and optional causal identifiers:

- `replyTo` identifies a parent by message ID.
- `messageRef` and `replyToRef` use the stable `<recipient>:<serverSequence>` grammar implemented by `formatMessageRef` and `parseMessageRef`.
- The recipient component must match `AGENT_ID_RE`; the sequence must be a positive safe integer.
- `InboxStore` resolves either parent form through the durable ledger, requires both forms to identify the same message when both are supplied, and accepts only a parent in the same project and two-agent conversation.

`payload.ts` owns the text codec. `encodeTextPayload` keeps payloads below 32 KiB as identity text and gzip/Base64-encodes payloads at or above that threshold. Both encoding and decoding enforce a 4 MiB uncompressed limit; gzip expansion is bounded during decompression and limit failures become `PayloadTooLargeError`. Decoding also checks the declared uncompressed byte count. `decodeWireEnvelope` validates sequence/reference metadata, decodes text, and reconstructs the domain discriminated union; an absent sequence is represented as `0` for compatibility, while a present sequence must be positive.

### Persistence and ordering model

`InboxStore` is a SQLite repository whose prepared statements and multi-step transactions serialize state changes. The database uses WAL journaling and `synchronous = FULL`. Its tables have distinct responsibilities:

| Table | Responsibility |
| --- | --- |
| `inbox_messages` | Pending message and delivery-receipt envelopes. |
| `inbox_sequences` | Per-`(project, recipient)` sequence counter. |
| `message_ledger` | Durable original-message history used for idempotency and causal lookup after inbox deletion. |
| `inbox_cursors` | Last acknowledged sequence per recipient stream. |
| `inbox_acknowledgments` | Durable acknowledgment/idempotency records for removed pending envelopes. |

Each recipient has an independent, strictly increasing stream within a project. `#allocateSequence` updates `inbox_sequences`; unique indexes enforce one envelope, ledger message, and acknowledgment per stream sequence. `#listAfterCursor` orders pending rows by `server_sequence`, so reads are deterministic.

The constructor performs in-place compatibility work before preparing statements: it adds missing inbox/ledger columns, assigns sequences to legacy unsequenced rows in deterministic bounded batches, rebuilds a ledger whose old schema made sequences globally unique, backfills the ledger from pending messages, seeds counters from inbox/ledger/acknowledgment maxima, replaces legacy global cursor state, and creates stream-scoped unique indexes.

The ledger intentionally survives acknowledgment. Therefore:

- retrying the same `msgId` with identical project, participants, canonical parent, and payload returns the stored envelope;
- reusing it with different content raises `MessageIdConflictError`;
- acknowledged messages remain available as causal parents;
- the `receipt:` namespace is reserved for Hub-generated receipts, and pending or acknowledged legacy receipt IDs cannot be reused as messages;
- deleting a project explicitly purges pending messages, ledger entries, cursors, acknowledgments, and counters.

Inbox reads first load bounded payload-size metadata, then materialize only the FIFO prefix within the 1,000-message and 8 MiB conservative estimated-response budgets. A single oversize head remains readable for forward progress. Acknowledgment requests are capped at 1,000 raw IDs and deduplicated in first-occurrence order before transactional processing.

### Data-directory locking

`HubDataLock` opens a separate SQLite lock database, sets `busy_timeout = 0` and `locking_mode = EXCLUSIVE`, then holds `BEGIN EXCLUSIVE` for the server lifetime. Lock/busy failures become `HubDataDirInUseError`. `close()` is idempotent and releases the lock by rolling back and closing the database.

`startHubServer` acquires this lock before opening `InboxStore`, reconciles durable Project deletion markers before listening, and closes every acquired resource if Inbox initialization, listening, address discovery, or runtime metadata publication fails. Normal `stop()` allows a bounded HTTP grace period, force-closes remaining connections, then closes Inbox persistence, metadata/PID files, and the data lock.

## Data and Control Flow

### Hub discovery and connection

1. `HubClient.connect` calls `connectHub`.
2. `connectHub` calls `resolveHubUrl`, whose precedence is explicit `hubUrl`, `OMP_A2A_HUB_URL`, the first existing global config, then `http://127.0.0.1:4173`. A selected global file must parse to an object with a nonblank string URL; failures include its path and never fall through.
3. `probeHub` requests `GET /v1/meta` with a 1.5-second timeout and returns `null` on failure.
4. A successful probe supplies the validated advertised `meta.baseUrl` to the new `HubClient`. All ordinary client requests combine caller cancellation with a configurable 15-second default deadline.

### Registration and membership

1. `HubClient.register` posts `HubRegisterBody` to `/v1/register`.
2. The server validates required strings plus optional PID, capabilities, display name, and session ID before reading storage.
3. For an existing project it calls `joinProject`, defaulting an omitted PID to `0`, and returns public `A2aMember`, current `HubMeta`, and a new opaque `leaseId`.
4. `heartbeat` and `unregister` require the current lease. Member listings expose only public member data.

### Sending a message

1. `HubClient.send` chooses `input.messageId` or `crypto.randomUUID()`, calls `encodeTextPayload(input.text)`, and posts a `HubSendBody` to `/v1/send`.
2. The server requires project/sender/recipient/payload, validates both identity claims, rejects self-send, decodes the payload to reject empty trimmed text, validates message and non-blank causal IDs, and creates a timestamped `HubWireMessageDraft`.
3. `InboxStore.enqueue` begins a transaction and calls `#resolveCausalParent`.
4. If `msgId` already exists, the store compares the canonical persisted fields and either returns the original envelope or raises `MessageIdConflictError`.
5. Only for a new ID, the server-provided `validateNew` callback calls registry `readMember` and requires the recipient to be `online`. Thus an identical idempotent retry does not depend on the recipient's current status.
6. The store allocates the next `(project, recipient)` sequence, derives canonical `messageRef`/`replyToRef`, inserts the message into `message_ledger`, and inserts the pending envelope into `inbox_messages` in the same transaction.
7. The server returns the wire envelope; `HubClient.send` passes it through `decodeWireEnvelope`.

Error mapping is explicit: unavailable recipient is `404`, message-ID or causal-parent conflicts are `409`, oversized decoded text is `413`, other validation failures are `400`, and unexpected persistence failures are `500`.

### Reading, acknowledging, and delivery receipts

1. `HubClient.readInbox` posts project, agent, an integer limit from 1 through 1,000, and lease to `/v1/inbox/read`. It falls back to legacy `GET /v1/inbox` only when that route returns `404`; the fallback and direct `inbox` method carry the lease in `x-a2a-lease`, never in the request URL.
2. Before storage access, the Hub requires the recipient's current non-offline member lease. `InboxStore.read` reads size metadata for at most 1,000 ordered rows, then materializes the FIFO prefix within the estimated 8 MiB response budget without removing rows or advancing the cursor.
3. `HubClient.ack` posts an ordered array of message IDs with the same lease to `/v1/inbox/ack`; the Hub rejects more than 1,000 raw IDs and deduplicates the accepted batch.
4. `InboxStore.acknowledge` processes the entire batch in one transaction. A previously removed ID with an acknowledgment record returns `already_acknowledged`. An unknown ID raises `UnknownMessageError`.
5. For a pending ID, the store compares it with the first row after the current cursor. Any gap or reordering raises `OutOfOrderAcknowledgmentError`, rolling back the batch.
6. A valid acknowledgment deletes the pending row, records its sequence and acknowledgment time, and advances the stream cursor.
7. Acknowledging a normal message also allocates a sequence in the original sender's stream and inserts a `delivery_receipt` with a reserved `receipt:` ID addressed from the recipient back to the sender. Acknowledging a receipt does not generate another receipt.
8. The route returns acknowledgment statuses and the resulting cursor. Unknown IDs map to `404`; out-of-order acknowledgments map to `409`.

This separates non-destructive polling from explicit consumption while preserving at-least-retryable client behavior and strict per-recipient processing order.

### CLI and server lifecycle

1. Executable `cli.ts` starts with `#!/usr/bin/env bun`, is exposed as package bin `omp-a2a-hub`, and parses `--port`, `--host`, `--public-url`/`--publicUrl`, and `--data-dir` in split or `--key=value` forms; unknown or incomplete arguments throw.
2. The CLI resolves option/environment/default values and passes explicit options to `startHubServer`; programmatic server calls never read deployment environment variables. Port `0` is valid, while an explicitly blank data directory is rejected before locking or filesystem creation.
3. After binding, the server validates or derives the advertised URL, records a separate process-reachable `listenUrl` on its handle, writes `HubMeta` atomically with mode `0600`, and writes the PID file with mode `0600`. Wildcard binds require an explicit public URL.
4. The CLI prints a one-line JSON startup record.
5. `SIGINT` or `SIGTERM` calls the idempotent `handle.stop()`, which enforces a bounded grace period before force-closing remaining connections, then exits. An unresolved promise keeps the process alive between startup and a signal.

## Integration Points

- `../registry`: `createProject`, `deleteProject`, `getProject`, `joinProject`, `leaveProject`, `heartbeat`, `listProjects`, `listMembers`, and `readMember` provide project/member persistence and online-status validation. `RegistryOperationError` identifies expected HTTP `400` failures, `RegistryConflictError` controls relevant `409` responses, and malformed or unreadable persisted JSON surfaces through the `500` path.
- `../paths`: `a2aRoot` supplies client configuration lookup; `defaultDataDir`, `hubLockPath`, `inboxDatabasePath`, `hubMetaPath`, and `hubPidPath` define server storage; `ensureDir` prepares SQLite and metadata parent directories.
- `../types`: the client exposes registry domain types `A2aProject` and `A2aMember`.
- Bun runtime: `bun:sqlite` supplies `Database`, prepared queries, and transactions; global `fetch`, `crypto.randomUUID`, and `AbortSignal.timeout` are used by the client/server.
- Express: owns HTTP routing and JSON parsing; Node HTTP `Server` supplies listen/close lifecycle.
- Node libraries: `fs`, `path`, and `os` handle configuration and lifecycle files; `zlib` handles gzip payloads.
- Environment contract: `OMP_A2A_HUB_URL`, `OMP_A2A_HUB_PORT`, `OMP_A2A_HUB_HOST`, `OMP_A2A_HUB_DATA_DIR`, and `OMP_A2A_HUB_PUBLIC_URL`.

## File Map

| File | Principal symbols and role |
| --- | --- |
| `client.ts` | `HubHttpError`, `fetchJson`, `resolveHubUrl`, `probeHub`, `connectHub`, and `HubClient`; URL discovery, health probing, typed HTTP calls, payload encoding, envelope decoding, and legacy inbox-read fallback. |
| `data-lock.ts` | `HubDataDirInUseError` and `HubDataLock`; exclusive SQLite lifetime lock for one Hub per data directory. |
| `inbox.ts` | Row types, persistence errors, and `InboxStore`; schema migration, prepared statements, sequencing, ledger-backed idempotency/causality, ordered reads/acks, receipt creation, and project purge. |
| `message-ref.ts` | `InvalidMessageRefError`, `MessageRef`, `formatMessageRef`, and `parseMessageRef`; validation and conversion of stable recipient-sequence references. |
| `payload.ts` | `TEXT_COMPRESSION_THRESHOLD_BYTES`, `MAX_TEXT_BYTES`, `PayloadTooLargeError`, `encodeTextPayload`, `decodeTextPayload`, and `decodeWireEnvelope`; bounded text codec and wire-to-domain conversion. |
| `server.ts` | `HubServerHandle`, `writeJsonAtomic`, `requestedPort`, `RecipientUnavailableError`, and `startHubServer`; Express routes, resource lifecycle, registry/store orchestration, status mapping, and metadata publication. |
| `types.ts` | Hub metadata, encoded payload, wire/domain envelope unions, inbox/ack batches, and register/send request types; shared protocol contract. |
| `cli.ts` | Executable Bun/package-bin entry, top-level argument parser, `startHubServer` invocation, startup JSON output, signal-driven shutdown, and process keepalive. |
