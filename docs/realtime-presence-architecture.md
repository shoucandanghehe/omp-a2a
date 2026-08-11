# Anonymous realtime Presence architecture

**Status:** Implemented on 2026-08-08.

This decision supersedes the persistent-member, heartbeat-lease, HTTP Inbox, recipient cursor, and offline-delivery model.

## Context

The previous model persisted both Agent membership and message-consumption state. Correctness depended on registration leases, heartbeat ownership, per-recipient ordering, polling, acknowledgment transactions, durable receipts, and recovery rules around an Agent identity that could outlive its process.

Those mechanics did not match the actual product boundary: independent OMP sessions need a trusted realtime room, while messages—not durable Agent accounts—are the historical record.

## Decision

### Domain model

- A **Project** is a persistent room.
- A **Presence** exists if and only if one WebSocket is alive. It belongs to one Project and claims one temporary name.
- A **Message** is immutable, receives one monotonically increasing Project sequence, and remains until Project deletion. Optional attachments are immutable file-content values inside the Message, not independently identified objects.
- A **Delivery** is the in-memory outcome for one selected Presence: `delivered`, `failed`, or `disconnected`.

There is no offline, stale, durable member, recipient cursor, or offline-delivery state. A same-named later connection is a new Presence and inherits nothing from the old socket.

Direct messaging resolves one current name and binds the target `presenceId`. Project broadcast freezes the current Presence snapshot when the Hub accepts the message, excludes the sender, and never backfills later joiners. `replyTo` provides causality inside the same Project history.

### Transport and persistence

Private protocol version `3` reuses the Hub HTTP server:

- WebSocket `/v1/connect` carries handshake, Presence events, Messages with inline attachment content, acknowledgments, and Delivery outcomes.
- HTTP carries Hub metadata, Project administration, and explicit history queries.
- filesystem JSON stores Project metadata;
- in-memory indexes store Presence and pending delivery;
- SQLite `messages.sqlite` stores append-only Project history with WAL and `synchronous = FULL`.

Text below 32 KiB stays identity encoded; larger text uses gzip plus Base64. Attachment bytes use Base64 and use gzip first when smaller. One Message accepts at most eight attachments, with a 4 MiB decoded-content limit shared by text and attachment content. Decompression is bounded.

### Public interfaces

Humans administer Projects and their own connection through `/a2a`. Models receive exactly `a2a_peers`, `a2a_message`, and `a2a_history`. Connected model turns receive the current roster name and use only current peer results or inbound sender names for A2A addressing; disconnected turns receive no A2A identity prompt. Inbound messages are pushed into OMP serially in Hub-assigned Project sequence through `steer` delivery; there is no polling tool or user send/Inbox protocol surface.

`a2a_message` accepts optional current-session `local://` regular-file sources. The sender Extension snapshots their bytes before sending; the Hub never resolves sender-local URLs. Receiving and history-querying Extensions materialize new `local://` copies inside their own sessions before exposing the Message.

Repository configuration uses `name` and `autoConnect`. Removed `agentId` and `autoJoin` fields fail with an explicit migration error.

### Storage schema

`messages.sqlite` has an independent storage version. New storage creates the complete current schema atomically. Existing storage must contain exactly the current version and non-internal schema objects; startup fails closed rather than converting an incompatible database.

## Consequences

- Presence state is simple and observable: socket alive means present; socket closed means absent.
- Missing direct recipients fail immediately instead of creating latent work.
- Hub restart clears Presence and delivery state but preserves message history.
- `delivered` proves successful attachment materialization and injection into the receiving OMP extension, not model understanding or task completion. Materialization or injection errors produce a terminal `failed` Delivery.
- Direct routing is not confidential history. Without accounts and authorization, any trusted current Agent can query Project history.
- Hub and extension must upgrade together because the private wire protocol requires an exact version match.
- Project metadata deletion and SQLite history deletion remain separate operations; interrupted deletion requires operator inspection before name reuse.

## Verification

The behavior suite and executable smoke scenarios cover duplicate names, immediate Presence removal, direct-target failure, broadcast snapshots, causal replies, non-persistent Presence events, attachment snapshot/materialization/history, failed Delivery, restart persistence, exact current storage guards, the three-tool model surface, the reduced human command surface, and the Docker HTTP/WebSocket boundary.

## Deployment

Deploy matching Hub and extension versions together. If persistent storage does not have the exact current schema and storage version, initialize an empty data directory instead of converting it.
