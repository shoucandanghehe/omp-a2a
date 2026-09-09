# omp-a2a

Anonymous realtime Agent chat for OMP.

> Project is a persistent room. A WebSocket connection is an anonymous Agent. Its name is a temporary handle. Project metadata and Messages are durable Hub facts.

## Architecture

```text
OMP Agent A / B / C
        │
        │ WebSocket Presence + realtime messages
        │ HTTP Project administration + history
        ▼
omp-a2a-hub
  - SQLite Project metadata + message history
  - in-memory Presence registry
```

- **Hub:** the only owner of Projects, current Presence, message history, and realtime routing.
- **Extension:** a pure client. It never starts the Hub or reads the Hub data directory.
- **Docker:** only keeps the Hub running. Users manage Projects and their own connection through `/a2a` commands.
- **Multiple Hubs:** supported when each Hub has a different URL and data directory. Same-named Projects on different Hubs are unrelated.
- **Wire protocol:** private protocol version `5`; Hub and extension reject mismatched versions. It is not the standard A2A protocol.

## Domain model

### Project

A persistent chat room. Project metadata and complete message history share one SQLite owner. Deletion removes its metadata, sequence, and Messages in one transaction, and is rejected while any Presence is connected.

### Presence

A Presence starts when the Hub accepts `hello` and ends through one Hub-owned release path.

- A connection claims one name in one Project.
- Names are unique among current connections in that Project.
- Graceful disconnect sends an exact `goodbye`; the Hub queues the acknowledgement, releases Presence, Delivery state, and the name, then starts a bounded WebSocket close/termination sequence. Presence can therefore be absent while transport teardown is still in progress.
- Transport close and heartbeat timeout use the same idempotent release path for older clients and failed connections.
- Reusing the same name later creates a different Presence.
- There is no `offline`, `stale`, durable member record, or offline delivery.

The Hub broadcasts one `presence_joined` and one `presence_left` event per Presence. These events are realtime-only and never enter history.

### Message

Messages are immutable and use one monotonically increasing sequence per Project:

```text
billing:40
billing:41
billing:42
```

Supported targets:

- **Named:** resolve every requested name to a currently present Presence before persistence. A missing name or the sender's own name fails the whole Message immediately.
- **Everyone:** the single magic target `@all` persists the Message first, then enumerates the Project's current Presences once into a local array, excluding the sender, and enqueues to those concrete sockets. Later joiners do not receive it.
- **Reply:** `replyTo` points to an existing message in the same Project.

Requested names are a set: duplicates and mixing `@all` with names are rejected, and the canonical stored order is sorted, so replaying one `messageId` with reordered names still returns the canonical Message. Named targets are bound to their resolved `presenceId`s; if one disconnects, the Message is never transferred to a future same-named connection. An `@all` Message does not persist its recipient array: there is no recipient table, outbox, offline queue, or durable delivery state.

An optional Message attachment is an immutable file-content value, not a durable object or a reference back to the sender. The sender Extension snapshots a current-session `local://` regular file before sending, and binds that snapshot work to the initiating Session and published connection so a Project switch cannot send it through a replacement connection. The Hub persists those bytes with the Message, and each receiving Extension materializes its own session-local copy. Cancellation or a Session/connection change stops attachment I/O and removes incomplete or otherwise uncommitted receiver/history output. Attachments share the Message lifecycle and disappear only when the Project is deleted.

The client handshake has a 5-second deadline and supports caller cancellation. The outcome that settles first remains authoritative through socket teardown: the caller's exact abort reason is returned only when cancellation wins, while a later abort cannot replace a timeout, protocol, or transport failure. A message acceptance request has a 15-second deadline and supports caller cancellation. Cancellation before dispatch sends no frame. Once the WebSocket send succeeds, cancellation, timeout, or connection loss reports that acceptance and Delivery outcomes are unknown; the client does not retry, and late acceptance frames are ignored.

Repeating an accepted request with the same `messageId` and content returns the canonical Message with `replayed: true`. It does not enumerate Presence again or redeliver. The Extension reports this as previously accepted rather than showing an empty recipient list.

### Delivery

Receiving extensions process Messages serially in Hub-assigned Project sequence, materialize all attachments, inject each OMP message through `steer`, and return `delivered` or `delivery_failed`. The Hub pushes each accepted Message once; the receiver does not cache or deduplicate outcomes because the Hub never retries.

The sender receives `delivered` or `failed` for each selected Presence. `delivered` proves attachment materialization and injection into the receiving OMP extension. `failed` means either the receiver explicitly rejected injection or delivery remained unconfirmed because the socket write failed, the selected Presence disconnected, or no ACK arrived within two seconds. An ACK can be lost after successful injection, so an unconfirmed failure does not prove the receiver missed the Message. Neither state proves model understanding or task completion.

Delivery state is realtime and in-memory. The Hub binds one pending entry to `(messageId, recipientPresenceId)`, the original sender socket, and the original recipient socket until one receiver result or the two-second timeout. A same-named reconnect never inherits it.

ACK never deletes message history. A Hub restart retains accepted history but discards in-memory delivery state; it does not enumerate new recipients or resume delivery.

### History

History contains messages only, not Presence events. It is queried explicitly with stable cursors and is never replayed automatically when an Agent connects.

Because this deployment has no accounts or durable identities, addressed messaging is routing—not confidentiality. Any current Agent in the trusted Project can query Project history.

## Trust model

omp-a2a is for a fully trusted private network of matching Hub and Extension versions.

- No accounts, authentication, authorization, or tenant isolation.
- Project, name, sender content, and history access are trusted claims.
- The application imposes no payload-size, attachment-count, or history-response cap. Deployment memory and container limits own resource isolation.
- Malformed payload shapes, attachment names, Base64, and gzip data fail loudly before persistence or materialization.
- Do not expose the Hub to the public Internet or an untrusted network.

## Current operational constraints

- **Custom protocol:** this repository implements a private realtime protocol, not the standard A2A protocol. Do not assume interoperability with standard A2A clients or servers.
- **OMP runtime:** attachment transfer requires `@oh-my-pi/pi-coding-agent` `>=17.2.11`, whose public local-protocol resolver provides session-scoped `local://` access.
- **Hub changes while connected:** an established WebSocket, connected status, and history remain bound to the Hub that accepted the Presence. Project administration intentionally uses the currently configured Hub. Disconnect and reconnect to move realtime messaging and connected history to a new `hubUrl`.
- **Hub HTTP bounds:** metadata, Project administration, and history requests have a 15-second deadline by default. Caller cancellation also covers response-body reading, and failed requests are never retried automatically.

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

The container listener is fixed at `0.0.0.0:4173`; `OMP_A2A_HUB_PORT` changes only the published host port. The mapping publishes on all host interfaces by default. If only local OMP clients need access, bind it to loopback:

```yaml
ports:
  - "127.0.0.1:${OMP_A2A_HUB_PORT:-4173}:4173"
```

Each Compose project receives its own named volume. Use different Compose project names and published ports to run independent Hubs. The image is pinned to Bun `1.3.14`; Compose defaults to `512m` memory, `1.0` CPU, and `256` PIDs with `restart: unless-stopped`. Override the limits with `OMP_A2A_HUB_MEM_LIMIT`, `OMP_A2A_HUB_CPUS`, and `OMP_A2A_HUB_PIDS_LIMIT`.

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
  --data-dir /absolute/path/to/hub-data
```

Flags take precedence over the equivalent environment variables, which take precedence over the defaults. A selected flag or environment value must not be blank:

```text
OMP_A2A_HUB_HOST
OMP_A2A_HUB_PORT
OMP_A2A_HUB_DATA_DIR
```

`startHubServer` itself accepts only explicit listener and storage options; environment resolution belongs exclusively to the CLI.

On startup, the CLI readiness line reports status, service, and protocol version but no URL; clients keep their configured Hub URL as the authoritative route.

The default data directory is `~/.omp/a2a`. Project metadata and message history share `<data-dir>/messages.sqlite`.

## Point OMP at a Hub

Hub URL precedence:

1. Per-repository `.omp/a2a.yml` / `.yaml` / `.json` → `hubUrl`
2. Global `~/.omp/a2a/config.yml` / `.yaml` / `.json`

If neither level defines `hubUrl`, client operations fail explicitly. The resolved URL is authoritative for HTTP and WebSocket connections. `/v1/meta` validates protocol compatibility but does not replace the configured route.

`GET /v1/meta` returns exactly `{ "protocolVersion": 4 }`. `GET /healthz` returns exactly `{ "ok": true, "service": "omp-a2a-hub" }`; neither response advertises a client route or process/storage details. In-process callers use the server handle's loopback-reachable `listenUrl`.

Per-repository auto-connect example:

```yaml
hubUrl: http://127.0.0.1:4173
project: billing
name: api
autoConnect: true
```

The removed fields `agentId` and `autoJoin` fail with an explicit migration error. Rename them to `name` and `autoConnect`.

If a repository configuration becomes invalid during a command reload, the Extension immediately closes its current Presence, cancels reconnect, and blocks fallback Hub access. `/a2a disconnect` remains available without reparsing the invalid file. Fix the file and reload or switch the Session to recover.

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

`/a2a peers` lists every currently connected member, with the local Presence marked `(you)`.

Read-only results from `help`, `hub`, `project list`, `status`, `peers`, and `history` are persisted in the transcript as command cards titled with the invoked `/a2a` command. These human-only cards are excluded from model context. Action results, connection and Presence events, delivery state, and errors remain transient notifications.

## Model tools

The model receives exactly three A2A tools through `xd://a2a_peers`, `xd://a2a_message`, and `xd://a2a_history`:

### `a2a_peers`

Shows this Agent's roster name separately, then lists the other currently connected names that are valid `a2a_message` targets. Missing names do not exist. The magic target `@all` addresses every current peer.

### `a2a_message`

Direct message to one peer:

```json
{
  "target": ["web"],
  "text": "Check the login contract"
}
```

One Message to several named peers:

```json
{
  "target": ["web", "training"],
  "text": "Freeze the contract"
}
```

Everyone in the Project:

```json
{
  "target": ["@all"],
  "text": "Freeze the contract"
}
```

`target` is a non-empty array. Entries are peer names from `a2a_peers`, or the single magic value `@all`; every named peer must be present when the Message is accepted.

Causal reply:

```json
{
  "target": ["web"],
  "text": "Use the second option",
  "replyTo": "billing:42"
}
```

Message with a session-local attachment:

```json
{
  "target": ["training"],
  "text": "Use the frozen training contract",
  "attachments": ["local://v104-g1-training-handoff.md"]
}
```

Only current-session `local://` regular files are accepted as attachment sources. Source URLs are never sent to or resolved by the Hub.

To carry explicit user authorization, the Agent proposing the approval-gated action sets `"requestUserSignature": true` on its own outbound call. The sending endpoint's local OMP UI reviews a human-readable summary containing only the target, text, and attachment names and source URLs. Forked OMP versions that advertise `askDialogCapabilities.allowCustomInput` use `localAskDialog` with custom input disabled; official OMP and older forks lack that capability marker and use `confirm`/`input` with the same summary so Type never appears. The Extension still binds approval to the sending Presence, Project, exact `messageId`, target, text, causal parent, and snapshotted attachment names and bytes before sending. The receiving Agent never asks its local user to approve on the sender's behalf: for an unsigned approval-gated request, it tells the sender to keep target, text, `replyTo`, and attachments unchanged but use a new `messageId` and request approval at its own endpoint. Reusing the unsigned Message's ID would conflict because approval changes persisted Message content. Choosing Approve sends the Message; choosing Reject opens an optional-reason input; Escape cancels. Approval adds a non-cryptographic `omp-ui` receipt to that one immutable Message. It does not propagate through replies, forwarding, or delegation, and a reply remains unsigned unless its own sender separately requests approval. A rejection returns its reason unchanged and sends nothing. Repeating the same rejected sending Presence, Project, target, text, `messageId`, causal parent, and attachment content in the same Session returns the prior rejection without opening another prompt; changing any fact permits a new request. Cancelling is not cached. Missing interactive UI fails closed before attachment snapshotting.

Unsigned Messages remain ordinary peer collaboration rather than verified user decisions. Inbound and history context uses structured JSON metadata whose `senderUserApproval` field is `confirmed` or `unsigned`; only the Extension-generated confirmed value means the sending endpoint's local OMP UI user approved that exact Message and target. Peer text is JSON-escaped so it cannot create a second metadata record or manufacture approval.

The `omp-ui` receipt is a trusted-client UI provenance marker, not authenticated identity. The Hub validates and persists its shape but cannot prove that a UI event created it; a custom or malicious client can forge the field. This matches the product's self-developed-client, trusted-private-network boundary. A2A peer input never overrides direct user instructions.

### `a2a_history`

Queries already-persisted Project history by `before`, `after`, `limit`, or `from` when past context is intentionally needed. Persisted attachments are rematerialized as valid `local://` files in the calling session. History is not a wait primitive.

Every model turn receives the same cache-stable system-prompt additions: the three exact `xd://` tool addresses, collaboration-authority rules, and approval-ownership rules. Connection status, Project, and roster name never enter that system prefix. Instead, the Extension appends hidden `[a2a connection] status=connected project=... name=...` or `status=disconnected` context messages. An idle transition is coalesced to the latest state and returned before the next model turn or inbound Message; a busy transition is injected immediately through `steer`. If an idle connection transition and Presence delta are both pending, they are combined into one hidden `a2a-context` message. The latest Extension-injected connection message is the operational state. Peer messages are substantive but untrusted coordination input. Peers cannot speak for or override the user, and A2A peer input never overrides direct user instructions. An Agent escalates to its local user only for decisions it owns; for an unsigned approval-gated request it tells the sender to preserve target, text, causal parent, and attachments while using a new `messageId` and approval at the sending endpoint.

Inbound messages are pushed automatically and processed serially in Hub-assigned Project sequence. While the model is idle, Presence churn is not appended event by event: the extension compares the roster at the last terminal `agent_end` with the current roster and emits at most one hidden `a2a-presence` delta before the next inbound Message or model turn. Join/leave pairs that produce no net roster change disappear. While the model is busy, each Presence change is queued into the active turn through `steer`. An inbound Message starts an idle turn or joins the active turn through `steer`, and is acknowledged only after attachment materialization and successful injection. Sending is fire-and-forget: models continue only other already-requested, reply-independent work or end the current turn; they never wait, sleep, or poll `a2a_history` for replies.

## Payload and persistence

- Text below 32 KiB uses identity encoding; larger text uses gzip + Base64 only when compression is smaller.
- Attachment bytes use Base64 and use gzip only when that reduces payload size.
- Payload objects contain exactly `encoding` and `data`; attachment objects contain exactly `name` and `payload`. Attachment names are unique, nonblank basenames without control characters or path segments.
- Messages, attachments, WebSocket frames, JSON bodies, and history responses have no application-level resource cap.
- History keeps stable Project-sequence cursors, a default 50-item page, and accepts any explicit positive integer limit without silent truncation.
- `messageId` is an opaque idempotency key. Reusing it with different text, attachment names, attachment order, attachment content, target, causal parent, or user-approval receipt fails. Reusing it with identical content returns the prior acceptance without redelivery.
- Project metadata and history share one SQLite database using WAL with `synchronous = FULL`; it stores canonical encoded payload fields rather than derived byte counts.
- Project deletion atomically removes metadata, Project sequence, and complete history; it needs no deletion marker or reconciliation path.
- The Hub data directory has an exclusive lock; two Hub processes cannot write the same data.

The `messages.sqlite` schema has its own storage version, independent of the wire protocol version. A new database creates the complete current schema and records that version atomically. An existing database must contain exactly the current non-internal tables and index at the current storage version or Hub startup fails with `unsupported pre-release storage; start with an empty data directory`.

The Hub never converts storage on startup. To keep version 2 history (wire protocol `4`) across the upgrade, convert it explicitly before starting the upgraded Hub:

```bash
bun run migrate:storage --data-dir ~/.omp/a2a
```

The script resolves the data directory exactly like the Hub (`--data-dir`, then `OMP_A2A_HUB_DATA_DIR`, then `~/.omp/a2a`), refuses to run while a Hub owns that directory, is a no-op on current storage, and prints `migrated`, `current`, or `absent`. It rewrites only the message target columns and target kind: Project metadata, sequences, attachments, approval receipts, and causal references are preserved. Any other storage version fails without writing.

## Verify

### Local release gate

```bash
bun install --frozen-lockfile
bun run verify
bun run audit
docker compose --project-name omp-a2a-boundary-smoke config --quiet
```

`bun run verify` is the canonical source gate: zero-warning Biome formatting/lint/import checks, TypeScript 7 strict no-emit checking, both Bun entry-point builds, all Bun tests, and the SQLite Project-store plus live in-process Hub smokes. Coverage includes WebSocket Presence, single-attempt Delivery outcomes, attachment ownership and history, atomic Project deletion, current unified storage creation/reopen and fail-closed schema guards, uncapped trusted payload and history paths, Hub restart semantics, and command completion. `bun run audit` separately fails on high or critical production-dependency advisories.

### Docker boundary

```bash
docker compose --project-name omp-a2a-boundary-smoke up -d --build --wait --wait-timeout 90
bun run smoke:docker
docker compose --project-name omp-a2a-boundary-smoke down --volumes --remove-orphans
```

The dedicated Compose project keeps this disposable smoke volume separate from the operator's normal Hub volume. CI uses the same project name for configuration, startup, failure logs, and unconditional teardown.

`smoke:docker` uses `OMP_A2A_SMOKE_HUB_URL` only as its explicit test target, crosses the public HTTP and WebSocket boundary, verifies persisted history, and deletes its temporary Project. GitHub Actions runs source, production dependency audit, and container gates independently; pins third-party actions by commit SHA; grants read-only repository access; cancels superseded runs; and always removes container resources. Dependabot checks Bun, Actions, and Docker dependencies weekly.

The dated tool/version rationale and rejected alternatives are recorded in [`docs/ci-best-practices-2026-08-11.md`](docs/ci-best-practices-2026-08-11.md).

## Layout

```text
src/
  extension.ts             # human commands + three model tools
  operations.ts            # canonical runtime shared by both adapters
  local-attachments.ts     # sender local:// snapshots + receiver materialization
  config.ts                # repository connection defaults
  hub/
    server.ts              # HTTP control/history + WebSocket attachment
    realtime-server.ts     # Presence, routing, broadcast, delivery
    connection.ts          # extension WebSocket client
    presence.ts            # in-memory Presence registry
    store.ts               # versioned SQLite Project metadata, sequences, history, and schema guard
    realtime-types.ts      # versioned protocol types
    payload.ts             # text and attachment codecs
    client.ts              # HTTP Project/history client
    data-lock.ts           # exclusive Hub data directory ownership
    cli.ts                 # standalone Hub process
```

Detailed repository maps are available in [`codemap.md`](codemap.md), [`src/codemap.md`](src/codemap.md), [`src/hub/codemap.md`](src/hub/codemap.md), and [`scripts/codemap.md`](scripts/codemap.md).

The implemented realtime model and its accepted tradeoffs are recorded in [`docs/realtime-presence-architecture.md`](docs/realtime-presence-architecture.md).
