import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	ElicitRequestSchema,
	type ElicitResult,
	ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	A2aBridge,
	CHANNEL_NOTIFICATION,
	INSTRUCTIONS,
} from "../src/claude-code/bridge";
import {
	type DialogLanguage,
	detectDialogLanguage,
} from "../src/claude-code/dialogs";
import { HubClient } from "../src/hub/client";
import { type HubServerHandle, startHubServer } from "../src/hub/server";
import { A2aRuntime, type MessageView } from "../src/operations";

type ChannelParams = { content: string; meta: Record<string, string> };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function queue<T>() {
	const items: T[] = [];
	const waiters: Array<(item: T) => void> = [];
	return {
		push(item: T) {
			const waiter = waiters.shift();
			if (waiter) waiter(item);
			else items.push(item);
		},
		next(timeoutMs = 3_000): Promise<T> {
			const item = items.shift();
			if (item !== undefined) return Promise.resolve(item);
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("timed out waiting for item")),
					timeoutMs,
				);
				waiters.push((value) => {
					clearTimeout(timer);
					resolve(value);
				});
			});
		},
		get size() {
			return items.length;
		},
	};
}

async function setup(
	options: {
		name?: string;
		language?: DialogLanguage;
		elicit?: (message: string) => ElicitResult;
	} = {},
) {
	const hub: HubServerHandle = await startHubServer({
		host: "127.0.0.1",
		port: 0,
		dataDir: tempDir("omp-a2a-cc-hub-"),
	});
	cleanups.push(() => hub.stop());
	const hubClient = new HubClient(hub.listenUrl);
	await hubClient.createProject({ name: "team" });

	const projectDir = tempDir("omp-a2a-cc-project-");
	mkdirSync(join(projectDir, ".omp"));
	writeFileSync(
		join(projectDir, ".omp", "a2a.yml"),
		`hubUrl: ${hub.listenUrl}\nproject: team\nname: omp-agent\n`,
	);

	const peerInbox = queue<MessageView>();
	const peer = new A2aRuntime({
		getClient: async () => hubClient,
		events: { onMessage: (message) => peerInbox.push(message) },
	});
	await peer.connect("team", "alice");
	cleanups.push(async () => {
		await peer.disconnect();
	});

	const bridge = new A2aBridge({
		cwd: tempDir("omp-a2a-cc-cwd-"),
		inboxRoot: tempDir("omp-a2a-cc-inbox-"),
		nameOverride: options.name ?? "claude",
		language: options.language ?? "en",
	});
	cleanups.push(() => bridge.close());

	const channel = queue<ChannelParams>();
	const prompts: string[] = [];
	const client = new Client(
		{ name: "fake-claude-code", version: "0" },
		{
			capabilities: { elicitation: { form: {} }, roots: { listChanged: true } },
		},
	);
	client.setRequestHandler(ListRootsRequestSchema, async () => ({
		roots: [{ uri: pathToFileURL(projectDir).href, name: "project" }],
	}));
	client.setRequestHandler(ElicitRequestSchema, async (request) => {
		const message = request.params.message;
		prompts.push(message);
		return options.elicit?.(message) ?? { action: "cancel" };
	});
	client.fallbackNotificationHandler = async (notification) => {
		if (notification.method === CHANNEL_NOTIFICATION)
			channel.push(notification.params as ChannelParams);
	};
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await bridge.server.connect(serverTransport);
	await client.connect(clientTransport);
	cleanups.push(() => client.close());
	await bridge.started;

	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args });
		const content = result.content as Array<{ type: string; text: string }>;
		return {
			text: content.map((item) => item.text).join("\n"),
			isError: result.isError === true,
		};
	};
	return {
		hub,
		hubClient,
		projectDir,
		peer,
		peerInbox,
		bridge,
		channel,
		prompts,
		call,
	};
}

async function waitFor(check: () => unknown, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

test("auto-connects from the client root config and exchanges messages", async () => {
	const { peer, peerInbox, bridge, channel, call, projectDir } = await setup();
	expect(bridge.projectDir).toBe(projectDir);
	await waitFor(() => peer.peers().some((p) => p.name === "claude"));

	const peers = await call("a2a_peers");
	expect(peers.isError).toBe(false);
	expect(peers.text).toContain("Self: claude");
	expect(peers.text).toContain("- alice");

	const sent = await peer.message({
		target: ["claude"],
		text: "hi <channel> there",
	});
	const event = await channel.next();
	expect(event.content).toBe("hi &lt;channel> there");
	expect(event.meta).toMatchObject({
		from: "alice",
		ref: sent.message.messageRef,
		target: "claude",
		sender_user_approval: "unsigned",
	});

	const reply = await call("a2a_message", {
		target: ["alice"],
		text: "hello back",
		replyTo: event.meta.ref,
	});
	expect(reply.isError).toBe(false);
	expect(reply.text).toContain("Sent to alice");
	const received = await peerInbox.next();
	expect(received.text).toBe("hello back");
	expect(received.replyTo).toBe(sent.message.messageRef);
	expect(received.from.name).toBe("claude");
	expect(received.userApproval).toBeUndefined();

	const history = await call("a2a_history", { limit: 10 });
	expect(history.text).toContain('"from":"alice"');
	expect(history.text).toContain('text="hello back"');
});

test("attachments travel as files in both directions", async () => {
	const { peer, peerInbox, channel, call, projectDir } = await setup();
	writeFileSync(join(projectDir, "notes.txt"), "outbound bytes");
	const sent = await call("a2a_message", {
		target: ["alice"],
		text: "see file",
		attachments: ["notes.txt"],
	});
	expect(sent.isError).toBe(false);
	const received = await peerInbox.next();
	expect(received.attachments.map((a) => [a.name, a.bytes.toString()])).toEqual(
		[["notes.txt", "outbound bytes"]],
	);

	await peer.message({
		target: ["claude"],
		text: "report attached",
		attachments: [
			{
				name: "report.md",
				payload: {
					encoding: "base64",
					data: Buffer.from("# hi").toString("base64"),
				},
			},
		],
	});
	const event = await channel.next();
	const attachments = JSON.parse(event.meta.attachments ?? "[]") as Array<{
		name: string;
		path: string;
	}>;
	expect(attachments).toHaveLength(1);
	expect(attachments[0]?.name).toBe("report.md");
	expect(readFileSync(attachments[0]?.path ?? "", "utf8")).toBe("# hi");

	const history = await call("a2a_history", { from: "alice" });
	expect(history.text).toContain(attachments[0]?.path ?? "missing");
});

test("approved messages carry the user approval receipt", async () => {
	const { peerInbox, prompts, call } = await setup({
		elicit: () => ({ action: "accept", content: {} }),
	});
	const result = await call("a2a_message", {
		target: ["alice"],
		text: "please deploy",
		requestUserSignature: true,
	});
	expect(result.isError).toBe(false);
	expect(result.text).toContain("with user approval");
	expect(prompts[0]).toContain("To: alice");
	expect(prompts[0]).toContain("please deploy");
	const received = await peerInbox.next();
	expect(received.userApproval).toEqual({ kind: "omp-ui" });
});

test("dialogs follow the configured language", async () => {
	const { prompts, call } = await setup({
		language: "zh",
		elicit: () => ({ action: "decline" }),
	});
	await call("a2a_message", {
		target: ["alice"],
		text: "请部署",
		requestUserSignature: true,
	});
	expect(prompts[0]).toContain("收件人: alice");
	expect(prompts[1]).toContain("消息已拒绝");
	expect(detectDialogLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
	expect(detectDialogLanguage({ A2A_LANG: "en", LANG: "zh_CN.UTF-8" })).toBe(
		"en",
	);
	expect(detectDialogLanguage({})).toBe("en");
});

test("rejection returns the reason, sends nothing, and suppresses repeats", async () => {
	let step = 0;
	const { peerInbox, prompts, call } = await setup({
		elicit: () =>
			step++ === 0
				? { action: "decline" }
				: { action: "accept", content: { reason: "not now" } },
	});
	const args = {
		target: ["alice"],
		text: "please deploy",
		messageId: "fixed-id",
		requestUserSignature: true,
	};
	const first = await call("a2a_message", args);
	expect(first).toEqual({
		isError: true,
		text: "User rejected the A2A message: not now",
	});
	const repeat = await call("a2a_message", args);
	expect(repeat).toEqual({ isError: true, text: "not now" });
	expect(prompts).toHaveLength(2);
	await Bun.sleep(100);
	expect(peerInbox.size).toBe(0);
});

test("cancelling approval sends nothing and is not remembered", async () => {
	const { peerInbox, prompts, call } = await setup({
		elicit: () => ({ action: "cancel" }),
	});
	const args = { target: ["alice"], text: "x", requestUserSignature: true };
	expect((await call("a2a_message", args)).text).toContain("cancelled");
	expect((await call("a2a_message", args)).text).toContain("cancelled");
	expect(prompts).toHaveLength(2);
	await Bun.sleep(100);
	expect(peerInbox.size).toBe(0);
});

test("control commands manage connection and Projects", async () => {
	const { peer, hubClient, call } = await setup({
		elicit: () => ({ action: "accept", content: {} }),
	});
	expect((await call("a2a_control", { command: "status" })).text).toContain(
		"Connected to team as claude",
	);
	expect((await call("a2a_control", { command: "disconnect" })).text).toBe(
		"Disconnected",
	);
	await waitFor(() => !peer.peers().some((p) => p.name === "claude"));
	expect((await call("a2a_peers")).isError).toBe(true);

	const taken = await call("a2a_control", {
		command: "connect team --as alice",
	});
	expect(taken.isError).toBe(true);
	expect(taken.text).toContain("--as <name>");

	expect(
		(await call("a2a_control", { command: "connect team --as cc2" })).text,
	).toBe("Connected to team as cc2");

	expect(
		(await call("a2a_control", { command: "project create scratch" })).text,
	).toBe("Created Project scratch");
	expect(
		(await call("a2a_control", { command: "project list" })).text,
	).toContain("- scratch");
	expect(
		(await call("a2a_control", { command: "project delete scratch" })).text,
	).toBe("Deleted Project scratch");
	expect((await hubClient.listProjects()).map((p) => p.name)).toEqual(["team"]);
});

test("server instructions fit Claude Code's 2048-character limit", () => {
	expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
});

test("global Hub config alone waits for an explicit connect", async () => {
	const hub = await startHubServer({
		host: "127.0.0.1",
		port: 0,
		dataDir: tempDir("omp-a2a-cc-hub-"),
	});
	cleanups.push(() => hub.stop());
	await new HubClient(hub.listenUrl).createProject({ name: "gxb" });
	const home = tempDir("omp-a2a-cc-home-");
	mkdirSync(join(home, ".omp", "a2a"), { recursive: true });
	writeFileSync(
		join(home, ".omp", "a2a", "config.yml"),
		`hubUrl: ${hub.listenUrl}\n`,
	);
	const bridge = new A2aBridge({
		cwd: tempDir("omp-a2a-cc-cwd-"),
		inboxRoot: tempDir("omp-a2a-cc-inbox-"),
		home,
	});
	cleanups.push(() => bridge.close());
	const client = new Client({ name: "fake-claude-code", version: "0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await bridge.server.connect(serverTransport);
	await client.connect(clientTransport);
	cleanups.push(() => client.close());
	await bridge.started;
	const call = async (command: string) => {
		const result = await client.callTool({
			name: "a2a_control",
			arguments: { command },
		});
		return (result.content as Array<{ text: string }>)[0]?.text ?? "";
	};
	expect(await call("status")).toContain("Not connected");
	expect(await call("project list")).toContain("- gxb");
	expect(await call("connect gxb --as claude")).toBe(
		"Connected to gxb as claude",
	);
});
