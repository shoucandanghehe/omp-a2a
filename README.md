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

`messageId` is an opaque idempotency key for machines. Retrying the same body returns the original envelope and sequence, including after acknowledgment; reusing the ID for different content returns `409`. The deduplication ledger is retained until Project deletion. Agents normally use the derived Project-scoped `messageRef` (`<recipient>:<serverSequence>`, for example `api:42`) instead. `replyToRef` accepts that friendly reference and resolves it to the internal `replyTo` message ID; raw `replyTo` remains supported for compatibility. Both forms must identify a message in the same Project between the same participant pair.

The extension uses at-least-once delivery. Reading pending messages does not advance the persistent cursor. After OMP injection succeeds, acknowledgment transactionally removes the next ordered message, records an observable acknowledgment status, advances the cursor, and creates the delivery receipt. A crash after injection but before acknowledgment therefore redelivers the same `messageId`; consumers must use that ID for deduplication. Unknown and out-of-order acknowledgments fail explicitly, while repeated acknowledgments report `already_acknowledged`.

On the first upgraded Hub start, the existing SQLite Inbox is migrated in place: queued rows receive deterministic per-stream sequences in `(project, recipient, createdAt, rowid)` order, and pending messages seed the deduplication ledger. The previous global-sequence ledger is rebuilt for scoped sequences, and any pre-ack consume cursor is reset so migration prefers possible redelivery over message loss. IDs for messages already acknowledged before the upgrade no longer exist and cannot be backfilled. Until the Hub is upgraded, a new client falls back to the legacy peek-and-ack path, so scoped sequence, causal-link, and persistent acknowledgment guarantees require the new Hub.

When the receiving extension acknowledges a successfully injected message, the same storage transaction advances its cursor and creates a durable `delivery_receipt` in the sender's Inbox; acknowledging the receipt removes it without creating another receipt. Messages arriving while the Agent is active use OMP's steer queue rather than becoming stale follow-up turns.

## Trust model

omp-a2a is designed for a fully trusted private network. Hub endpoints intentionally do not authenticate senders.
Caller-supplied project and sender identities remain trusted claims for `send`. Registration separately issues an opaque lease used to authorize heartbeat, unregister, Inbox read, and acknowledgment; member listings never expose this lease.
An active membership remains bound to the Hub that accepted it. Changing `hubUrl` affects unjoined operations, while joined status, send, receive, heartbeat, and leave continue through the bound Hub until an explicit membership transition.
Do not expose the Hub to the public Internet or an untrusted network.

## Current operational constraints

- **Custom protocol:** this repository implements a private Mesh protocol, not the standard A2A protocol. Do not assume interoperability with standard A2A clients or servers.
- **Interrupted Project deletion:** Project metadata is removed from the filesystem Registry before its SQLite Inbox state is purged. After a crash or storage failure during deletion, verify or clear the old Project state before reusing the same Project name.
- **Stalled requests:** the initial Hub probe has a timeout, but ordinary Hub requests currently do not. A Hub that accepts connections without completing responses can stall Inbox polling and accumulate heartbeat requests; restart the Hub and affected OMP session if this occurs.
- **Configuration fallback:** malformed global JSON configuration is ignored and URL resolution continues to the default. Prefer a repository-local config for explicit routing, and validate global configuration before relying on it.

These are current implementation boundaries, not delivery guarantees. The most important deployment boundary remains the trusted-network requirement above.

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

The Compose port mapping publishes the Hub on all host interfaces by default. If only local OMP clients need access, bind the published port to loopback by changing the mapping to:

```yaml
ports:
  - "127.0.0.1:${OMP_A2A_HUB_PORT:-4173}:4173"
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
/a2a send web please align the login API contract
# after the Hub returns ref=web:42:
/a2a send web corrected contract --reply-to-ref web:42
/a2a inbox
/a2a status
/a2a leave
/a2a project delete billing-rewrite
```

The model-facing `a2a` Tool exposes the same operations through the same `A2aOperations` module.

The Slash parser treats tokens beginning with `--` as command flags and does not implement shell-style quoting. For message text that must preserve flag-like tokens such as `--dry-run`, use the structured `a2a` Tool path rather than `/a2a send`.

`send` reports `queued` with the friendly `messageRef`; the opaque `msgId` remains in output details for idempotency and diagnostics. Inbox and inbound output use friendly refs such as `web:42` and show `replyToRef` when present. The sender extension later displays `[a2a delivered]` with the original `msgId` after the receiving extension acknowledges it. This proves receipt by the peer OMP extension, not that its model read, understood, or completed the work; semantic completion still requires a normal reply.

Replies arrive through the extension's background receiver and are injected into the session automatically. After `send`, Agents must not sleep or repeatedly call `inbox` to wait for a reply: continue independent work, or end the current turn if blocked so the reply can trigger a later turn. `inbox` is for one-off inspection or recovery only.

Project deletion is idempotent and removes its persisted Inbox. It is rejected until every member is offline.

## Verify

```bash
bun run smoke
```

This runs the Bun tests, Registry smoke, and a real Hub/HubClient smoke covering per-stream monotonic FIFO ordering, friendly message references, concurrent writes and duplicate reads, idempotent message IDs, causal replies, acknowledgment-driven persistent cursors, pre-ack failure and post-ack restart behavior, durable delivery receipts, legacy Inbox migration, gzip payloads, and safe Project deletion.

The verification command does not run a standalone TypeScript type check, a linter, or a Docker image/network smoke. Those remain separate release checks, and extension lifecycle behavior currently has substantially less automated coverage than the Hub persistence path.

## Layout

```text
src/
  operations.ts    # canonical Slash/Tool operations
  registry.ts      # Project and heartbeat membership persistence
  hub/server.ts    # standalone custom Mesh Hub
  hub/client.ts    # pure URL client
  hub/inbox.ts     # persistent SQLite Inbox
  hub/message-ref.ts # derived agent-facing message references
  hub/payload.ts   # text encoding, gzip, and decoded-size limits
  hub/cli.ts       # bun run hub
  extension.ts     # thin OMP adapters and background timers
```

Detailed repository maps are available in [`codemap.md`](codemap.md), [`src/codemap.md`](src/codemap.md), [`src/hub/codemap.md`](src/hub/codemap.md), and [`scripts/codemap.md`](scripts/codemap.md).
