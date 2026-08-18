# Anonymous realtime Presence architecture

**Status:** Implemented on 2026-08-08.

This decision supersedes the persistent-member, heartbeat-lease, HTTP Inbox, recipient cursor, and offline-delivery model.

## Context

The previous model persisted both Agent membership and message-consumption state. Correctness depended on registration leases, heartbeat ownership, per-recipient ordering, polling, acknowledgment transactions, durable receipts, and recovery rules around an Agent identity that could outlive its process.

Those mechanics did not match the actual product boundary: independent OMP sessions need a trusted realtime room, while messages—not durable Agent accounts—are the historical record.

## Decision

### Domain model

- A **Project** is a persistent room.
- A **Presence** starts when the Hub accepts `hello` and ends when the Hub runs its idempotent release path. An exact `goodbye` releases it before the old WebSocket transport necessarily finishes closing; transport close and heartbeat timeout are the fallback release triggers.
- A **Message** is immutable, receives one monotonically increasing Project sequence, and remains until Project deletion. Optional attachments are immutable file-content values inside the Message, not independently identified objects.
- A **Delivery** is one in-memory `delivered` or `failed` outcome for one selected Presence.

There is no offline, stale, durable member, recipient cursor, or offline-delivery state. A same-named later connection is a new Presence and inherits nothing from the old socket.

Direct messaging resolves one current name and binds the target `presenceId`. Project broadcast freezes the current Presence snapshot when the Hub accepts the message, excludes the sender, and never backfills later joiners. `replyTo` provides causality inside the same Project history.

### Transport and persistence

Private protocol version `4` reuses the Hub HTTP server:

- WebSocket `/v1/connect` carries handshake, Presence events, Messages with inline attachment content, acknowledgments, and Delivery outcomes. Failed handshake teardown preserves whichever timeout, protocol, transport, or caller-cancellation outcome settled first.
- HTTP carries Hub metadata, Project administration, and explicit history queries.
- SQLite `messages.sqlite`, owned by the canonical `HubStore`, stores Project metadata, each Project's sequence, and append-only message history with WAL and `synchronous = FULL`.
- in-memory indexes store Presence and one short-lived ACK record per selected recipient.

Text below 32 KiB stays identity encoded. Larger text uses gzip plus Base64 only when compression is smaller; attachment bytes use Base64 and the same compression rule. Payload and attachment objects have exact wire shapes, Base64 is canonical, and attachment names are unique safe basenames. Matching Hub and Extension versions are trusted for resource use, so Messages, attachments, transport frames, and history responses have no application resource cap or derived byte metadata. Malformed payloads fail loudly; deployment memory and container limits provide resource isolation.

### Public interfaces

Humans administer Projects and their own connection through `/a2a`. Models receive exactly `a2a_peers`, `a2a_message`, and `a2a_history`. Connected model turns receive the current roster name and use only current peer results or inbound sender names for A2A addressing; disconnected turns receive no A2A identity prompt. Inbound messages are pushed into OMP serially in Hub-assigned Project sequence through `steer` delivery; there is no polling tool or user send/Inbox protocol surface.

`a2a_message` accepts optional current-session `local://` regular-file sources. The sender Extension snapshots their bytes before sending; the Hub never resolves sender-local URLs. Receiving and history-querying Extensions materialize new `local://` copies inside their own sessions before exposing the Message.

`a2a_message` may request an interactive OMP user signature for one exact Message. Forked OMP uses its local-only, scrollable `localAskDialog`; original OMP builds without that interface fall back to host-local `confirm`/`input` without a message-size limit. Collaboration guests cannot answer either path; the model cannot create the receipt, and missing interactive UI fails closed before attachment snapshotting. A control-safe fenced JSON review contains the target selector, text, causal parent, attachment sources, and attachment payload hashes. The canonical Message persists the resulting non-cryptographic receipt and exposes a structured `userApproval` value of `confirmed` or `none` in realtime and history context, with peer text JSON-escaped behind an unambiguous record boundary. Approval does not propagate through forwarding, rejection sends nothing and may return an exact user reason, and cancellation is not cached.

The receipt is client-declared within the trusted private protocol. The Hub validates and persists it but does not attest that an OMP UI created it; malicious or custom clients can forge it. It prevents accidental model-side authority escalation among matching self-developed clients, not hostile-client impersonation.

Repository configuration uses `name` and `autoConnect`; Hub selection is explicit at the repository or global config level, with no client environment or loopback fallback. Removed `agentId` and `autoJoin` fields fail with an explicit migration error.

### Storage schema

`messages.sqlite` has an independent storage version. New storage creates the complete current schema atomically. Existing storage must contain exactly the current version and non-internal schema objects; startup fails closed rather than converting an incompatible database.

## Consequences

- Presence state is simple and observable: a successfully claimed socket is present until Hub release; graceful release and bounded transport teardown are separate steps.
- Missing direct recipients fail immediately instead of creating latent work.
- Hub restart clears Presence and delivery state but preserves message history.
- `delivered` proves successful attachment materialization and injection into the receiving OMP extension, not model understanding or task completion. Materialization or injection errors produce `failed`; write errors, disconnects, and missing ACKs also produce `failed` with an explicit unconfirmed reason.
- The Hub sends each Message frame once and retains no receiver outcome cache. An ACK lost after injection can therefore produce an unconfirmed failure even though the receiver injected successfully.
- Direct routing is not confidential history. Without accounts and authorization, any trusted current Agent can query Project history.
- Hub and extension must upgrade together because private protocol version `4` requires an exact match and has no compatibility path for version `3` Message frames.
- Matching-version clients are trusted to produce valid internal payloads. Removing application payload and history resource caps keeps the path linear, while deployment resource isolation contains failures.
- Project deletion is rejected while that Project has an active Presence, then removes its metadata, sequence, and message history in one SQLite transaction.

## Verification

The behavior suite and executable smoke scenarios cover duplicate names, immediate Presence removal, direct-target failure, broadcast snapshots, causal replies, single-attempt Delivery acknowledgements and failures, non-persistent Presence events, bounded teardown, attachment ownership and history, uncapped trusted payload and history paths, restart persistence, exact current storage guards, the model and human surfaces, and the Docker HTTP/WebSocket boundary.

## Deployment

Deploy matching Hub and extension versions together. If persistent storage does not have the exact current schema and storage version, initialize an empty data directory instead of converting it.
