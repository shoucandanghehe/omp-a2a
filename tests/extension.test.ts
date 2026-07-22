import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import a2aExtension from "../src/extension";
import { HubClient } from "../src/hub/client";
import { startHubServer, type HubServerHandle } from "../src/hub/server";

let hub: HubServerHandle | null = null;
let root: string | null = null;

afterEach(async () => {
	await hub?.stop();
	if (root) rmSync(root, { recursive: true, force: true });
	hub = null;
	root = null;
});

function schemaStub() {
	return {
		optional() {
			return this;
		},
	};
}

type TestTimerContext = {
	cwd: string;
	sessionId: string;
	timers: Map<number, { callback: () => void; milliseconds: number }>;
	notifications: Array<{ message: string; type?: string }>;
	setInterval: (callback: () => void, milliseconds: number) => number;
	clearTimer: (handle: unknown) => void;
	isIdle: () => boolean;
	ui: { notify: (message: string, type?: string) => void };
};
type TestToolExecute = (
	id: string,
	params: {
		op: "status";
		project?: string;
		agentId?: string;
		to?: string;
		text?: string;
	},
	signal: AbortSignal,
	onUpdate: (update: unknown) => void,
	context: TestTimerContext,
) => Promise<unknown>;


function extensionHarness() {
	let commandHandler: ((args: string, context: TestTimerContext) => Promise<void>) | undefined;
	let toolExecute: TestToolExecute | undefined;
	const sessionHandlers = new Map<string, (...args: unknown[]) => unknown>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const sentMessages: unknown[] = [];
	const zod = {
		string: schemaStub,
		boolean: schemaStub,
		array: schemaStub,
		enum: schemaStub,
		object: schemaStub,
	};
	a2aExtension({
		zod,
		setLabel() {},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			sessionHandlers.set(name, handler);
		},
		registerCommand(_name: string, command: { handler: typeof commandHandler }) {
			commandHandler = command.handler;
		},
		registerTool(tool: { execute: TestToolExecute }) {
			toolExecute = tool.execute;
		},
		sendMessage(message: unknown) {
			sentMessages.push(message);
		},
		logger: { warn() {} },
	} as never);
	if (!commandHandler) throw new Error("a2a command was not registered");
	if (!toolExecute) throw new Error("a2a tool was not registered");
	return { commandHandler, toolExecute, notifications, sentMessages, sessionHandlers };
}

function timerContext(cwd = root ?? process.cwd()): TestTimerContext {
	let nextTimer = 0;
	const timers = new Map<number, { callback: () => void; milliseconds: number }>();
	const notifications: Array<{ message: string; type?: string }> = [];
	return {
		cwd,
		sessionId: "session",
		timers,
		notifications,
		setInterval(callback: () => void, milliseconds: number) {
			const id = ++nextTimer;
			timers.set(id, { callback, milliseconds });
			return id;
		},
		clearTimer(handle: unknown) {
			timers.delete(handle as number);
		},
		isIdle() {
			return true;
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
	};
}

async function configureRepository(project: string) {
	if (!root || !hub) throw new Error("test Hub is not initialized");
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(
		join(root, ".omp", "a2a.json"),
		JSON.stringify({
			hubUrl: hub.listenUrl,
			project,
			agentId: "worker",
			autoJoin: false,
		}),
	);
}

test("the model-facing tool contract forbids polling for replies", () => {
	let description = "";
	const zod = {
		string: schemaStub,
		boolean: schemaStub,
		array: schemaStub,
		enum: schemaStub,
		object: schemaStub,
	};

	a2aExtension({
		zod,
		setLabel() {},
		on() {},
		registerCommand() {},
		registerTool(tool: { description: string }) {
			description = tool.description;
		},
	} as never);

	expect(description).toContain("Never wait, sleep, or poll inbox for a reply after send");
});

test("session lifecycle auto-joins and shuts down membership and timers", async () => {
	const testRoot = mkdtempSync(join(tmpdir(), "omp-a2a-extension-lifecycle-"));
	const testHub = await startHubServer({ port: 0, dataDir: join(testRoot, "hub-data") });
	try {
		const client = new HubClient(testHub.listenUrl);
		await client.createProject({ name: "auto-join" });
		mkdirSync(join(testRoot, ".omp"), { recursive: true });
		writeFileSync(
			join(testRoot, ".omp", "a2a.json"),
			JSON.stringify({
				hubUrl: testHub.listenUrl,
				project: "auto-join",
				agentId: "lifecycle-worker",
				autoJoin: true,
			}),
		);
		const { sessionHandlers } = extensionHarness();
		const context = timerContext(testRoot);
		const sessionStart = sessionHandlers.get("session_start");
		const sessionShutdown = sessionHandlers.get("session_shutdown");
		if (!sessionStart || !sessionShutdown) throw new Error("session lifecycle handlers were not registered");

		await sessionStart({}, context);

		expect((await client.listMembers("auto-join")).map(({ agentId }) => agentId)).toEqual(["lifecycle-worker"]);
		expect([...context.timers.values()].map(({ milliseconds }) => milliseconds).sort()).toEqual([1_000, 5_000]);

		await sessionShutdown();

		expect(context.timers.size).toBe(0);
		expect(await client.listMembers("auto-join")).toEqual([]);
		expect((await client.listMembers("auto-join", true)).map(({ agentId, status }) => ({ agentId, status }))).toEqual([
			{ agentId: "lifecycle-worker", status: "offline" },
		]);
	} finally {
		try {
			await testHub.stop();
		} finally {
			rmSync(testRoot, { recursive: true, force: true });
		}
	}
});

test("explicit join moves membership to a newly configured Hub without duplicating timers", async () => {
	const testRoot = mkdtempSync(join(tmpdir(), "omp-a2a-extension-hub-move-"));
	const hubA = await startHubServer({ port: 0, dataDir: join(testRoot, "hub-a-data") });
	let hubB: HubServerHandle | null = null;
	try {
		hubB = await startHubServer({ port: 0, dataDir: join(testRoot, "hub-b-data") });
		const clientA = new HubClient(hubA.listenUrl);
		const clientB = new HubClient(hubB.listenUrl);
		await clientA.createProject({ name: "project-a" });
		await clientB.createProject({ name: "project-b" });
		mkdirSync(join(testRoot, ".omp"), { recursive: true });
		writeFileSync(
			join(testRoot, ".omp", "a2a.json"),
			JSON.stringify({
				hubUrl: hubA.listenUrl,
				project: "project-a",
				agentId: "worker-a",
				autoJoin: false,
			}),
		);
		const { commandHandler } = extensionHarness();
		const context = timerContext(testRoot);

		await commandHandler("join project-a --as worker-a", context);
		expect((await clientA.listMembers("project-a")).map(({ agentId }) => agentId)).toEqual(["worker-a"]);

		writeFileSync(
			join(testRoot, ".omp", "a2a.json"),
			JSON.stringify({
				hubUrl: hubB.listenUrl,
				project: "project-b",
				agentId: "worker-b",
				autoJoin: false,
			}),
		);
		await commandHandler("join project-b --as worker-b", context);

		expect(await clientA.listMembers("project-a")).toEqual([]);
		expect((await clientB.listMembers("project-b")).map(({ agentId }) => agentId)).toEqual(["worker-b"]);
		expect([...context.timers.values()].map(({ milliseconds }) => milliseconds).sort()).toEqual([1_000, 5_000]);

		await commandHandler("leave", context);
	} finally {
		try {
			await hubB?.stop();
		} finally {
			try {
				await hubA.stop();
			} finally {
				rmSync(testRoot, { recursive: true, force: true });
			}
		}
	}
});

test("a failed join restores heartbeat and Inbox polling", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-extension-"));
	hub = await startHubServer({ port: 0, dataDir: join(root, "hub") });
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "stable" });
	await configureRepository("stable");
	const { commandHandler } = extensionHarness();
	const context = timerContext();

	await commandHandler("join stable --as worker", context);
	expect([...context.timers.values()].map((timer) => timer.milliseconds).sort()).toEqual([1_000, 5_000]);

	await commandHandler("join missing --as worker", context);

	expect(context.notifications.at(-1)).toMatchObject({ type: "error" });
	expect([...context.timers.values()].map((timer) => timer.milliseconds).sort()).toEqual([1_000, 5_000]);
	await commandHandler("leave", context);
});

test("leave aborts and waits for an active Inbox request", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-extension-"));
	hub = await startHubServer({ port: 0, dataDir: join(root, "hub") });
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "active" });
	await configureRepository("active");
	const { commandHandler } = extensionHarness();
	const context = timerContext();
	await commandHandler("join active --as worker", context);
	const inboxTimer = [...context.timers.values()].find((timer) => timer.milliseconds === 1_000);
	if (!inboxTimer) throw new Error("Inbox timer was not started");

	const originalFetch = globalThis.fetch;
	let readStartedResolve: (() => void) | undefined;
	const readStarted = new Promise<void>((resolve) => {
		readStartedResolve = resolve;
	});
	let readAborted = false;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).endsWith("/v1/inbox/read")) {
			readStartedResolve?.();
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						readAborted = true;
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			});
		}
		return originalFetch(input, init);
	}) as typeof fetch;

	try {
		inboxTimer.callback();
		await readStarted;
		await commandHandler("leave", context);
		expect(readAborted).toBe(true);
		expect(context.timers.size).toBe(0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("heartbeat ticks are single-flight and leave awaits heartbeat abortion before unregister", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-extension-"));
	hub = await startHubServer({ port: 0, dataDir: join(root, "hub") });
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "heartbeat" });
	await configureRepository("heartbeat");
	const { commandHandler } = extensionHarness();
	const context = timerContext();
	await commandHandler("join heartbeat --as worker", context);
	const heartbeatTimer = [...context.timers.values()].find((timer) => timer.milliseconds === 5_000);
	if (!heartbeatTimer) throw new Error("heartbeat timer was not started");

	const originalFetch = globalThis.fetch;
	let heartbeatRequests = 0;
	let unregisterStarted = false;
	let abortObservedResolve: (() => void) | undefined;
	const abortObserved = new Promise<void>((resolve) => {
		abortObservedResolve = resolve;
	});
	let rejectHeartbeat: ((reason?: unknown) => void) | undefined;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/v1/heartbeat")) {
			heartbeatRequests += 1;
			return new Promise<Response>((_resolve, reject) => {
				rejectHeartbeat = reject;
				init?.signal?.addEventListener(
					"abort",
					() => {
						abortObservedResolve?.();
					},
					{ once: true },
				);
			});
		}
		if (url.endsWith("/v1/unregister")) unregisterStarted = true;
		return originalFetch(input, init);
	}) as typeof fetch;

	try {
		heartbeatTimer.callback();
		heartbeatTimer.callback();
		expect(heartbeatRequests).toBe(1);

		const leaving = commandHandler("leave", context);
		await abortObserved;
		expect(unregisterStarted).toBe(false);
		rejectHeartbeat?.(new Error("heartbeat aborted"));
		await leaving;

		expect(unregisterStarted).toBe(true);
		expect(context.timers.size).toBe(0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("extension adapters report malformed local configuration without rejecting", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-extension-"));
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(join(root, ".omp", "a2a.json"), "{");
	const { commandHandler, toolExecute, sessionHandlers } = extensionHarness();
	const context = timerContext();
	const sessionStart = sessionHandlers.get("session_start");
	if (!sessionStart) throw new Error("session_start handler was not registered");

	await sessionStart({}, context);
	expect(context.notifications.at(-1)).toMatchObject({
		type: "error",
		message: expect.stringContaining("A2A config error"),
	});

	await commandHandler("status", context);
	expect(context.notifications.at(-1)).toMatchObject({
		type: "error",
		message: expect.stringContaining("a2a.json"),
	});

	const toolResult = await toolExecute(
		"id",
		{ op: "status" },
		new AbortController().signal,
		() => {},
		context,
	);
	expect(toolResult).toMatchObject({
		isError: true,
		details: { error: expect.stringContaining("a2a.json") },
	});
});

test("slash send preserves unknown flag-like text and supports an option delimiter", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-extension-"));
	hub = await startHubServer({ port: 0, dataDir: join(root, "hub") });
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "slash-send" });
	const receiver = await client.register({
		project: "slash-send",
		agentId: "receiver",
		cwd: "/receiver",
		pid: 1,
	});
	await configureRepository("slash-send");
	const { commandHandler } = extensionHarness();
	const context = timerContext();
	await commandHandler("join slash-send --as controller", context);
	await commandHandler("send receiver hello --message-id --reply-to parent", context);
	expect(context.notifications.at(-1)).toMatchObject({
		type: "error",
		message: "missing value for --message-id",
	});

	await commandHandler("send receiver run --dry-run now --message-id slash-flag", context);
	await commandHandler("send receiver -- --message-id literal", context);

	const messages = await client.inbox("slash-send", "receiver", 500, receiver.leaseId);
	expect(messages.map(({ msgId, text }) => ({ msgId, text }))).toEqual([
		{ msgId: "slash-flag", text: "run --dry-run now" },
		{ msgId: expect.not.stringMatching(/^literal$/), text: "--message-id literal" },
	]);
	await commandHandler("leave", context);
});
