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

function extensionHarness() {
	let commandHandler: ((args: string, context: TestTimerContext) => Promise<void>) | undefined;
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
		registerTool() {},
		sendMessage(message: unknown) {
			sentMessages.push(message);
		},
		logger: { warn() {} },
	} as never);
	if (!commandHandler) throw new Error("a2a command was not registered");
	return { commandHandler, notifications, sentMessages, sessionHandlers };
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
			hubUrl: hub.meta.baseUrl,
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

test("a failed join restores heartbeat and Inbox polling", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-extension-"));
	hub = await startHubServer({ port: 0, dataDir: join(root, "hub") });
	const client = new HubClient(hub.meta.baseUrl);
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
	const client = new HubClient(hub.meta.baseUrl);
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
