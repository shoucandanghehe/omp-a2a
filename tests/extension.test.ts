import { expect, test, vi } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalUrlToFile } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import WebSocket, { WebSocketServer } from "ws";
import a2aExtension from "../src/extension";
import { materializeLocalAttachments } from "../src/local-attachments";
import { HubClient } from "../src/hub/client";
import { A2aConnection } from "../src/hub/connection";
import { encodeBinaryPayload } from "../src/hub/payload";
import type { DeliveryEvent } from "../src/hub/realtime-types";
import { startHubServer } from "../src/hub/server";

interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

interface RegisteredTool {
	name: string;
	description: string;
	parameters?: unknown;
	execute(
		id: string,
		parameters: never,
		signal?: AbortSignal,
		onUpdate?: unknown,
		context?: unknown,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	}>;
}

test("human commands and model tools expose separate A2A surfaces", async () => {
	const tools: string[] = [];
	let commandHandler:
		| ((
				args: string,
				context: { cwd: string; ui: { notify(message: string): void } },
		  ) => Promise<void>)
		| undefined;
	let commandCompletions:
		| ((argumentPrefix: string) => CompletionItem[] | null)
		| undefined;
	let beforeAgentStart:
		| (() =>
				| { systemPrompt?: string[] }
				| undefined
				| Promise<{ systemPrompt?: string[] } | undefined>)
		| undefined;
	let help = "";

	a2aExtension({
		arktype(definition: unknown) {
			return definition;
		},
		setLabel() {},
		on(event: string, handler: unknown) {
			if (event === "before_agent_start")
				beforeAgentStart = handler as typeof beforeAgentStart;
		},
		logger: { warn() {} },
		sendMessage() {},
		registerCommand(
			_name: string,
			command: {
				handler: typeof commandHandler;
				getArgumentCompletions?: typeof commandCompletions;
			},
		) {
			commandHandler = command.handler;
			commandCompletions = command.getArgumentCompletions;
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
	} as never);

	expect(tools.sort()).toEqual(["a2a_history", "a2a_message", "a2a_peers"]);
	if (!beforeAgentStart)
		throw new Error("A2A identity system prompt was not registered");
	expect(await beforeAgentStart()).toBeUndefined();
	if (!commandHandler) throw new Error("a2a command was not registered");
	await commandHandler("help", {
		cwd: process.cwd(),
		ui: {
			notify(message) {
				help = message;
			},
		},
	});
	expect(help).toContain("/a2a connect <project> --as <name>");
	expect(help).toContain("/a2a project delete <name>");
	expect(help).not.toContain("/a2a send");
	expect(help).not.toContain("/a2a inbox");
	expect(help).not.toContain("/a2a join");
	if (!commandCompletions)
		throw new Error("a2a command completions were not registered");
	expect(commandCompletions("").map((item) => item.label)).toEqual([
		"hub",
		"project",
		"connect",
		"disconnect",
		"status",
		"peers",
		"history",
		"help",
	]);
	expect(commandCompletions("project d")).toEqual([
		{
			value: "project delete ",
			label: "delete",
			description: "Delete a Project and its history",
		},
	]);
	expect(commandCompletions("connect billing ")).toEqual([
		{
			value: "connect billing --as ",
			label: "--as",
			description: "Set this Presence name",
		},
	]);
	expect(
		commandCompletions("history --before billing:42 ").map(
			(item) => item.value,
		),
	).toEqual([
		"history --before billing:42 --limit ",
		"history --before billing:42 --from ",
	]);
	expect(commandCompletions("history --limit ")).toBeNull();
});

test("model tool contract makes replies push-driven instead of history-polled", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-extension-prompt-"));
	const project = "prompt-contract";
	const cwd = join(dataDir, "client");
	const hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const tools = new Map<string, RegisteredTool>();
	let commandHandler:
		| ((
				args: string,
				context: { cwd: string; ui: { notify(message: string): void } },
		  ) => Promise<void>)
		| undefined;
	let beforeAgentStart:
		| (() => { systemPrompt?: string[] } | undefined)
		| undefined;
	let worker: A2aConnection | null = null;
	const context = { cwd, ui: { notify() {} } };

	try {
		await client.createProject({ name: project });
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(
			join(cwd, ".omp", "a2a.yml"),
			`project: ${project}\nname: api\nhubUrl: ${hub.meta.baseUrl}\nautoConnect: false\n`,
		);
		worker = await A2aConnection.connect({
			baseUrl: hub.meta.baseUrl,
			project,
			name: "worker",
		});
		a2aExtension({
			arktype(definition: unknown) {
				return definition;
			},
			setLabel() {},
			on(event: string, handler: unknown) {
				if (event === "before_agent_start")
					beforeAgentStart = handler as typeof beforeAgentStart;
			},
			logger: { warn() {} },
			sendMessage() {},
			registerCommand(
				_name: string,
				command: { handler: typeof commandHandler },
			) {
				commandHandler = command.handler;
			},
			registerTool(tool: RegisteredTool) {
				tools.set(tool.name, tool);
			},
		} as never);

		if (!commandHandler) throw new Error("a2a command was not registered");
		await commandHandler(`connect ${project} --as api`, context);
		if (!beforeAgentStart)
			throw new Error("A2A identity system prompt was not registered");
		expect(beforeAgentStart()?.systemPrompt).toEqual([
			"Your A2A roster name is api. Address peers only by exact names returned by a2a_peers or by sender names in inbound A2A messages.",
		]);
		const peersTool = tools.get("a2a_peers");
		const messageTool = tools.get("a2a_message");
		const historyTool = tools.get("a2a_history");
		if (!peersTool || !messageTool || !historyTool)
			throw new Error("a2a model tools were not registered");

		expect(peersTool.description).toBe(
			"List the exact A2A roster names currently addressable in this Project. Use only a returned name for target.type=agent.",
		);

		expect(messageTool.description).toBe(
			"Send to one current peer or all current peers. Use target.type=agent with a name from a2a_peers, or target.type=project for all current peers. Set replyTo to reply to an earlier Project message. Attachments must be current-session local:// regular files. Replies arrive automatically. After sending, continue independent work; if blocked, end the current turn. Never wait, sleep, or poll a2a_history for a reply.",
		);
		expect(historyTool.description).toBe(
			"Review earlier Project messages using before, after, limit, or from. Returned attachment links are valid in the current session. Use only for past context; never wait or poll for new replies.",
		);

		const result = await messageTool.execute("send-1", {
			target: { type: "agent", name: "worker" },
			text: "reply with pong",
		} as never);
		expect(result.content[0]?.text).toContain("Replies arrive automatically.");
		expect(result.content[0]?.text).toContain(
			"Never wait, sleep, or poll a2a_history for a reply.",
		);
	} finally {
		if (commandHandler) await commandHandler("disconnect", context);
		await worker?.close();
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("a2a_message snapshots a sender local file into the receiver session and history", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-extension-attachment-"));
	const project = "attachment-contract";
	const senderCwd = join(dataDir, "sender");
	const receiverCwd = join(dataDir, "receiver");
	const senderArtifacts = join(dataDir, "sender-artifacts");
	const receiverArtifacts = join(dataDir, "receiver-artifacts");
	const hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const senderTools = new Map<string, RegisteredTool>();
	const receiverTools = new Map<string, RegisteredTool>();
	let senderCommand:
		| ((
				args: string,
				context: {
					cwd: string;
					ui: { notify(message: string): void };
				},
		  ) => Promise<void>)
		| undefined;
	let receiverCommand: typeof senderCommand;
	const inbound = Promise.withResolvers<{
		content: string;
		details: unknown;
	}>();
	let inboundDelivery:
		| { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean }
		| undefined;
	const senderContext = {
		cwd: senderCwd,
		ui: { notify() {} },
		isIdle: () => true,
		sessionManager: { getSessionId: () => "sender-session" },
		localProtocolOptions: {
			getArtifactsDir: () => senderArtifacts,
			getSessionId: () => "sender-session",
		},
	};
	const receiverContext = {
		cwd: receiverCwd,
		ui: { notify() {} },
		isIdle: () => true,
		sessionManager: { getSessionId: () => "receiver-session" },
		localProtocolOptions: {
			getArtifactsDir: () => receiverArtifacts,
			getSessionId: () => "receiver-session",
		},
	};

	try {
		await client.createProject({ name: project });
		for (const [cwd, name] of [
			[senderCwd, "sender"],
			[receiverCwd, "receiver"],
		] as const) {
			mkdirSync(join(cwd, ".omp"), { recursive: true });
			writeFileSync(
				join(cwd, ".omp", "a2a.yml"),
				`project: ${project}\nname: ${name}\nhubUrl: ${hub.meta.baseUrl}\nautoConnect: false\n`,
			);
		}
		mkdirSync(join(senderArtifacts, "local"), { recursive: true });
		writeFileSync(
			join(senderArtifacts, "local", "training-handoff.md"),
			"# Training handoff\nseed=20\n",
		);

		const installExtension = (
			tools: Map<string, RegisteredTool>,
			setCommand: (handler: NonNullable<typeof senderCommand>) => void,
			sendMessage: (
				message: { content: string; details: unknown },
				options?: {
					deliverAs?: "steer" | "followUp";
					triggerTurn?: boolean;
				},
			) => void,
		) => {
			a2aExtension({
				arktype(definition: unknown) {
					return definition;
				},
				setLabel() {},
				on() {},
				logger: { warn() {} },
				sendMessage,
				registerCommand(
					_name: string,
					command: { handler: NonNullable<typeof senderCommand> },
				) {
					setCommand(command.handler);
				},
				registerTool(tool: RegisteredTool) {
					tools.set(tool.name, tool);
				},
			} as never);
		};
		installExtension(
			senderTools,
			(handler) => {
				senderCommand = handler;
			},
			() => {},
		);
		installExtension(
			receiverTools,
			(handler) => {
				receiverCommand = handler;
			},
			(message, options) => {
				inboundDelivery = options;
				inbound.resolve(message);
			},
		);

		if (!senderCommand || !receiverCommand)
			throw new Error("a2a command was not registered");
		await receiverCommand(`connect ${project} --as receiver`, receiverContext);
		await senderCommand(`connect ${project} --as sender`, senderContext);
		const messageTool = senderTools.get("a2a_message");
		const historyTool = receiverTools.get("a2a_history");
		if (!messageTool || !historyTool)
			throw new Error("a2a tools were not registered");

		await expect(
			resolveLocalUrlToFile("local://training-handoff.md", {
				localProtocolOptions: receiverContext.localProtocolOptions,
			}),
		).rejects.toThrow("Local file not found");

		const sent = await messageTool.execute(
			"attachment-send",
			{
				target: { type: "agent", name: "receiver" },
				text: "Use the attached training contract.",
				attachments: ["local://training-handoff.md"],
				messageId: "attachment-send",
			} as never,
			undefined,
			undefined,
			senderContext,
		);
		expect(sent.content[0]?.text).toContain("attachments=1");
		const received = await inbound.promise;
		expect(inboundDelivery).toEqual({
			deliverAs: "steer",
			triggerTurn: true,
		});
		const receivedUrl = received.content.match(/local:\/\/\S+/)?.[0];
		if (!receivedUrl) throw new Error("inbound attachment URL missing");
		const receivedFile = await resolveLocalUrlToFile(receivedUrl, {
			localProtocolOptions: receiverContext.localProtocolOptions,
		});
		if (!receivedFile) throw new Error("inbound attachment did not resolve");
		expect(readFileSync(receivedFile.path, "utf8")).toBe(
			"# Training handoff\nseed=20\n",
		);

		const history = await historyTool.execute(
			"attachment-history",
			{} as never,
			undefined,
			undefined,
			receiverContext,
		);
		const historyUrl = history.content[0]?.text.match(/local:\/\/\S+/)?.[0];
		if (!historyUrl) throw new Error("history attachment URL missing");
		const historyFile = await resolveLocalUrlToFile(historyUrl, {
			localProtocolOptions: receiverContext.localProtocolOptions,
		});
		if (!historyFile) throw new Error("history attachment did not resolve");
		const localEntriesBeforeCancellation = readdirSync(
			join(receiverArtifacts, "local"),
		).length;
		const historyAbort = new AbortController();
		historyAbort.abort(new Error("history attachment request cancelled"));
		const cancelledHistory = await historyTool.execute(
			"cancelled-attachment-history",
			{} as never,
			historyAbort.signal,
			undefined,
			receiverContext,
		);
		const messageAbort = new AbortController();
		messageAbort.abort(new Error("message attachment request cancelled"));
		const cancelledMessage = await messageTool.execute(
			"cancelled-attachment-send",
			{
				target: { type: "agent", name: "receiver" },
				text: "This cancelled send must not enter history.",
				attachments: ["local://training-handoff.md"],
				messageId: "cancelled-attachment-send",
			} as never,
			messageAbort.signal,
			undefined,
			senderContext,
		);
		expect({
			historyCancelled: cancelledHistory.isError,
			messageCancelled: cancelledMessage.isError,
			materializedEntries: readdirSync(join(receiverArtifacts, "local")).length,
			messageIds: (await client.history({ project })).messages.map(
				(message) => message.messageId,
			),
		}).toEqual({
			historyCancelled: true,
			messageCancelled: true,
			materializedEntries: localEntriesBeforeCancellation,
			messageIds: ["attachment-send"],
		});
		const rejected = await messageTool.execute(
			"missing-attachment",
			{
				target: { type: "agent", name: "receiver" },
				text: "This must not enter history.",
				attachments: ["local://missing.md"],
				messageId: "missing-attachment",
			} as never,
			undefined,
			undefined,
			senderContext,
		);
		expect(rejected.isError).toBe(true);
		expect(rejected.content[0]?.text).toContain("Local file not found");
		expect(
			(await client.history({ project })).messages.map(
				(message) => message.messageId,
			),
		).toEqual(["attachment-send"]);
		expect(readFileSync(historyFile.path, "utf8")).toBe(
			"# Training handoff\nseed=20\n",
		);
	} finally {
		if (senderCommand) await senderCommand("disconnect", senderContext);
		if (receiverCommand) await receiverCommand("disconnect", receiverContext);
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("a2a_message cannot cross a Project switch after a slow snapshot", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-extension-send-fence-"));
	const cwd = join(dataDir, "client");
	const hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const snapshotStarted = Promise.withResolvers<void>();
	const releaseSnapshot = Promise.withResolvers<void>();
	const tools = new Map<string, RegisteredTool>();
	let commandHandler:
		| ((args: string, context: typeof context) => Promise<void>)
		| undefined;
	const context = {
		cwd,
		ui: { notify() {} },
		isIdle: () => true,
		sessionManager: { getSessionId: () => "send-fence-session" },
	};

	try {
		await client.createProject({ name: "send-fence-a" });
		await client.createProject({ name: "send-fence-b" });
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(
			join(cwd, ".omp", "a2a.yml"),
			`project: send-fence-a\nname: worker\nhubUrl: ${hub.meta.baseUrl}\nautoConnect: false\n`,
		);
		a2aExtension(
			{
				arktype(definition: unknown) {
					return definition;
				},
				setLabel() {},
				on() {},
				logger: { warn() {} },
				sendMessage() {},
				registerCommand(
					_name: string,
					command: { handler: typeof commandHandler },
				) {
					commandHandler = command.handler;
				},
				registerTool(tool: RegisteredTool) {
					tools.set(tool.name, tool);
				},
			} as never,
			{
				snapshotAttachments: async () => {
					snapshotStarted.resolve();
					await releaseSnapshot.promise;
					return [];
				},
			},
		);
		if (!commandHandler) throw new Error("a2a command was not registered");
		const messageTool = tools.get("a2a_message");
		if (!messageTool) throw new Error("a2a_message was not registered");
		await commandHandler("connect send-fence-a --as worker", context);

		const send = messageTool.execute(
			"slow-snapshot",
			{
				target: { type: "project" },
				text: "must not cross Projects",
				attachments: ["local://slow.txt"],
				messageId: "send-fence",
			} as never,
			undefined,
			undefined,
			context,
		);
		await snapshotStarted.promise;
		await commandHandler("connect send-fence-b --as worker", context);
		releaseSnapshot.resolve();

		expect((await send).isError).toBe(true);
		expect((await client.history({ project: "send-fence-a" })).messages).toEqual(
			[],
		);
		expect((await client.history({ project: "send-fence-b" })).messages).toEqual(
			[],
		);
	} finally {
		releaseSnapshot.resolve();
		if (commandHandler) await commandHandler("disconnect", context);
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("history materialization disposes successful siblings when one fails", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-history-batch-"));
	const cwd = join(dataDir, "client");
	const artifacts = join(dataDir, "artifacts");
	const hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const tools = new Map<string, RegisteredTool>();
	const firstMaterialized = Promise.withResolvers<void>();
	let sender: A2aConnection | undefined;
	let commandHandler:
		| ((args: string, context: typeof context) => Promise<void>)
		| undefined;
	const context = {
		cwd,
		ui: { notify() {} },
		isIdle: () => true,
		sessionManager: { getSessionId: () => "history-batch-session" },
		localProtocolOptions: {
			getArtifactsDir: () => artifacts,
			getSessionId: () => "history-batch-session",
		},
	};

	try {
		await client.createProject({ name: "history-batch" });
		sender = await A2aConnection.connect({
			baseUrl: hub.meta.baseUrl,
			project: "history-batch",
			name: "sender",
		});
		await sender.send({
			target: { type: "project" },
			text: "materializes first",
			attachments: [
				{
					name: "first.txt",
					payload: encodeBinaryPayload(Buffer.from("first", "utf8")),
				},
			],
			messageId: "history-batch-first",
		});
		await sender.send({
			target: { type: "project" },
			text: "fails second",
			attachments: [
				{
					name: "fail.txt",
					payload: encodeBinaryPayload(Buffer.from("fail", "utf8")),
				},
			],
			messageId: "history-batch-fail",
		});
		await sender.close();
		sender = undefined;

		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(
			join(cwd, ".omp", "a2a.yml"),
			`project: history-batch\nname: worker\nhubUrl: ${hub.meta.baseUrl}\nautoConnect: false\n`,
		);
		a2aExtension(
			{
				arktype(definition: unknown) {
					return definition;
				},
				setLabel() {},
				on() {},
				logger: { warn() {} },
				sendMessage() {},
				registerCommand(
					_name: string,
					command: { handler: typeof commandHandler },
				) {
					commandHandler = command.handler;
				},
				registerTool(tool: RegisteredTool) {
					tools.set(tool.name, tool);
				},
			} as never,
			{
				materializeAttachments: async (
					attachments,
					options,
					signal,
				) => {
					if (attachments[0]?.name === "fail.txt") {
						await firstMaterialized.promise;
						throw new Error("second history materialization failed");
					}
					const materialized = await materializeLocalAttachments(
						attachments,
						options,
						signal,
					);
					firstMaterialized.resolve();
					return materialized;
				},
			},
		);
		if (!commandHandler) throw new Error("a2a command was not registered");
		const historyTool = tools.get("a2a_history");
		if (!historyTool) throw new Error("a2a_history was not registered");
		await commandHandler("connect history-batch --as worker", context);

		const result = await historyTool.execute(
			"history-batch",
			{} as never,
			undefined,
			undefined,
			context,
		);
		expect(result).toMatchObject({
			isError: true,
			details: { error: "second history materialization failed" },
		});
		expect(
			existsSync(join(artifacts, "local"))
				? readdirSync(join(artifacts, "local"))
				: [],
		).toEqual([]);
	} finally {
		firstMaterialized.resolve();
		await sender?.close();
		if (commandHandler) await commandHandler("disconnect", context);
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("session shutdown aborts slash history and suppresses stale UI", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-history-shutdown-"));
	const cwd = join(dataDir, "client");
	const artifacts = join(dataDir, "artifacts");
	const hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const materialized = Promise.withResolvers<void>();
	const notifications: string[] = [];
	let sender: A2aConnection | undefined;
	let commandHandler:
		| ((args: string, context: typeof context) => Promise<void>)
		| undefined;
	let sessionShutdown: (() => Promise<void>) | undefined;
	const context = {
		cwd,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		isIdle: () => true,
		sessionManager: { getSessionId: () => "history-shutdown-session" },
		localProtocolOptions: {
			getArtifactsDir: () => artifacts,
			getSessionId: () => "history-shutdown-session",
		},
	};

	try {
		await client.createProject({ name: "history-shutdown" });
		sender = await A2aConnection.connect({
			baseUrl: hub.meta.baseUrl,
			project: "history-shutdown",
			name: "sender",
		});
		await sender.send({
			target: { type: "project" },
			text: "retired history",
			attachments: [
				{
					name: "retired.txt",
					payload: encodeBinaryPayload(Buffer.from("retired", "utf8")),
				},
			],
			messageId: "history-shutdown-message",
		});
		await sender.close();
		sender = undefined;

		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(
			join(cwd, ".omp", "a2a.yml"),
			`project: history-shutdown\nname: worker\nhubUrl: ${hub.meta.baseUrl}\nautoConnect: false\n`,
		);
		a2aExtension(
			{
				arktype(definition: unknown) {
					return definition;
				},
				setLabel() {},
				on(event: string, handler: unknown) {
					if (event === "session_shutdown")
						sessionShutdown = handler as typeof sessionShutdown;
				},
				logger: { warn() {} },
				sendMessage() {},
				registerCommand(
					_name: string,
					command: { handler: typeof commandHandler },
				) {
					commandHandler = command.handler;
				},
				registerTool() {},
			} as never,
			{
				materializeAttachments: async (
					attachments,
					options,
					signal,
				) => {
					const pending = await materializeLocalAttachments(
						attachments,
						options,
						signal,
					);
					materialized.resolve();
					if (!signal)
						throw new Error("history materialization requires cancellation");
					if (!signal.aborted)
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => resolve(), {
								once: true,
							}),
						);
					return pending;
				},
			},
		);
		if (!commandHandler || !sessionShutdown)
			throw new Error("a2a lifecycle handlers were not registered");
		await commandHandler("connect history-shutdown --as worker", context);
		const notificationsBeforeHistory = notifications.length;

		const history = commandHandler("history", context);
		await materialized.promise;
		await sessionShutdown();
		await history;

		expect(notifications).toHaveLength(notificationsBeforeHistory);
		expect(
			existsSync(join(artifacts, "local"))
				? readdirSync(join(artifacts, "local"))
				: [],
		).toEqual([]);
	} finally {
		await sender?.close();
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("session switch cancels an in-flight inbound injection", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-extension-switch-"));
	const receiverCwd = join(dataDir, "receiver");
	const switchedCwd = join(dataDir, "switched");
	const receiverArtifacts = join(dataDir, "receiver-artifacts");
	const switchedArtifacts = join(dataDir, "switched-artifacts");
	const hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const delivery = Promise.withResolvers<DeliveryEvent>();
	const injected: string[] = [];
	let sender: A2aConnection | undefined;
	let switchPromise: Promise<void> | undefined;
	let sessionSwitch:
		| ((event: unknown, context: typeof switchedContext) => Promise<void>)
		| undefined;
	let commandHandler:
		| ((args: string, context: typeof receiverContext) => Promise<void>)
		| undefined;
	const switchedContext = {
		cwd: switchedCwd,
		ui: { notify() {} },
		isIdle: () => true,
		sessionManager: { getSessionId: () => "switched-session" },
		localProtocolOptions: {
			getArtifactsDir: () => switchedArtifacts,
			getSessionId: () => "switched-session",
		},
	};
	const receiverContext = {
		cwd: receiverCwd,
		ui: { notify() {} },
		isIdle: () => true,
		sessionManager: { getSessionId: () => "receiver-session" },
		localProtocolOptions: {
			getArtifactsDir: () => {
				if (!switchPromise) {
					if (!sessionSwitch)
						throw new Error("session_switch handler was not registered");
					switchPromise = sessionSwitch({}, switchedContext);
				}
				return receiverArtifacts;
			},
			getSessionId: () => "receiver-session",
		},
	};

	try {
		await client.createProject({ name: "session-switch" });
		mkdirSync(join(receiverCwd, ".omp"), { recursive: true });
		writeFileSync(
			join(receiverCwd, ".omp", "a2a.yml"),
			`project: session-switch\nname: receiver\nhubUrl: ${hub.meta.baseUrl}\nautoConnect: false\n`,
		);
		a2aExtension({
			arktype(definition: unknown) {
				return definition;
			},
			setLabel() {},
			on(event: string, handler: unknown) {
				if (event === "session_switch")
					sessionSwitch = handler as typeof sessionSwitch;
			},
			logger: { warn() {} },
			sendMessage(message: { content: string }) {
				injected.push(message.content);
			},
			registerCommand(
				_name: string,
				command: { handler: typeof commandHandler },
			) {
				commandHandler = command.handler;
			},
			registerTool() {},
		} as never);
		if (!commandHandler) throw new Error("a2a command was not registered");
		await commandHandler(
			"connect session-switch --as receiver",
			receiverContext,
		);
		sender = await A2aConnection.connect({
			baseUrl: hub.meta.baseUrl,
			project: "session-switch",
			name: "sender",
			events: { onDelivery: delivery.resolve },
		});

		await sender.send({
			target: { type: "agent", name: "receiver" },
			text: "must stay in the old session",
			attachments: [
				{
					name: "handoff.txt",
					payload: encodeBinaryPayload(Buffer.from("old session", "utf8")),
				},
			],
			messageId: "switch-in-flight",
		});
		await delivery.promise;
		await switchPromise;

		expect(injected).toEqual([]);
		expect(
			existsSync(join(receiverArtifacts, "local"))
				? readdirSync(join(receiverArtifacts, "local"))
				: [],
		).toEqual([]);
	} finally {
		await sender?.close();
		if (commandHandler) await commandHandler("disconnect", switchedContext);
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("manual Project switch cancels old in-flight attachment injection", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-extension-project-switch-"));
	const receiverCwd = join(dataDir, "receiver");
	const receiverArtifacts = join(dataDir, "receiver-artifacts");
	const hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const delivery = Promise.withResolvers<DeliveryEvent>();
	const materializationStarted = Promise.withResolvers<void>();
	const releaseMaterialization = Promise.withResolvers<void>();
	const injected: string[] = [];
	const notifications: string[] = [];
	let sender: A2aConnection | undefined;
	let commandHandler:
		| ((args: string, context: typeof receiverContext) => Promise<void>)
		| undefined;
	const receiverContext = {
		cwd: receiverCwd,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		isIdle: () => true,
		sessionManager: { getSessionId: () => "receiver-session" },
		localProtocolOptions: {
			getArtifactsDir: () => receiverArtifacts,
			getSessionId: () => "receiver-session",
		},
	};

	try {
		await client.createProject({ name: "project-a" });
		await client.createProject({ name: "project-b" });
		mkdirSync(join(receiverCwd, ".omp"), { recursive: true });
		writeFileSync(
			join(receiverCwd, ".omp", "a2a.yml"),
			`project: project-a\nname: receiver\nhubUrl: ${hub.meta.baseUrl}\nautoConnect: false\n`,
		);
		a2aExtension(
			{
				arktype(definition: unknown) {
					return definition;
				},
				setLabel() {},
				on() {},
				logger: { warn() {} },
				sendMessage(message: { content: string }) {
					injected.push(message.content);
				},
				registerCommand(
					_name: string,
					command: { handler: typeof commandHandler },
				) {
					commandHandler = command.handler;
				},
				registerTool() {},
			} as never,
			{
				materializeAttachments: async (
					attachments,
					options,
					signal?: AbortSignal,
				) => {
					const materialized = await materializeLocalAttachments(
						attachments,
						options,
						signal,
					);
					materializationStarted.resolve();
					await releaseMaterialization.promise;
					return materialized;
				},
			},
		);
		if (!commandHandler) throw new Error("a2a command was not registered");
		await commandHandler("connect project-a --as receiver", receiverContext);
		sender = await A2aConnection.connect({
			baseUrl: hub.meta.baseUrl,
			project: "project-a",
			name: "sender",
			events: { onDelivery: delivery.resolve },
		});

		await sender.send({
			target: { type: "agent", name: "receiver" },
			text: "must not cross Projects",
			attachments: [
				{
					name: "project-a.txt",
					payload: encodeBinaryPayload(Buffer.from("project A", "utf8")),
				},
			],
			messageId: "project-switch-in-flight",
		});
		await materializationStarted.promise;
		await commandHandler("connect project-b --as receiver", receiverContext);
		releaseMaterialization.resolve();
		await delivery.promise;
		await commandHandler("status", receiverContext);

		expect(injected).toEqual([]);
		expect(notifications.at(-1)).toContain("Project: project-b");
		expect(
			existsSync(join(receiverArtifacts, "local"))
				? readdirSync(join(receiverArtifacts, "local"))
				: [],
		).toEqual([]);
	} finally {
		releaseMaterialization.resolve();
		await sender?.close();
		if (commandHandler) await commandHandler("disconnect", receiverContext);
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("ordinary command contexts do not cancel same-session inbound injection", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-extension-generation-"));
	const receiverCwd = join(dataDir, "receiver");
	const hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const materializationStarted = Promise.withResolvers<void>();
	const releaseMaterialization = Promise.withResolvers<void>();
	const delivery = Promise.withResolvers<DeliveryEvent>();
	const injected: string[] = [];
	let sender: A2aConnection | undefined;
	let commandHandler:
		| ((args: string, context: typeof receiverContext) => Promise<void>)
		| undefined;
	const receiverContext = {
		cwd: receiverCwd,
		ui: { notify() {} },
		isIdle: () => true,
		sessionManager: { getSessionId: () => "generation-session" },
	};

	try {
		await client.createProject({ name: "generation" });
		mkdirSync(join(receiverCwd, ".omp"), { recursive: true });
		writeFileSync(
			join(receiverCwd, ".omp", "a2a.yml"),
			`project: generation\nname: receiver\nhubUrl: ${hub.meta.baseUrl}\nautoConnect: false\n`,
		);
		a2aExtension(
			{
				arktype(definition: unknown) {
					return definition;
				},
				setLabel() {},
				on() {},
				logger: { warn() {} },
				sendMessage(message: { content: string }) {
					injected.push(message.content);
				},
				registerCommand(
					_name: string,
					command: { handler: typeof commandHandler },
				) {
					commandHandler = command.handler;
				},
				registerTool() {},
			} as never,
			{
				materializeAttachments: async () => {
					materializationStarted.resolve();
					await releaseMaterialization.promise;
					return {
						attachments: [],
						commit() {},
						async dispose() {},
					};
				},
			},
		);
		if (!commandHandler) throw new Error("a2a command was not registered");
		await commandHandler("connect generation --as receiver", receiverContext);
		sender = await A2aConnection.connect({
			baseUrl: hub.meta.baseUrl,
			project: "generation",
			name: "sender",
			events: { onDelivery: delivery.resolve },
		});
		await sender.send({
			target: { type: "agent", name: "receiver" },
			text: "same session",
			messageId: "same-session-context",
		});
		await materializationStarted.promise;

		await commandHandler("status", {
			...receiverContext,
			ui: { notify() {} },
		});
		releaseMaterialization.resolve();

		expect(await delivery.promise).toMatchObject({
			messageId: "same-session-context",
			status: "delivered",
		});
		expect(injected).toHaveLength(1);
	} finally {
		releaseMaterialization.resolve();
		await sender?.close();
		if (commandHandler) await commandHandler("disconnect", receiverContext);
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("session switch invalidates obsolete reconnect work before awaiting teardown", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-extension-session-fence-"));
	const firstCwd = join(dataDir, "first");
	const nextCwd = join(dataDir, "next");
	const server = createServer((request, response) => {
		if (request.url !== "/v1/meta") {
			response.writeHead(404).end();
			return;
		}
		const port = (server.address() as AddressInfo).port;
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				pid: process.pid,
				port,
				baseUrl: `http://127.0.0.1:${port}`,
				dataDir,
				startedAt: Date.now(),
				protocolVersion: 3,
			}),
		);
	});
	const webSockets = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		webSockets.handleUpgrade(request, socket, head, (webSocket) => {
			webSockets.emit("connection", webSocket, request);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const stableConnected = Promise.withResolvers<WebSocket>();
	const stalledHello = Promise.withResolvers<void>();
	let stalledHellos = 0;
	webSockets.on("connection", (socket) => {
		socket.on("message", (data) => {
			const hello = JSON.parse(data.toString()) as {
				type: string;
				project?: string;
				name?: string;
			};
			if (hello.type !== "hello" || !hello.project || !hello.name) return;
			if (hello.project === "stalled") {
				stalledHellos += 1;
				stalledHello.resolve();
				return;
			}
			socket.send(
				JSON.stringify({
					type: "claimed",
					protocolVersion: 3,
					project: hello.project,
					self: { name: hello.name, presenceId: "stable-presence" },
					peers: [],
				}),
			);
			stableConnected.resolve(socket);
		});
	});
	let commandHandler:
		| ((args: string, context: typeof firstContext) => Promise<void>)
		| undefined;
	let sessionSwitch:
		| ((event: unknown, context: typeof firstContext) => Promise<void>)
		| undefined;
	const firstContext = {
		cwd: firstCwd,
		ui: { notify() {} },
		isIdle: () => true,
		sessionManager: { getSessionId: () => "first-session" },
	};
	const nextContext = {
		...firstContext,
		cwd: nextCwd,
		sessionManager: { getSessionId: () => "next-session" },
	};
	let obsoleteConnect: Promise<void> | undefined;
	let switchPromise: Promise<void> | undefined;
	let fakeTimers = false;
	const closeStarted = Promise.withResolvers<void>();
	const releaseClose = Promise.withResolvers<void>();
	const originalClose = A2aConnection.prototype.close;
	let closeSpy: { mockRestore(): void } | undefined;

	try {
		for (const cwd of [firstCwd, nextCwd]) {
			mkdirSync(join(cwd, ".omp"), { recursive: true });
			writeFileSync(
				join(cwd, ".omp", "a2a.yml"),
				`project: stable\nname: worker\nhubUrl: ${baseUrl}\nautoConnect: false\n`,
			);
		}
		a2aExtension({
			arktype(definition: unknown) {
				return definition;
			},
			setLabel() {},
			on(event: string, handler: unknown) {
				if (event === "session_switch")
					sessionSwitch = handler as typeof sessionSwitch;
			},
			logger: { warn() {} },
			sendMessage() {},
			registerCommand(
				_name: string,
				command: { handler: typeof commandHandler },
			) {
				commandHandler = command.handler;
			},
			registerTool() {},
		} as never);
		if (!commandHandler || !sessionSwitch)
			throw new Error("a2a lifecycle handlers were not registered");
		await commandHandler("connect stable --as worker", firstContext);
		await stableConnected.promise;
		obsoleteConnect = commandHandler("connect stalled --as worker", firstContext);
		await stalledHello.promise;

		closeSpy = vi
			.spyOn(A2aConnection.prototype, "close")
			.mockImplementation(async function (this: A2aConnection) {
				if (this.project === "stable") {
					closeStarted.resolve();
					await releaseClose.promise;
				}
				return await originalClose.call(this);
			});
		vi.useFakeTimers();
		fakeTimers = true;
		switchPromise = sessionSwitch({}, nextContext);
		await closeStarted.promise;
		await obsoleteConnect;
		vi.advanceTimersByTime(500);
		vi.useRealTimers();
		fakeTimers = false;
		for (let turn = 0; turn < 3; turn += 1) {
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;
		}

		expect(stalledHellos).toBe(1);
	} finally {
		if (fakeTimers) vi.useRealTimers();
		releaseClose.resolve();
		closeSpy?.mockRestore();
		for (const socket of webSockets.clients) socket.terminate();
		await switchPromise;
		await obsoleteConnect;
		if (commandHandler) await commandHandler("disconnect", nextContext);
		webSockets.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("name conflict restores the accepting Hub as reconnect intent", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-extension-name-conflict-"));
	const cwd = join(dataDir, "client");
	const server = createServer((request, response) => {
		if (!request.url?.endsWith("/v1/meta")) {
			response.writeHead(404).end();
			return;
		}
		const port = (server.address() as AddressInfo).port;
		const hubPath = request.url.startsWith("/hub-a/") ? "/hub-a" : "/hub-b";
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				pid: process.pid,
				port,
				baseUrl: `http://127.0.0.1:${port}${hubPath}`,
				dataDir,
				startedAt: Date.now(),
				protocolVersion: 3,
			}),
		);
	});
	const webSockets = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		webSockets.handleUpgrade(request, socket, head, (webSocket) => {
			webSockets.emit("connection", webSocket, request);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const initialSocket = Promise.withResolvers<WebSocket>();
	const connectionLost = Promise.withResolvers<void>();
	const reconnectAttempt = Promise.withResolvers<"hub-a" | "hub-b">();
	let watchReconnect = false;
	let hubAClaims = 0;
	let fakeTimers = false;
	webSockets.on("connection", (socket, request) => {
		const hub = request.url?.startsWith("/hub-a/")
			? ("hub-a" as const)
			: ("hub-b" as const);
		socket.on("message", (data) => {
			const hello = JSON.parse(data.toString()) as {
				type: string;
				project?: string;
				name?: string;
			};
			if (hello.type !== "hello" || !hello.project || !hello.name) return;
			if (watchReconnect) {
				watchReconnect = false;
				reconnectAttempt.resolve(hub);
			}
			if (hub === "hub-b") {
				socket.send(
					JSON.stringify({
						type: "error",
						code: "name_in_use",
						message: "that name is already present on Hub B",
					}),
				);
				return;
			}
			hubAClaims += 1;
			socket.send(
				JSON.stringify({
					type: "claimed",
					protocolVersion: 3,
					project: hello.project,
					self: {
						name: hello.name,
						presenceId: `hub-a-presence-${hubAClaims}`,
					},
					peers: [],
				}),
			);
			if (hubAClaims === 1) initialSocket.resolve(socket);
		});
	});
	const notifications: string[] = [];
	let commandHandler:
		| ((args: string, context: typeof context) => Promise<void>)
		| undefined;
	const context = {
		cwd,
		ui: {
			notify(message: string) {
				notifications.push(message);
				if (message.includes("connection lost")) connectionLost.resolve();
			},
		},
		isIdle: () => true,
		sessionManager: { getSessionId: () => "name-conflict-session" },
	};

	try {
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(
			join(cwd, ".omp", "a2a.yml"),
			`project: stable\nname: worker\nhubUrl: ${baseUrl}/hub-a\nautoConnect: false\n`,
		);
		a2aExtension({
			arktype(definition: unknown) {
				return definition;
			},
			setLabel() {},
			on() {},
			logger: { warn() {} },
			sendMessage() {},
			registerCommand(
				_name: string,
				command: { handler: typeof commandHandler },
			) {
				commandHandler = command.handler;
			},
			registerTool() {},
		} as never);
		if (!commandHandler) throw new Error("a2a command was not registered");
		await commandHandler("connect stable --as worker", context);
		const oldSocket = await initialSocket.promise;

		writeFileSync(
			join(cwd, ".omp", "a2a.yml"),
			`project: stable\nname: worker\nhubUrl: ${baseUrl}/hub-b\nautoConnect: false\n`,
		);
		await commandHandler("connect stable --as worker", context);
		expect(notifications.at(-1)).toContain("name_in_use");
		await commandHandler("status", context);
		expect(notifications.at(-1)).toContain(`${baseUrl}/hub-a`);

		watchReconnect = true;
		vi.useFakeTimers();
		fakeTimers = true;
		oldSocket.close(1012, "unexpected close");
		await connectionLost.promise;
		vi.advanceTimersByTime(500);
		vi.useRealTimers();
		fakeTimers = false;
		expect(await reconnectAttempt.promise).toBe("hub-a");
	} finally {
		if (fakeTimers) vi.useRealTimers();
		if (commandHandler) await commandHandler("disconnect", context);
		for (const socket of webSockets.clients) socket.terminate();
		webSockets.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dataDir, { recursive: true, force: true });
	}
});
