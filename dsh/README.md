# Native DSH A2A adapter (local draft)

This package joins **one explicitly selected existing live DSH session** to one
omp-a2a Room. It is not ACP, does not launch another model process, does not
resume stored sessions, and does not mirror assistant output to peers.

## Build and install locally

From the root of an omp-a2a checkout, install the shared sources' build
dependencies first, then build the Node plugin:

```sh
bun install --frozen-lockfile
cd dsh
npm ci --ignore-scripts
npm run check
npm pack
# User-operated installation, not performed by these tests:
dsh plugin --profile web add ./dsh-omp-a2a-0.1.0.tgz
```

The bundled patch is **disabled by default**. Override its `omp-a2a` row in the
profile patch, set `disabled: false`, and replace **all** config keys:
`hubUrl` (HTTP(S) origin), `room`, unique roster `name`, and the exact live
`sessionId`. The Room must already exist. Verify with `dsh --profile web --dump-config`.
Do not use a session name, cwd, or another process's session ID.

The build incorporates the repository's existing pure WebSocket wire v6 client,
not a copied implementation. It excludes Hub persistence, HubClient and Bun-only
configuration parsing. The built package runs in Node and keeps DSH host packages
external so Cordis shares the host's service instances. The draft pins DSH
`0.2.2-rc.5`; other releases are not claimed compatible.

## Behavior and limits

- Starts when the configured session exists, or waits for its creation. Never
  selects another session and never calls `create`, `resume`, `cancel`, or `dispose`
  on the borrowed Agent. Same-ID replacements are rejected; disposal ends binding.
- Inbound text enters `followup`, not `steer`. Delivery ACK means successful inbox
  insertion, not model admission, understanding, or completion. Later local
  cancellation can discard an acknowledged inbox item.
- The selected Agent alone gets `a2a_peers` and `a2a_message`. Replies are deliberate
  model tool calls with `replyTo`; no stream, thought, history, or tool log forwarding.
- Relay text is JSON-framed and explicitly distinguished from the local user's
  instructions. Sender receipts are provenance only and never bypass DSH policy.
- Tool execution remains in DSH's normal policy pipeline. Signature requests fail
  with an explicit error and send nothing until a native user approval flow is
  implemented. The plugin never manufactures an `omp-ui` receipt.
- Direct messages only; broadcasts, blank text, and text over 64 KiB UTF-8 are rejected in both directions. Optional `allowedPeers` restricts both directions and the roster; `[]` denies all peers. Omission trusts every directly addressing peer in the explicitly configured private Room. Names are not authentication.
- Text only: inbound attachments fail explicitly. Outbound schema offers no file
  parameter. No history tool, Room administration, reconnect, or multi-Room support.
- Tool definitions stay fixed for the lifetime of the bound Agent, even if the
  Hub is offline or the initial connection failed. Calls report the connection
  failure without sending or retrying. Reload the plugin to retry the connection;
  it does not fall back to another session or Hub.
- Plugin unload closes only its own socket and scoped tool child plugin. It does not
  cancel work already accepted into the user's inbox.
- Hub has no authentication or tenant isolation; use only the existing trusted
  private deployment. Enabling this plugin grants peers access to the selected
  Agent's context via prompts, subject to its local tool permissions.

## Validation performed

Strict TypeScript against the published rc.5 APIs; Node unit tests with controlled
Agent/context/transport doubles; esbuild Node bundle and Node import without Bun.
A real installed Cordis + DSH ToolsService test additionally verifies selected-agent scoping, unchanged definitions across Hub disconnect, and unload. These are not a real DSH UI/model run or real Hub end-to-end test. Before release,
verify actual Cordis agent scoping and local permission UI in a disposable DSH
profile, plus one visible message in each direction with an actual OMP peer.
