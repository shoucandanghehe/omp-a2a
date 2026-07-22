# Repository Atlas: omp-a2a

## Project Responsibility

`omp-a2a` is a private-network collaboration mesh for multiple Oh My Pi (OMP) processes working across independent project directories. A standalone Hub owns project membership and durable point-to-point inbox state; the OMP extension is an HTTP-only client that exposes the same application operations through a slash command and a model-facing tool.

The project deliberately implements a custom Mesh protocol rather than the standard A2A protocol. It assumes fully trusted callers and does not authenticate Hub requests.

## System Entry Points

- `src/extension.ts`: OMP extension loaded through `package.json#omp.extensions`; registers `/a2a`, the `a2a` tool, session hooks, heartbeat polling, and inbound-message injection.
- `src/hub/cli.ts`: `omp-a2a-hub` executable and `bun run hub` entry point; parses server options and owns signal-driven shutdown.
- `src/hub/server.ts`: standalone Express HTTP server and Hub resource lifecycle.
- `src/operations.ts`: canonical `A2aOperations` application service shared by the slash and tool adapters.
- `scripts/smoke.ts`: direct registry/configuration smoke scenario.
- `scripts/smoke-hub.ts`: live Hub/client, persistence, and messaging smoke scenario.

## Architecture

```text
OMP session
  ├─ /a2a command
  └─ a2a tool
          │
          ▼
    A2aOperations
          │ typed HubClient/fetch
          ▼
    standalone Express Hub
      ├─ filesystem Registry
      │   ├─ projects/<project>/project.json
      │   └─ projects/<project>/members/<agentId>.json
      └─ SQLite Inbox
          ├─ pending envelopes
          ├─ per-recipient sequences and cursors
          ├─ durable idempotency/causal ledger
          └─ acknowledgments and delivery receipts
```

### Control plane

Project CRUD, registration, heartbeat presence, member listing, and unregister operations pass from `A2aOperations` through `HubClient` to Hub routes backed by `src/registry.ts`. Registration issues an opaque lease token; heartbeat and unregister require it, and stale/offline takeover rotates it. Presence remains time-based: clients heartbeat every 5 seconds; records become stale after 15 seconds and offline after 60 seconds. A Hub data-directory lock prevents two server processes from owning the same persistent state.

### Message plane

1. `HubClient.send` encodes text and posts a message with an opaque idempotency key.
2. The Hub validates the claimed identity syntax, recipient, causal parent, payload, message ID, and request bounds.
3. `InboxStore` transactionally allocates a sequence scoped to `(project, recipient)`, records the durable ledger entry, and enqueues the envelope.
4. The receiving extension polls with its current membership lease without consuming, injects the envelope as an OMP `steer` or `followUp`, then acknowledges it with the same lease.
5. The acknowledgment transaction removes the pending row, advances the cursor, records acknowledgment state, and enqueues one delivery receipt with a Hub-reserved `receipt:` ID for the original sender. A trust-on-claim sender must register before consuming that receipt stream.

This is at-least-once delivery around the injection/acknowledgment boundary. Consumers must deduplicate by `messageId` because a crash after injection and before acknowledgment causes redelivery.

### Payload and reference contracts

- Text below 32 KiB remains identity encoded; larger text uses gzip plus Base64.
- Decoded text is capped at 4 MiB before or during decompression.
- `messageRef` uses `<recipient>:<serverSequence>` for agent-facing references.
- `replyTo` and `replyToRef` must be non-blank and resolve to the same-project, same-participant-pair conversation.
- Inbox read limits are integers from 1 through 1,000; reads are ordered only by the Hub-assigned per-stream sequence, while timestamps are diagnostic.

## Configuration and Deployment

Hub URL precedence is:

1. per-repository `.omp/a2a.yml`, `.yaml`, or `.json`;
2. `OMP_A2A_HUB_URL`;
3. global `~/.omp/a2a/config.yml`, `.yaml`, or `.json`;
4. `http://127.0.0.1:4173`.

The Hub runs locally with `bun run hub` or through `docker compose`. The CLI resolves deployment environment variables, while programmatic `startHubServer` calls use explicit options, reject explicitly blank data directories, and expose a process-reachable `listenUrl`. `Dockerfile` installs production dependencies under the unprivileged `bun` user, exposes port `4173`, persists `/data/omp-a2a`, and supplies an HTTP health check. Compose derives the advertised loopback URL from the published port unless explicitly overridden.

## Configuration Boundaries

The first existing global config candidate is authoritative: read, parse, schema, or missing-URL errors fail explicitly rather than falling through. The shared minimal YAML parser removes comments only outside quoted values. Extension session, Slash, and Tool adapters contain local-config failures, while Slash `send` preserves unknown flag-like text and supports bare `--` as an option delimiter.

## Root Asset Map

| Asset | Responsibility |
| --- | --- |
| `package.json` | Bun package metadata, OMP extension registration, executable Hub bin, and `typecheck`/`lint`/`smoke`/`check` scripts. |
| `bun.lock` | Locked production and static-check dependency graph. |
| `tsconfig.json` | Strict no-emit TypeScript contract covering source, smoke scripts, and tests against Bun and the installed OMP API. |
| `README.md` | Architecture, trust model, installation, operation, configuration, usage, and verification contract. |
| `config.example.yml` | Minimal global Hub URL configuration example. |
| `.env.example` | Docker Compose environment example. |
| `Dockerfile` | Standalone Hub production image. |
| `docker-compose.yml` | Single-Hub service, port publication, health check, restart policy, and named persistent volume. |
| `.github/workflows/ci.yml` | Pinned-Bun CI with frozen dependency install and the complete `bun run check` contract. |

## Repository Directory Map

| Directory | Responsibility | Detailed Map |
| --- | --- | --- |
| `src/` | OMP adapter, shared application operations, configuration, domain types, paths, and filesystem registry. | [View map](src/codemap.md) |
| `src/hub/` | HTTP client/server, wire codec, SQLite inbox, ordering, acknowledgment, locking, and CLI lifecycle. | [View map](src/hub/codemap.md) |
| `scripts/` | Assertion-driven direct-registry and live-Hub smoke scenarios. | [View map](scripts/codemap.md) |
| `tests/` | Bun behavior tests for control-plane isolation, inbox durability, ordering, idempotency, causality, delivery semantics, operations, and the extension tool contract. | No generated codemap; tests are excluded from codemap state. |
| `docs/` | Historical review material and remediation traceability. | No generated codemap; documentation is excluded from codemap state. |
| `.github/` | Continuous integration workflow. | No generated codemap; workflow configuration is mapped in the root asset table. |

## Verification

`bun run check` runs strict TypeScript no-emit checking, Oxlint, the complete Bun test suite, and both executable smoke scenarios. The 99-test suite covers Hub/data-directory isolation, lease ownership and stale-owner fencing, Hub-bound membership, successful and failed Extension lifecycle transitions, active-request cancellation, configured Hub changes, request deadlines, malformed successful responses, single-flight heartbeat, deployment-environment isolation, advertised/listener URL separation, fail-closed configuration, quote-aware YAML, Slash message parsing, blank data-directory rejection, registration and identity validation, bounded shutdown, online identity conflicts, durable Inbox restart, byte/count-bounded pages, acknowledgment batch limits, receipt ID reservation, gzip boundaries, batched schema migration, stream ordering, idempotent message IDs, causal references, explicit acknowledgments, cursor durability, at-least-once redelivery, delivery receipts, storage-error mapping, recoverable project deletion, startup cleanup, and the shared operations layer.

CI installs the locked dependency graph under Bun 1.3.14 and runs the same `bun run check` command. Docker image and real container/network behavior remain separate release checks.

## Operational Boundary

The Hub does not authenticate project access or caller-provided sender claims. Opaque leases fence registered-member lifecycle and Inbox consumption, but they are not a substitute for network authentication or authorization. Deployment must remain on a fully trusted private network and must not expose the service to the public Internet or untrusted clients. The default Compose port mapping publishes on all host interfaces; use a loopback bind or an equivalent firewall boundary when remote access is unnecessary.
