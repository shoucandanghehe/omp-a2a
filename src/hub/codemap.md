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
| `DELETE /v1/projects/:name` | Calls registry `deleteProject` and purges the project's inbox state. |
| `POST /v1/register` | Requires `project`, `agentId`, and `cwd`; verifies the project, then calls `joinProject`. |
| `POST /v1/heartbeat` | Calls registry `heartbeat`. |
| `POST /v1/unregister` | Calls `leaveProject`. |
| `GET /v1/members` | Calls `listMembers`; `all=1` or `all=true` includes all statuses. |
| `POST /v1/send` | Validates, canonicalizes, and durably enqueues a message. |
| `GET /v1/inbox` | Reads a recipient stream without advancing its cursor. |
| `POST /v1/inbox/read` | Body-based equivalent of inbox reading. |
| `POST /v1/inbox/ack` | Atomically acknowledges messages in stream order. |

`HubClient` is the corresponding client façade. `fetchJson<T>` parses JSON and converts non-2xx responses into the internal `HubHttpError`. Client methods return project/member domain objects or decoded `HubEnvelope` values rather than raw response wrappers.

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

`payload.ts` owns the text codec. `encodeTextPayload` keeps payloads below 32 KiB as identity text and gzip/Base64-encodes payloads at or above that threshold. Both encoding and decoding enforce a 4 MiB uncompressed limit. Decoding also checks the declared uncompressed byte count. `decodeWireEnvelope` validates sequence/reference metadata, decodes text, and reconstructs the domain discriminated union; an absent sequence is represented as `0` for compatibility, while a present sequence must be positive.

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

The constructor performs in-place compatibility work before preparing statements: it adds missing inbox/ledger columns, assigns sequences to legacy unsequenced rows, rebuilds a ledger whose old schema made sequences globally unique, backfills the ledger from pending messages, seeds counters from inbox/ledger/acknowledgment maxima, replaces legacy global cursor state, and creates stream-scoped unique indexes.

The ledger intentionally survives acknowledgment. Therefore:

- retrying the same `msgId` with identical project, participants, canonical parent, and payload returns the stored envelope;
- reusing it with different content raises `MessageIdConflictError`;
- acknowledged messages remain available as causal parents;
- deleting a project explicitly purges pending messages, ledger entries, cursors, acknowledgments, and counters.

### Data-directory locking

`HubDataLock` opens a separate SQLite lock database, sets `busy_timeout = 0` and `locking_mode = EXCLUSIVE`, then holds `BEGIN EXCLUSIVE` for the server lifetime. Lock/busy failures become `HubDataDirInUseError`. `close()` is idempotent and releases the lock by rolling back and closing the database.

`startHubServer` acquires this lock before opening `InboxStore`. It closes already-acquired resources if inbox initialization or TCP listening fails. Normal `stop()` closes the HTTP server, closes inbox persistence, removes the metadata/PID files, and finally releases the data lock.

## Data and Control Flow

### Hub discovery and connection

1. `HubClient.connect` calls `connectHub`.
2. `connectHub` calls `resolveHubUrl`, whose precedence is explicit `hubUrl`, `OMP_A2A_HUB_URL`, the first matching `config.yml`/`config.yaml`/`config.json` under `a2aRoot(home)`, then `http://127.0.0.1:4173`.
3. `probeHub` requests `GET /v1/meta` with a 1.5-second timeout and returns `null` on failure.
4. A successful probe supplies the advertised `meta.baseUrl` to the new `HubClient`; failure raises an instruction to start the Hub or configure its URL.

### Registration and membership

1. `HubClient.register` posts `HubRegisterBody` to `/v1/register`.
2. The server verifies required fields and calls `getProject`.
3. For an existing project it calls `joinProject`, defaulting an omitted PID to `0`, and returns both the `A2aMember` and current `HubMeta`.
4. Later `heartbeat`, `unregister`, and `listMembers` client calls map directly to the registry-backed routes.

### Sending a message

1. `HubClient.send` chooses `input.messageId` or `crypto.randomUUID()`, calls `encodeTextPayload(input.text)`, and posts a `HubSendBody` to `/v1/send`.
2. The server requires project/sender/recipient/payload, rejects self-send, decodes the payload to reject empty trimmed text, validates message and reply IDs, and creates a timestamped `HubWireMessageDraft`.
3. `InboxStore.enqueue` begins a transaction and calls `#resolveCausalParent`.
4. If `msgId` already exists, the store compares the canonical persisted fields and either returns the original envelope or raises `MessageIdConflictError`.
5. Only for a new ID, the server-provided `validateNew` callback calls registry `readMember` and requires the recipient to be `online`. Thus an identical idempotent retry does not depend on the recipient's current status.
6. The store allocates the next `(project, recipient)` sequence, derives canonical `messageRef`/`replyToRef`, inserts the message into `message_ledger`, and inserts the pending envelope into `inbox_messages` in the same transaction.
7. The server returns the wire envelope; `HubClient.send` passes it through `decodeWireEnvelope`.

Error mapping is explicit: unavailable recipient is `404`, message-ID or causal-parent conflicts are `409`, oversized decoded text is `413`, and other validation failures are `400`.

### Reading, acknowledging, and delivery receipts

1. `HubClient.readInbox` posts project/agent/limit to `/v1/inbox/read`. It falls back to legacy `GET /v1/inbox` only when that route returns `404`. `HubClient.inbox` directly uses the GET form.
2. `InboxStore.read` transactionally reads the current cursor (default `0`) and returns up to the clamped server limit of 1,000 rows whose sequence is greater than that cursor, ordered ascending. Reading does not remove rows or advance the cursor.
3. `HubClient.ack` posts an ordered array of message IDs to `/v1/inbox/ack`.
4. `InboxStore.acknowledge` processes the entire batch in one transaction. A previously removed ID with an acknowledgment record returns `already_acknowledged`. An unknown ID raises `UnknownMessageError`.
5. For a pending ID, the store compares it with the first row after the current cursor. Any gap or reordering raises `OutOfOrderAcknowledgmentError`, rolling back the batch.
6. A valid acknowledgment deletes the pending row, records its sequence and acknowledgment time, and advances the stream cursor.
7. Acknowledging a normal message also allocates a sequence in the original sender's stream and inserts a `delivery_receipt` addressed from the recipient back to the sender. Acknowledging a receipt does not generate another receipt.
8. The route returns acknowledgment statuses and the resulting cursor. Unknown IDs map to `404`; out-of-order acknowledgments map to `409`.

This separates non-destructive polling from explicit consumption while preserving at-least-retryable client behavior and strict per-recipient processing order.

### CLI and server lifecycle

1. `cli.ts` parses `--port`, `--host`, `--public-url`/`--publicUrl`, and `--data-dir` in split or `--key=value` forms; unknown or incomplete arguments throw.
2. It calls `startHubServer`, which resolves option/environment/default values, acquires `HubDataLock`, opens `InboxStore`, installs routes, and listens. Port `0` is valid.
3. After binding, the server derives the advertised URL from `publicUrl`, `OMP_A2A_HUB_PUBLIC_URL`, or the actual port; writes `HubMeta` atomically with mode `0600`; and writes the PID file with mode `0600`.
4. The CLI prints a one-line JSON startup record.
5. `SIGINT` or `SIGTERM` calls the idempotent `handle.stop()`, then exits. An unresolved promise keeps the process alive between startup and a signal.

## Integration Points

- `../registry`: `createProject`, `deleteProject`, `getProject`, `joinProject`, `leaveProject`, `heartbeat`, `listProjects`, `listMembers`, and `readMember` provide project/member persistence and online-status validation. `RegistryConflictError` controls relevant HTTP `409` responses.
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
| `cli.ts` | Top-level argument parser, `startHubServer` invocation, startup JSON output, signal-driven shutdown, and process keepalive. |
