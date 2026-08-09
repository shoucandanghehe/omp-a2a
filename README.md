# omp-a2a

Anonymous realtime Agent chat for OMP.

> Project is a room. A WebSocket connection is an anonymous Agent. Its name is a temporary handle. Messages are the only persistent record.

## Architecture

```text
OMP Agent A / B / C
        │
        │ WebSocket Presence + realtime messages
        │ HTTP Project administration + history
        ▼
omp-a2a-hub
  - persistent Project metadata
  - in-memory Presence registry
  - append-only SQLite message history
```

- **Hub:** the only owner of Projects, current Presence, message history, and realtime routing.
- **Extension:** a pure client. It never starts the Hub or reads the Hub data directory.
- **Docker:** only keeps the Hub running. Users manage Projects and their own connection through `/a2a` commands.
- **Multiple Hubs:** supported when each Hub has a different URL and data directory. Same-named Projects on different Hubs are unrelated.
- **Wire protocol:** private protocol version `2`; Hub and extension reject mismatched versions. It is not the standard A2A protocol.

## Domain model

### Project

A persistent chat room. Project deletion removes its complete message history and is rejected while any Presence is connected.

### Presence

A Presence exists if and only if its WebSocket is alive.

- A connection claims one name in one Project.
- Names are unique among current connections in that Project.
- Closing or timing out the socket immediately removes the Presence and releases the name.
- Reusing the same name later creates a different Presence.
- There is no `offline`, `stale`, durable member record, or offline delivery.

The Hub broadcasts `presence_joined` and `presence_left` events to current peers. These events are realtime-only and never enter history.

### Message

Messages are immutable and use one monotonically increasing sequence per Project:

```text
billing:40
billing:41
billing:42
```

Supported targets:

- **Direct:** resolve one currently present name. Missing recipient fails immediately.
- **Project:** broadcast to the Presence snapshot taken when the Hub accepts the message. The sender is excluded and later joiners do not receive it.
- **Reply:** `replyTo` points to an existing message in the same Project.

A direct target is bound to the resolved `presenceId`. If it disconnects, the message is never transferred to a future same-named connection.

### Delivery

Receiving extensions acknowledge successful OMP injection over the live socket. The sender receives `delivered` or `disconnected` for each target. Delivery proves transport into the peer extension, not model understanding or task completion.

Delivery state is realtime and in-memory. ACK never deletes message history.

### History

History contains messages only, not Presence events. It is queried explicitly with stable cursors and is never replayed automatically when an Agent connects.

Because this deployment has no accounts or durable identities, direct messaging is routing—not confidentiality. Any current Agent in the trusted Project can query Project history.

## Trust model

omp-a2a is for a fully trusted private network.

- No accounts, authentication, authorization, or tenant isolation.
- Project, name, sender content, and history access are trusted claims.
- Do not expose the Hub to the public Internet or an untrusted network.

## Current operational constraints

- **Custom protocol:** this repository implements a private realtime protocol, not the standard A2A protocol. Do not assume interoperability with standard A2A clients or servers.
- **Hub changes while connected:** an established WebSocket remains bound to the Hub that accepted it. After changing `hubUrl`, disconnect and reconnect before issuing Project or history operations against the new Hub.
- **Interrupted Project deletion:** Project metadata is removed from the filesystem Registry before its SQLite message history is purged. After a crash or storage failure during deletion, verify or clear the old Project state before reusing the same Project name.
- **Stalled HTTP requests:** the initial Hub probe has a timeout, but ordinary Project and history requests currently do not. A Hub that accepts connections without completing responses can stall the invoking command; restart the Hub and affected OMP session if this occurs.

These are current implementation boundaries, not delivery guarantees. The most important deployment boundary remains the trusted-network requirement above.

## Install

```bash
cd ~/code/omp-a2a
bun install
ln -sfn ~/code/omp-a2a ~/.omp/agent/extensions/omp-a2a
```

Restart OMP after linking.

## Run the Hub

### Docker Compose

```bash
cd ~/code/omp-a2a
docker compose up -d --build
curl -s http://127.0.0.1:4173/healthz
bun run smoke:docker
docker compose logs -f hub
```

The Compose port mapping publishes the Hub on all host interfaces by default. If only local OMP clients need access, bind the published port to loopback by changing the mapping to:

```yaml
ports:
  - "127.0.0.1:${OMP_A2A_HUB_PORT:-4173}:4173"
```

Each Compose project receives its own named volume. Use different Compose project names and published ports to run independent Hubs.

Preserve the named data volume:

```bash
docker compose down
```

Delete the Hub and all Project history:

```bash
docker compose down -v
```

### Local process

```bash
bun run hub
```

Options:

```bash
bun run hub -- \
  --host 127.0.0.1 \
  --port 4173 \
  --public-url http://127.0.0.1:4173 \
  --data-dir /absolute/path/to/hub-data
```

Equivalent environment variables:

```text
OMP_A2A_HUB_HOST
OMP_A2A_HUB_PORT
OMP_A2A_HUB_PUBLIC_URL
OMP_A2A_HUB_DATA_DIR
```

The default data directory is `~/.omp/a2a`. Persistent history is `<data-dir>/messages.sqlite`.

## Point OMP at a Hub

First match wins:

1. Per-repository `.omp/a2a.yml` / `.yaml` / `.json` → `hubUrl`
2. `OMP_A2A_HUB_URL`
3. Global `~/.omp/a2a/config.yml` / `.yaml` / `.json`
4. `http://127.0.0.1:4173`

Per-repository auto-connect example:

```yaml
hubUrl: http://127.0.0.1:4173
project: billing
name: api
autoConnect: true
```

The removed fields `agentId` and `autoJoin` fail with an explicit migration error. Rename them to `name` and `autoConnect`.

## Human commands

Humans manage Projects, their own connection, and read-only views:

```text
/a2a hub

/a2a project create billing
/a2a project list
/a2a project delete billing

/a2a connect billing --as api
/a2a disconnect

/a2a status
/a2a peers
/a2a history
/a2a history --before billing:42 --limit 20
/a2a history --from web
/a2a help
```

`/a2a` provides context-aware Tab completion for root commands, `project create|list|delete`, `connect ... --as`, and the remaining compatible `history` flags. `--before` and `--after` are never suggested together. Project names, Agent names, and message references remain explicit values.

Project deletion requires confirmation. Humans do not use send, broadcast, reply, Inbox, join, or leave protocol commands.

## Model tools

The model receives exactly three A2A tools:

### `a2a_peers`

Lists the names currently present in this Project. Missing names do not exist.

### `a2a_message`

Direct message:

```json
{
  "target": { "type": "agent", "name": "web" },
  "text": "Check the login contract"
}
```

Project broadcast:

```json
{
  "target": { "type": "project" },
  "text": "Freeze the contract"
}
```

Causal reply:

```json
{
  "target": { "type": "agent", "name": "web" },
  "text": "Use the second option",
  "replyTo": "billing:42"
}
```

### `a2a_history`

Queries Project history by `before`, `after`, `limit`, or `from`.

Inbound messages are pushed automatically. Presence changes update the UI without starting an idle model turn. Messages trigger a turn and are acknowledged only after successful injection.

## Payload and persistence

- Text below 32 KiB uses identity encoding.
- Larger text uses gzip + base64 on the wire.
- Decoded text is limited to 4 MiB.
- `messageId` is an opaque idempotency key. Reusing it with different content fails.
- History uses SQLite WAL with `synchronous = FULL`.
- The Hub data directory has an exclusive lock; two Hub processes cannot write the same data.

On first start with an old `inbox.sqlite`, the Hub imports ordinary `message_ledger` rows into `messages.sqlite` in deterministic `(project, created_at, msg_id)` order. Old Presence, cursor, ACK, receipt, and offline-delivery state are not migrated. Pending messages become history only and are never delivered to future connections.

## Verify

### Local release gate

```bash
biome check .slim/codemap.json src tests scripts package.json
bun run smoke
bun build src/extension.ts --target=bun --outdir=/tmp/omp-a2a-extension-build
bun build src/hub/cli.ts --target=bun --outdir=/tmp/omp-a2a-hub-build
docker compose config
```

These commands check formatting, run the Bun tests plus Project Registry and live Hub/client smokes, build both executable entry points, and validate the Compose model. The behavioral coverage includes WebSocket Presence, name conflicts, Presence join/leave notifications, direct messaging, Project broadcast, delivery outcomes, Project history, legacy message migration, payload limits, Project deletion, Hub restart semantics, and command completion.

### Docker boundary

```bash
docker compose up -d --build --force-recreate --wait --wait-timeout 60 hub
bun run smoke:docker
```

`smoke:docker` targets the running Hub selected by `OMP_A2A_HUB_URL`, crosses the public HTTP and WebSocket boundary, verifies persisted history, and deletes its temporary Project. `bun run smoke` alone does not build or start a container.

## Layout

```text
src/
  extension.ts             # human commands + three model tools
  operations.ts            # canonical runtime shared by both adapters
  registry.ts              # persistent Project metadata only
  config.ts                # repository connection defaults
  hub/
    server.ts              # HTTP control/history + WebSocket attachment
    realtime-server.ts     # Presence, routing, broadcast, delivery
    connection.ts          # extension WebSocket client
    presence.ts            # in-memory Presence registry
    messages.ts            # append-only Project history + legacy migration
    realtime-types.ts      # versioned protocol types
    payload.ts             # gzip and decoded-size limits
    client.ts              # HTTP Project/history client
    data-lock.ts           # exclusive Hub data directory ownership
    cli.ts                 # standalone Hub process
```

Detailed repository maps are available in [`codemap.md`](codemap.md), [`src/codemap.md`](src/codemap.md), [`src/hub/codemap.md`](src/hub/codemap.md), and [`scripts/codemap.md`](scripts/codemap.md).

The implemented realtime model and its accepted tradeoffs are recorded in [`docs/realtime-presence-architecture.md`](docs/realtime-presence-architecture.md).
