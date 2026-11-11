# omp-a2a

English | [简体中文](README.zh-CN.md)

Anonymous realtime Agent chat for OMP.

> Room is a persistent room. A WebSocket connection is an anonymous Agent. Its name is a temporary handle. Room metadata and Messages are durable Hub facts.

## Architecture

```text
OMP Agent A / B / C
        │
        │ WebSocket Presence + realtime messages
        │ HTTP Room administration + history
        ▼
omp-a2a-hub
  - SQLite Room metadata + message history
  - in-memory Presence registry
```

- **Hub:** the only owner of Rooms, current Presence, message history, and realtime routing.
- **Extension:** a pure client. It never starts the Hub or reads the Hub data directory.
- **Docker:** only keeps the Hub running. Users manage Rooms and their own connection through `/a2a` commands.
- **Multiple Hubs:** supported when each Hub has a different URL and data directory. Same-named Rooms on different Hubs are unrelated.
- **Wire protocol:** private protocol version `6`; Hub and extension reject mismatched versions. It is not the standard A2A protocol.

## Domain model

### Room

A persistent chat room. Room metadata and complete message history share one SQLite owner. Deletion removes its metadata, sequence, and Messages in one transaction, and is rejected while any Presence is connected.

### Presence

A Presence starts when the Hub accepts `hello` and ends through one Hub-owned release path.

- A connection claims one name in one Room.
- Names are unique among current connections in that Room.
- Graceful disconnect sends an exact `goodbye`; the Hub releases Presence, Delivery state, and the name, broadcasts `presence_left`, then queues the acknowledgement and starts a bounded WebSocket close/termination sequence. Presence can therefore be absent while transport teardown is still in progress.
- Transport close and heartbeat timeout use the same idempotent release path for older clients and failed connections.
- Reusing the same name later creates a different Presence.
- There is no `offline`, `stale`, durable member record, or offline delivery.

The Hub broadcasts `presence_joined` when a Presence is claimed and one `presence_left` on its ordinary departure. Hub shutdown instead clears runtime state and terminates sockets without broadcasting departures. These events are realtime-only and never enter history.

### Message

Messages are immutable and use one monotonically increasing sequence per Room:

```text
billing:40
billing:41
billing:42
```

Supported targets:

- **Named:** resolve every requested name to a currently present Presence before persistence. A missing name or the sender's own name fails the whole Message immediately.
- **Everyone:** the single magic target `@all` persists the Message first, then enumerates the Room's current Presences once into a local array, excluding the sender, and enqueues to those concrete sockets. Later joiners do not receive it.
- **Reply:** `replyTo` points to an existing message in the same Room.

Requested names are a set: duplicates and mixing `@all` with names are rejected, and the canonical stored order is sorted, so replaying one `messageId` with reordered names still returns the canonical Message. Named targets are bound to their resolved `presenceId`s; if one disconnects, the Message is never transferred to a future same-named connection. An `@all` Message does not persist its recipient array: there is no recipient table, outbox, offline queue, or durable delivery state.

An optional Message attachment is an immutable file-content value, not a durable object or a reference back to the sender. The sender Extension snapshots a current-session `local://` regular file before sending, and binds that snapshot work to the initiating Session and published connection so a Room switch cannot send it through a replacement connection. The Hub persists those bytes with the Message, and each receiving Extension materializes its own session-local copy. Cancellation or a Session/connection change stops attachment I/O and removes incomplete or otherwise uncommitted receiver/history output. Attachments share the Message lifecycle and disappear only when the Room is deleted.

The client handshake has a 5-second deadline and supports caller cancellation. The outcome that settles first remains authoritative through socket teardown: the caller's exact abort reason is returned only when cancellation wins, while a later abort cannot replace a timeout, protocol, or transport failure. A message acceptance request has a 15-second deadline and supports caller cancellation. Cancellation before dispatch sends no frame. Once the WebSocket send succeeds, cancellation, timeout, or connection loss reports that acceptance and Delivery outcomes are unknown; the client does not retry, and late acceptance frames are ignored.

Repeating an accepted request with the same `messageId` and content returns the canonical Message with `replayed: true`. It does not enumerate Presence again or redeliver. The Extension reports this as previously accepted rather than showing an empty recipient list.

### Delivery

Receiving extensions process Messages serially in Hub-assigned Room sequence, materialize all attachments, inject each OMP message through `steer`, and return `delivered` or `delivery_failed`. The Hub pushes each accepted Message once; the receiver does not cache or deduplicate outcomes because the Hub never retries.

The sender receives `delivered` or `failed` for each selected Presence. `delivered` proves attachment materialization and injection into the receiving OMP extension. `failed` means either the receiver explicitly rejected injection or delivery remained unconfirmed because the socket write failed, the selected Presence disconnected, or no ACK arrived within two seconds. An ACK can be lost after successful injection, so an unconfirmed failure does not prove the receiver missed the Message. Neither state proves model understanding or task completion.

Delivery state is realtime and in-memory. The Hub binds one pending entry to `(messageId, recipientPresenceId)`, the original sender socket, and the original recipient socket until one receiver result or the two-second timeout. A same-named reconnect never inherits it.

ACK never deletes message history. A Hub restart retains accepted history but discards in-memory delivery state; it does not enumerate new recipients or resume delivery.

### History

History contains messages only, not Presence events. It is queried explicitly with stable cursors and is never replayed automatically when an Agent connects.

Because this deployment has no accounts or durable identities, addressed messaging is routing—not confidentiality. Any current Agent in the trusted Room can query Room history.

## Trust model

omp-a2a is for a fully trusted private network of matching Hub and Extension versions.

- No accounts, authentication, authorization, or tenant isolation.
- Room, name, sender content, and history access are trusted claims.
- The application imposes no payload-size, attachment-count, or history-response cap. Deployment memory and container limits own resource isolation.
- Malformed payload shapes, attachment names, Base64, and gzip data fail loudly before persistence or materialization.
- Do not expose the Hub to the public Internet or an untrusted network.

## Current operational constraints

- **Custom protocol:** this repository implements a private realtime protocol, not the standard A2A protocol. Do not assume interoperability with standard A2A clients or servers.
- **OMP runtime:** attachment transfer requires OMP `>=18.3.2`; the extension uses the session-scoped `local://` router to locate files without bypassing protocol path checks.
- **Tern native UI:** when OMP's TSP backend is active, inbound messages and tool views use native cards, member tables, and Markdown message sections. Message cards show sender/target names, message references, replies, and attachments—not protocol IDs or duplicate metadata. Approved messages use success-colored chrome, with sender-user approval explained on hover. OMP owns terminal negotiation and input; ordinary terminals use the same compact inbound presentation through ANSI rendering. Model context and Hub messaging are unchanged.
- **Hub changes while connected:** an established WebSocket, connected status, and history remain bound to the Hub that accepted the Presence. Room administration intentionally uses the currently configured Hub. Disconnect and reconnect to move realtime messaging and connected history to a new `hubUrl`.
- **Hub HTTP bounds:** metadata, Room administration, and history requests have a 15-second deadline by default. Caller cancellation also covers response-body reading, and failed requests are never retried automatically.

These are current implementation boundaries, not delivery guarantees. The most important deployment boundary remains the trusted-network requirement above.

## Install

Use Bun `>=1.3.14`; the repository toolchain and Docker image are pinned to `1.4.3`.

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
docker compose up -d --build --wait --wait-timeout 90
curl -s http://127.0.0.1:4173/healthz
OMP_A2A_SMOKE_HUB_URL=http://127.0.0.1:4173 bun run smoke:docker
docker compose logs -f hub
```

These examples use host port `4173`. If you change the published port, update the health-check and smoke URLs too. Set the smoke URL explicitly so it cannot select another Hub from your normal client configuration.

The container listener is fixed at `0.0.0.0:4173`; `OMP_A2A_HUB_PORT` changes only the published host port. The mapping publishes on all host interfaces by default. If only local OMP clients need access, bind it to loopback:

```yaml
ports:
  - "127.0.0.1:${OMP_A2A_HUB_PORT:-4173}:4173"
```

Each Compose project receives its own named volume. Use different Compose project names and published ports to run independent Hubs. The image is pinned to Bun `1.4.3`; Compose defaults to `512m` memory, `1.0` CPU, and `256` PIDs with `restart: unless-stopped`. Override the limits with `OMP_A2A_HUB_MEM_LIMIT`, `OMP_A2A_HUB_CPUS`, and `OMP_A2A_HUB_PIDS_LIMIT`.

Preserve the named data volume:

```bash
docker compose down
```

Delete the Hub and all Room history:

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

The default data directory is `~/.omp/a2a`. Room metadata and message history share `<data-dir>/messages.sqlite`.

## Point OMP at a Hub

Hub URL precedence:

1. Per-repository `.omp/a2a.yml` / `.yaml` / `.json` → `hubUrl`
2. Global `~/.omp/a2a/config.yml` / `.yaml` / `.json`

If neither level defines `hubUrl`, client operations fail explicitly. The resolved URL is authoritative for HTTP and WebSocket connections. `/v1/meta` validates protocol compatibility but does not replace the configured route.

`GET /v1/meta` returns exactly `{ "protocolVersion": 6 }`. `GET /healthz` returns exactly `{ "ok": true, "service": "omp-a2a-hub" }`; neither response advertises a client route or process/storage details. In-process callers use the server handle's `listenUrl`, which preserves an explicit bind host and maps wildcard IPv4/IPv6 binds to loopback.

Per-repository auto-connect example:

```yaml
hubUrl: http://127.0.0.1:4173
room: billing
name: api
autoConnect: true
```

The removed fields `agentId`, `autoJoin`, and `project` fail with an explicit migration error. Rename them to `name`, `autoConnect`, and `room`.

If a repository configuration becomes invalid during a command reload, the Extension immediately closes its current Presence, cancels reconnect, and blocks fallback Hub access. `/a2a disconnect` remains available without reparsing the invalid file. Fix the file and reload or switch the Session to recover.

## Human commands

Humans manage Rooms, their own connection, and read-only views:

```text
/a2a hub

/a2a room create billing
/a2a room list
/a2a room delete billing

/a2a connect billing --as api
/a2a disconnect

/a2a status
/a2a peers
/a2a history
/a2a history --before billing:42 --limit 20
/a2a history --from web
/a2a help
```

`/a2a room` is shorthand for `/a2a room list`. Bare `/a2a`, `/a2a --help`, and `/a2a -h` show help without loading configuration.

`/a2a` provides context-aware Tab completion for root commands, `room create|list|delete`, `connect ... --as`, and the remaining compatible `history` flags. `--before` and `--after` are never suggested together. Room names, Agent names, and message references remain explicit values.

Room deletion requires confirmation. Humans do not use send, broadcast, reply, Inbox, join, or leave protocol commands.

`/a2a peers` lists every currently connected member, with the local Presence marked `(you)`.

Read-only results from `help`, `hub`, `room list`, `status`, `peers`, and `history` are persisted in the transcript as command cards titled with the invoked `/a2a` command. These human-only cards are excluded from model context. Action results, connection and Presence events, delivery state, and errors remain transient notifications.

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

Everyone in the Room:

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

To carry explicit user authorization, the Agent proposing the approval-gated action sets `"requestUserSignature": true` on its own outbound call. The sending endpoint's local OMP UI reviews a human-readable summary containing only the target, text, and attachment names and source URLs. Forked OMP versions that advertise `askDialogCapabilities.allowCustomInput` use `localAskDialog` with custom input disabled; official OMP and older forks lack that capability marker and use `confirm`/`input` with the same summary so Type never appears. The Extension still binds approval to the sending Presence, Room, exact `messageId`, target, text, causal parent, and snapshotted attachment names and bytes before sending. The receiving Agent never asks its local user to approve on the sender's behalf: for an unsigned approval-gated request, it tells the sender to keep target, text, `replyTo`, and attachments unchanged but use a new `messageId` and request approval at its own endpoint. Reusing the unsigned Message's ID would conflict because approval changes persisted Message content. Choosing Approve sends the Message; choosing Reject opens an optional-reason input; Escape cancels. Approval adds a non-cryptographic `omp-ui` receipt to that one immutable Message. It does not propagate through replies, forwarding, or delegation, and a reply remains unsigned unless its own sender separately requests approval. A rejection returns its reason unchanged and sends nothing. Repeating the same rejected sending Presence, Room, target, text, `messageId`, causal parent, and attachment content in the same Session returns the prior rejection without opening another prompt; changing any fact permits a new request. Cancelling is not cached. Missing interactive UI fails closed before attachment snapshotting.

Approval previews show literal, wrapping text rather than fenced code blocks. Message line breaks remain visible, and the same target, full message, and attachment details stay available on both Approve and Reject.

Most peer requests need no signature; a missing signature does not make a request untrusted. A signature is for actions that need user approval, such as push, deploy, deleting data, or changing production: the sender's user approves the exact Message once, and that approval covers every recipient, so receivers never ask their own users. Inbound and history context uses structured JSON metadata whose `senderUserApproval` field is `confirmed` or `unsigned`. `confirmed` means the sender's user approved that Message: the receiver carries out the requested actions without asking its own user again. If an unsigned request asks for such an action, the receiver asks the sender to resend it with `requestUserSignature=true` and continues its other work. Peer text is JSON-escaped so it cannot create a second metadata record or manufacture approval.

The `omp-ui` receipt is a trusted-client UI provenance marker, not authenticated identity. The Hub validates and persists its shape but cannot prove that a UI event created it; a custom or malicious client can forge the field. This matches the product's self-developed-client, trusted-private-network boundary. Peer text alone cannot override direct user instructions or establish user approval.

### `a2a_history`

Queries already-persisted Room history by `before`, `after`, `limit`, or `from` when past context is intentionally needed. `before` and `after` are mutually exclusive; supplying both returns a parameter error before an HTTP request. Persisted attachments are rematerialized as valid `local://` files in the calling session. History is not a wait primitive.

Every model turn receives the same cache-stable system-prompt additions: the three exact `xd://` tool addresses, when to send and whom to address, how to handle peer requests, and approval rules. Connection status, Room, and roster name never enter that system prefix. Instead, the Extension appends hidden `[a2a connection] status=connected room=... name=...` or `status=disconnected` context messages. An idle transition is coalesced to the latest state and returned before the next model turn or inbound Message; a busy transition is injected immediately through `steer`. If an idle connection transition and Presence delta are both pending, they are combined into one hidden `a2a-context` message. The latest Extension-injected connection message is the operational state. Agents send only when a specific peer needs the message, choose recipients per message, report their own progress to their own user, and skip acknowledgements. A peer request is handled as a normal work request; a peer's report of what its user said does not override the receiver's user. A confirmed request executes without another approval; an unsigned request that needs approval returns to its sender for a signed resend.

Inbound messages are pushed automatically and processed serially in Hub-assigned Room sequence. While the model is idle, Presence churn is not appended event by event: the extension compares the roster at the last terminal `agent_end` with the current roster and emits at most one hidden `a2a-presence` delta before the next inbound Message or model turn. Join/leave pairs that produce no net roster change disappear. While the model is busy, each Presence change is queued into the active turn through `steer`. An inbound Message starts an idle turn or joins the active turn through `steer`, and is acknowledged only after attachment materialization and successful injection. Sending is fire-and-forget: models continue other work they already have or end the current turn; they never wait, sleep, or poll `a2a_history` for replies.

## Claude Code

`claude-code/` is a Claude Code plugin that joins a Claude Code session to the same Hub as a normal Presence. Its MCP server reuses the Hub protocol code in this repository and pushes inbound Messages into the session through [Channels](https://code.claude.com/docs/en/channels), so an idle session wakes up when a peer writes.

Requirements:

- Bun on `PATH` and `bun install` in this repository; the plugin loads in place and runs the sources directly.
- A claude.ai or Console login. Channels are a research preview gated by remote feature flags, so `DISABLE_TELEMETRY` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` must be unset; with either set, Claude Code reports "Channels are not currently available" and ignores the channel.
- Custom channels are not on the Anthropic allowlist, so every session needs `--dangerously-load-development-channels` and a startup confirmation.

Run for one session:

```bash
claude --plugin-dir ~/code/omp-a2a/claude-code \
  --dangerously-load-development-channels plugin:omp-a2a@inline
```

Or install it from the repository-local marketplace (still loaded in place):

```bash
claude plugin marketplace add ~/code/omp-a2a
claude plugin install omp-a2a@omp-a2a
claude --dangerously-load-development-channels plugin:omp-a2a@omp-a2a
```

The plugin reads the same `.omp/a2a.yml` and global Hub config as OMP, using the session's project root. Set `A2A_NAME` to override the configured roster name so an OMP session and a Claude Code session in one repository do not collide (`name_in_use` does not retry). Without a local config, connect with `/a2a connect <room> --as <name>`. Approval dialogs follow the locale (`A2A_LANG`, then `LC_ALL`, `LC_MESSAGES`, `LANG`); `zh*` shows Chinese, anything else English. Claude Code draws the Accept/Decline buttons itself, so they stay in English.

Behavior differences from the OMP Extension:

- Inbound Messages arrive as `<channel from ref target reply_to sender_user_approval attachments>` events. Attachments are written under the plugin data directory and referenced by path; outbound `attachments` are file paths relative to the project root.
- Claude Code does not acknowledge channel events, so `delivered` means the event was written to the session. Without the channel flag, events are silently dropped yet still reported as delivered.
- `requestUserSignature=true` opens an MCP elicitation dialog. Accept sends with the `omp-ui` receipt; Decline rejects and opens an optional reason prompt (Accept there submits the reason; Decline discards typed text); Escape cancels. The dialog collapses long text, so the full request is visible in the expanded tool call (`ctrl+o`).
- Presence joins and leaves are not pushed into model context; the model calls `a2a_peers`.
- `/a2a` asks the model to call `a2a_control` or `a2a_history`, so its results pass through model context.

## Payload and persistence

- Text below 32 KiB uses identity encoding; larger text uses gzip + Base64 only when compression is smaller.
- Attachment bytes use Base64 and use gzip only when that reduces payload size.
- Payload objects contain exactly `encoding` and `data`; attachment objects contain exactly `name` and `payload`. Attachment names are unique, nonblank basenames without control characters or path segments.
- Messages, attachments, WebSocket frames, JSON bodies, and history responses have no application-level resource cap.
- History keeps stable Room-sequence cursors, a default 50-item page, and accepts any explicit positive integer limit without silent truncation.
- `messageId` is an opaque idempotency key. Reusing it with different text, attachment names, attachment order, attachment content, target, causal parent, or user-approval receipt fails. Reusing it with identical content returns the prior acceptance without redelivery.
- Room metadata and history share one SQLite database using WAL with `synchronous = FULL`; it stores canonical encoded payload fields rather than derived byte counts.
- Room deletion atomically removes metadata, Room sequence, and complete history; it needs no deletion marker or reconciliation path.
- The Hub data directory has an exclusive lock; two Hub processes cannot write the same data.

The `messages.sqlite` schema has its own storage version, currently `4`, independent of wire protocol version `6`. A new database creates the three current tables (`rooms`, `room_sequences`, and `messages`), the sender-history index, and the version atomically. An existing database must contain exactly the current non-internal tables and index at the current storage version or Hub startup fails with `unsupported pre-release storage; start with an empty data directory`.

The Hub never converts storage on startup. To keep version 3 history (wire protocol `5`) across the upgrade, stop the owning Hub, back up its data directory, and convert it explicitly before starting the upgraded Hub:

```bash
bun run migrate:storage --data-dir ~/.omp/a2a
```

The script resolves the data directory exactly like the Hub (`--data-dir`, then `OMP_A2A_HUB_DATA_DIR`, then `~/.omp/a2a`), refuses to run while a Hub owns that directory, is a no-op on current storage, and prints a JSON result with `outcome: "migrated" | "current" | "absent"`. In one transaction it renames `projects` to `rooms`, `project_sequences` to `room_sequences`, the namespace columns to `room`, `project_sequence` to `room_sequence`, and the sender-history index to `messages_room_sender`, and advances the storage version from 3 to 4. Every row and value is preserved, including Room metadata, sequences, attachments, approval receipts, and causal references. Other storage versions are rejected without conversion. After a migration commits, the CLI reopens through `HubStore` to validate the resulting schema; this check does not roll back a committed migration. A `current` result checks only the version, not the complete schema; Hub startup still applies the full schema guard.

## Verify

### Local release gate

```bash
bun install --frozen-lockfile
bun run verify
bun run audit
docker compose --project-name omp-a2a-boundary-smoke config --quiet
```

`bun run verify` is the canonical source gate: zero-warning Biome formatting/lint/import checks, TypeScript 7 strict no-emit checking, both Bun entry-point builds, all Bun tests, and the SQLite Room-store plus live in-process Hub smokes. Coverage includes WebSocket Presence, single-attempt Delivery outcomes, attachment ownership and history, atomic Room deletion, current unified storage creation/reopen and fail-closed schema guards, uncapped trusted payload and history paths, Hub restart semantics, and command completion. `bun run audit` separately fails on high or critical production-dependency advisories.

### Docker boundary

```bash
docker compose --project-name omp-a2a-boundary-smoke up -d --build --wait --wait-timeout 90
OMP_A2A_SMOKE_HUB_URL=http://127.0.0.1:4173 bun run smoke:docker
docker compose --project-name omp-a2a-boundary-smoke down --volumes --remove-orphans
```

The dedicated Compose project keeps this disposable smoke volume separate from the operator's normal Hub volume. CI uses the same project name for configuration, startup, failure logs, and unconditional teardown.

`smoke:docker` targets `OMP_A2A_SMOKE_HUB_URL` when set; otherwise it resolves the normal global client configuration. It crosses the public HTTP and WebSocket boundary, verifies persisted history, and deletes its temporary Room. GitHub Actions runs source, production dependency audit, and container gates independently; pins third-party actions by commit SHA; grants read-only repository access; cancels superseded runs; and always removes container resources. Dependabot checks Bun, Actions, and Docker dependencies weekly.

The dated tool/version rationale and rejected alternatives are recorded in [`docs/ci-best-practices-2026-08-11.md`](docs/ci-best-practices-2026-08-11.md).

## Layout

```text
claude-code/               # Claude Code plugin (manifest, /a2a command, entry)
src/
  extension.ts             # human commands + three model tools
  operations.ts            # canonical runtime shared by commands and model tools
  local-attachments.ts     # sender local:// snapshots + receiver materialization
  config.ts                # repository connection defaults
  config-document.ts       # shared YAML/JSON parsing and owner-supplied schema validation
  paths.ts                 # Hub storage and configuration paths
  types.ts                 # Room/config shapes and name validation
  claude-code/
    bridge.ts              # MCP server: channel delivery, tools, approval dialogs
    attachments.ts         # file-path attachment snapshots + inbox copies
    dialogs.ts             # localized approval dialog text
    main.ts                # stdio entry used by the plugin
  hub/
    server.ts              # HTTP control/history + WebSocket attachment
    realtime-server.ts     # Presence, routing, broadcast, delivery
    connection.ts          # extension WebSocket client
    presence.ts            # in-memory Presence registry
    store.ts               # versioned SQLite Room metadata, sequences, history, and schema guard
    realtime-types.ts      # versioned protocol types
    payload.ts             # text and attachment codecs
    client.ts              # HTTP Room/history client
    data-lock.ts           # exclusive Hub data directory ownership
    cli.ts                 # standalone Hub process
    types.ts               # metadata and encoded payload shapes
scripts/
  migrate-storage.ts       # explicit locked storage version 3 to 4 migration
  smoke.ts                 # persistent SQLite Room-store scenario
  smoke-hub.ts             # in-process HTTP/WebSocket Hub scenarios
  smoke-docker.ts          # public boundary scenario against a selected running Hub
```

Detailed repository maps are available in [`codemap.md`](codemap.md), [`src/codemap.md`](src/codemap.md), [`src/hub/codemap.md`](src/hub/codemap.md), and [`scripts/codemap.md`](scripts/codemap.md).

The implemented realtime model and its accepted tradeoffs are recorded in [`docs/realtime-presence-architecture.md`](docs/realtime-presence-architecture.md).
