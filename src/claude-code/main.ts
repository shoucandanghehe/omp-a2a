#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { A2aBridge } from "./bridge";

const dataRoot =
	process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.tmpdir(), "omp-a2a-claude");
const bridge = new A2aBridge({
	cwd: process.cwd(),
	inboxRoot: path.join(dataRoot, "inbox"),
	nameOverride: process.env.A2A_NAME?.trim() || undefined,
	log: (line) => console.error(line),
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	try {
		await bridge.close();
	} finally {
		process.exit(0);
	}
}

const transport = new StdioServerTransport();
transport.onclose = () => void shutdown();
process.stdin.on("end", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await bridge.server.connect(transport);
