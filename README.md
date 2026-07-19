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
  - persistent SQLite Inbox + explicit ack
  - custom Mesh send protocol
```

- **Hub:** owns all Project, membership, and Inbox state. OMP never starts it or reads its data directory.
- **Extension:** pure client; Slash and Tool adapters share one `A2aOperations` implementation.
- **Multiple Hubs:** supported when every Hub has a different URL and data directory. Projects with the same name on different Hubs are unrelated.

Messages below 32 KiB use an identity payload. Larger text is gzip-compressed on the Mesh wire. Decoded text is limited to 4 MiB. Inbox storage has no message-count cap; messages remain until the recipient acknowledges successful delivery.

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

Project creation, listing, membership, and messaging always go through the selected Hub.

## Usage

Inside OMP, after the selected Hub is running:

```text
/a2a hub
/a2a project create billing-rewrite
/a2a join billing-rewrite --as api --caps api,db
/a2a list
/a2a send web please align the login API contract
/a2a inbox
/a2a status
/a2a leave
```

The model-facing `a2a` Tool exposes the same operations through the same `A2aOperations` module.

## Verify

```bash
bun run smoke
```

This runs the Bun tests, Registry smoke, and a real Hub/HubClient smoke covering independent Hubs, heartbeat presence, duplicate rejection, trust-on-claim delivery, gzip payloads, explicit ack, and restart persistence.

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
