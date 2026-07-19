# omp-a2a

OMP multi-project collaboration mesh.

## Architecture

```text
  omp A / omp B / omp C
       │  HTTP clients only
       │  hubUrl from config / env
       ▼
  omp-a2a-hub  (standalone process; you start it)
  http://127.0.0.1:4173
  - authoritative Project Registry
  - heartbeat-based membership
  - persistent SQLite Inbox + durable delivery receipts
  - custom Mesh send protocol
```

- **Hub:** owns all Project, membership, and Inbox state. OMP never starts it or reads its data directory.
- **Extension:** pure client; Slash and Tool adapters share one `A2aOperations` implementation.
- **Multiple Hubs:** supported when every Hub has a different URL and data directory. Projects with the same name on different Hubs are unrelated.

Messages below 32 KiB use an identity payload. Larger text is gzip-compressed on the Mesh wire. Decoded text is limited to 4 MiB. Inbox storage has no message-count cap. Every accepted envelope receives a Hub-assigned `serverSequence` that is monotonic within its `(project, recipient)` stream. Pending reads use only `serverSequence > cursor ORDER BY serverSequence`; `createdAt` is diagnostic metadata and never participates in correctness ordering.

`messageId` is an optional idempotency key. Retrying the same body returns the original envelope and sequence, including after acknowledgment; reusing the ID for different content returns `409`. The deduplication ledger is retained until Project deletion. `replyTo` is an optional causal parent and must name a message in the same Project between the same participant pair.

The extension uses at-least-once delivery. Reading pending messages does not advance the persistent cursor. After OMP injection succeeds, acknowledgment transactionally removes the next ordered message, records an observable acknowledgment status, advances the cursor, and creates the delivery receipt. A crash after injection but before acknowledgment therefore redelivers the same `messageId`; consumers must use that ID for deduplication. Unknown and out-of-order acknowledgments fail explicitly, while repeated acknowledgments report `already_acknowledged`.

On the first upgraded Hub start, the existing SQLite Inbox is migrated in place: queued rows receive deterministic per-stream sequences in `(project, recipient, createdAt, rowid)` order, and pending messages seed the deduplication ledger. The previous global-sequence ledger is rebuilt for scoped sequences, and any pre-ack consume cursor is reset so migration prefers possible redelivery over message loss. IDs for messages already acknowledged before the upgrade no longer exist and cannot be backfilled. Until the Hub is upgraded, a new client falls back to the legacy peek-and-ack path, so scoped sequence, causal-link, and persistent acknowledgment guarantees require the new Hub.

When the receiving extension acknowledges a successfully injected message, the same storage transaction advances its cursor and creates a durable `delivery_receipt` in the sender's Inbox; acknowledging the receipt removes it without creating another receipt. Messages arriving while the Agent is active use OMP's steer queue rather than becoming stale follow-up turns.

## Trust model

omp-a2a is designed for a fully trusted private network. Hub endpoints intentionally do not authenticate callers.
Caller-supplied project and sender identity are trusted claims; membership is used to discover and route to recipients, not to authenticate or admit senders.
Do not expose the Hub to the public Internet or an untrusted network.

## Install

```bash
cd ~/code/omp-a2a && bun install
ln -sfn ~/code/omp-a2a ~/.omp/agent/extensions/omp-a2a
```

Restart `omp` after linking.

## Run a Hub

### Docker Compose

```bash
cd ~/code/omp-a2a

# optional: copy .env.example → .env and edit the published port/URL
docker compose up -d --build

curl -s http://127.0.0.1:4173/healthz
docker compose logs -f hub

# preserve this Hub's Registry and Inbox
docker compose down
# delete them
docker compose down -v
```

Each Compose project receives its own named volume. Use different Compose project names and published ports to run independent Hubs:

```bash
OMP_A2A_HUB_PORT=4173 \
OMP_A2A_HUB_PUBLIC_URL=http://127.0.0.1:4173 \
docker compose -p mesh-a up -d --build

OMP_A2A_HUB_PORT=4174 \
OMP_A2A_HUB_PUBLIC_URL=http://127.0.0.1:4174 \
docker compose -p mesh-b up -d --build
```

### Local process

```bash
# defaults: 127.0.0.1:4173 and ~/.omp/a2a
bun run hub

# a second, fully independent Hub
bun run hub -- \
  --host 127.0.0.1 \
  --port 4174 \
  --public-url http://127.0.0.1:4174 \
  --data-dir /absolute/path/to/mesh-b
```

Equivalent environment variables:

```text
OMP_A2A_HUB_HOST
OMP_A2A_HUB_PORT
OMP_A2A_HUB_PUBLIC_URL
OMP_A2A_HUB_DATA_DIR
```

Runtime metadata lives under `<data-dir>/run/`; the persistent Inbox is `<data-dir>/inbox.sqlite`.

## Point omp at a Hub

First match wins:

1. Per-repo `.omp/a2a.yml` → `hubUrl`
2. `OMP_A2A_HUB_URL`
3. Global `~/.omp/a2a/config.yml` → `hubUrl`
4. `http://127.0.0.1:4173`

Example per-repo config:

```yaml
hubUrl: http://127.0.0.1:4173
project: billing-rewrite
agentId: api
caps: [api, db]
autoJoin: true
```

Project creation, listing, deletion, membership, and messaging always go through the selected Hub.

## Usage

Inside OMP, after the selected Hub is running:

```text
/a2a hub
/a2a project create billing-rewrite
/a2a join billing-rewrite --as api --caps api,db
/a2a list
/a2a send web please align the login API contract --message-id task-42
/a2a send web corrected contract --message-id reply-42 --reply-to task-42
/a2a inbox
/a2a status
/a2a leave
/a2a project delete billing-rewrite
```

The model-facing `a2a` Tool exposes the same operations through the same `A2aOperations` module.

`send` reports `queued` with `msgId` and `serverSequence`. Inbox and inbound output include `serverSequence`, `createdAt`, cursor, and `replyTo`. The sender extension later displays `[a2a delivered]` with the original `msgId` after the receiving extension acknowledges it. This proves receipt by the peer OMP extension, not that its model read, understood, or completed the work; semantic completion still requires a normal reply.

Project deletion is idempotent and removes its persisted Inbox. It is rejected until every member is offline.

## Verify

```bash
bun run smoke
```

This runs the Bun tests, Registry smoke, and a real Hub/HubClient smoke covering per-stream monotonic FIFO ordering, concurrent writes and duplicate reads, idempotent message IDs, causal replies, acknowledgment-driven persistent cursors, pre-ack failure and post-ack restart behavior, durable delivery receipts, legacy Inbox migration, gzip payloads, and safe Project deletion.

## Layout

```text
src/
  operations.ts    # canonical Slash/Tool operations
  registry.ts      # Project and heartbeat membership persistence
  hub/server.ts    # standalone custom Mesh Hub
  hub/client.ts    # pure URL client
  hub/inbox.ts     # persistent SQLite Inbox
  hub/payload.ts   # text encoding, gzip, and decoded-size limits
  hub/cli.ts       # bun run hub
  extension.ts     # thin OMP adapters and background timers
```
