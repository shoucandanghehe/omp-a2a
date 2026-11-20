import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpBridge, type AcpBridgeOptions } from "../src/acp/bridge";
import { AcpClient } from "../src/acp/client";
import { HubClient } from "../src/hub/client";
import type { DeliveryEvent } from "../src/hub/realtime-types";
import { startHubServer } from "../src/hub/server";
import { A2aRuntime, type MessageView } from "../src/operations";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(overrides: Partial<AcpBridgeOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "omp-acp-"));
	const hub = await startHubServer({
		host: "127.0.0.1",
		port: 0,
		dataDir: root,
	});
	cleanup.push(async () => {
		await hub.stop();
		rmSync(root, { recursive: true, force: true });
	});
	const client = new HubClient(hub.listenUrl);
	await client.createRoom({ name: "acp" });
	const delivery = Promise.withResolvers<DeliveryEvent>();
	const reply = Promise.withResolvers<MessageView>();
	const peer = new A2aRuntime({
		getClient: async () => client,
		events: { onDelivery: delivery.resolve, onMessage: reply.resolve },
	});
	const bridge = new AcpBridge({
		hubUrl: hub.listenUrl,
		room: "acp",
		name: "worker",
		prompt: async (text) => ({
			text: `answer: ${text}`,
			stopReason: "end_turn",
		}),
		accept: async () => true,
		approveReply: async () => true,
		...overrides,
	});
	cleanup.push(async () => {
		await peer.disconnect();
	});
	cleanup.push(async () => {
		await bridge.close();
	});
	await peer.connect("acp", "operator");
	await bridge.connect();
	return { delivery, reply, peer, bridge };
}

test("ACP bridge acknowledges receipt early and sends ordinary replies without an authorization receipt", async () => {
	const turn = Promise.withResolvers<{ text: string; stopReason: string }>();
	const { delivery, reply, peer } = await setup({ prompt: () => turn.promise });
	const sent = await peer.message({ target: ["worker"], text: "hello" });
	expect(await delivery.promise).toMatchObject({ status: "delivered" });
	await Bun.sleep(2_050);
	turn.resolve({ text: "answer", stopReason: "end_turn" });
	const answer = await reply.promise;
	expect(answer).toMatchObject({
		text: "answer",
		replyTo: sent.message.messageRef,
	});
	expect(answer.userApproval).toBeUndefined();
}, 10_000);

test("ACP bridge does not forward a broadcast to the local agent", async () => {
	let calls = 0;
	const { delivery, peer } = await setup({
		accept: async () => {
			calls++;
			return true;
		},
	});
	await peer.message({ target: ["@all"], text: "hello" });
	expect(await delivery.promise).toMatchObject({ status: "failed" });
	expect(calls).toBe(0);
});

test("cancel discards an unfinished turn without asking to publish its reply", async () => {
	const start = Promise.withResolvers<AbortSignal>();
	const sawCancel = Promise.withResolvers<void>();
	let approvals = 0;
	const { peer, bridge } = await setup({
		prompt: (_text, signal) => {
			start.resolve(signal);
			return new Promise((_, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						sawCancel.resolve();
						reject(signal.reason);
					},
					{ once: true },
				);
			});
		},
		approveReply: async () => {
			approvals++;
			return true;
		},
	});
	await peer.message({ target: ["worker"], text: "hello" });
	const signal = await start.promise;
	expect(bridge.cancel()).toBe(true);
	await sawCancel.promise;
	await bridge.close();
	expect(signal.aborted).toBe(true);
	expect(approvals).toBe(0);
});

test("real Hub routes a direct message through an ACP stdio process", async () => {
	const acp = await AcpClient.start({
		command: process.execPath,
		args: [
			fileURLToPath(new URL("./fixtures/acp-agent.cjs", import.meta.url)),
			"basic",
		],
		cwd: process.cwd(),
	});
	cleanup.push(() => acp.close());
	const { peer, reply } = await setup({
		prompt: (text, signal) => acp.prompt(text, signal),
	});
	const sent = await peer.message({ target: ["worker"], text: "hello" });
	expect(await reply.promise).toMatchObject({
		text: "答🧪",
		replyTo: sent.message.messageRef,
	});
});

test("declining an inbound prompt or outbound reply never publishes it", async () => {
	const denied = Promise.withResolvers<void>();
	const draft = Promise.withResolvers<string>();
	const turns: string[] = [];
	const { peer, bridge } = await setup({
		accept: async (message) => {
			if (message.text === "first") {
				denied.resolve();
				return false;
			}
			return true;
		},
		prompt: async (text) => {
			turns.push(text);
			return { text: "draft", stopReason: "end_turn" };
		},
		approveReply: async (_message, text) => {
			draft.resolve(text);
			return false;
		},
	});
	await peer.message({ target: ["worker"], text: "first" });
	await denied.promise;
	await peer.message({ target: ["worker"], text: "second" });
	expect(await draft.promise).toBe("draft");
	await bridge.close();
	expect(turns).toEqual(["second"]);
	expect((await peer.history()).map((message) => message.text)).not.toContain(
		"draft",
	);
});
