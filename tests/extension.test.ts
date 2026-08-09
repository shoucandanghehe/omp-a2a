import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalUrlToFile } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import a2aExtension from "../src/extension";
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

type SessionHandler = (event: unknown, context: unknown) => Promise<void>;

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
	const rootCompletions = commandCompletions("");
	if (!rootCompletions) throw new Error("root completions were not returned");
	expect(rootCompletions.map((item) => item.label)).toEqual([
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
	const historyCompletions = commandCompletions(
		"history --before billing:42 ",
	);
	if (!historyCompletions)
		throw new Error("history completions were not returned");
	expect(
		historyCompletions.map(
			(item) => item.value,
		),
	).toEqual([
		"history --before billing:42 --limit ",
		"history --before billing:42 --from ",
	]);
	expect(commandCompletions("history --limit ")).toBeNull();
	const invalidHistory = [
		"history --unknown value",
		"history --before",
		"history --before project:1 --after project:2",
		"history --before invalid",
		"history --limit 0",
		"history --limit 1.5",
		"history --from invalid/name",
		"history stray",
	];
	for (const args of invalidHistory) {
		await commandHandler(args, {
			cwd: process.cwd(),
			ui: {
				notify(message) {
					help = message;
				},
			},
		});
		expect(help).toMatch(/history|invalid|unknown/);
	}
});

test("latest session activation contains malformed local config", async () => {
	const first = mkdtempSync(join(tmpdir(), "omp-a2a-extension-first-"));
	const second = mkdtempSync(join(tmpdir(), "omp-a2a-extension-second-"));
	mkdirSync(join(first, ".omp"));
	mkdirSync(join(second, ".omp"));
	writeFileSync(join(first, ".omp", "a2a.yml"), "project: [broken\n");
	writeFileSync(join(second, ".omp", "a2a.yml"), "unknown: value\n");
	const sessionHandlers: Array<
		(event: unknown, context: unknown) => Promise<void>
	> = [];
	const notifications: string[] = [];
	try {
		a2aExtension({
			arktype(definition: unknown) {
				return definition;
			},
			setLabel() {},
			on(event: string, handler: (event: unknown, context: unknown) => Promise<void>) {
				if (event === "session_start" || event === "session_switch")
					sessionHandlers.push(handler);
			},
			logger: { warn() {} },
			sendMessage() {},
			registerCommand() {},
			registerTool() {},
		} as never);
		const context = (cwd: string) => ({
			cwd,
			ui: {
				notify(message: string) {
					notifications.push(`${cwd}:${message}`);
				},
			},
		});
		const firstActivation = sessionHandlers[0]?.({}, context(first));
		const secondActivation = sessionHandlers[1]?.({}, context(second));
		await Promise.all([firstActivation, secondActivation]);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain(second);
		expect(notifications[0]).toContain("A2A config error:");
	} finally {
		rmSync(first, { recursive: true, force: true });
		rmSync(second, { recursive: true, force: true });
	}
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
	let sessionStartHandler: SessionHandler | undefined;

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
				if (event === "session_start")
					sessionStartHandler = handler as SessionHandler;
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
		if (!sessionStartHandler)
			throw new Error("session_start handler was not registered");
		await sessionStartHandler({}, context);

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
	let senderSessionStart: SessionHandler | undefined;
	let receiverSessionStart: SessionHandler | undefined;
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
			setSessionStart: (handler: SessionHandler) => void,
		) => {
			a2aExtension({
				arktype(definition: unknown) {
					return definition;
				},
				setLabel() {},
				on(event: string, handler: SessionHandler) {
					if (event === "session_start") setSessionStart(handler);
				},
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
			(handler) => {
				senderSessionStart = handler;
			},
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
			(handler) => {
				receiverSessionStart = handler;
			},
		);

		if (
			!senderCommand ||
			!receiverCommand ||
			!senderSessionStart ||
			!receiverSessionStart
		)
			throw new Error("A2A extension handlers were not registered");
		await receiverSessionStart({}, receiverContext);
		await senderSessionStart({}, senderContext);
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

test("session switch cancels an in-flight inbound injection", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-extension-switch-"));
	const receiverCwd = join(dataDir, "receiver");
	const switchedCwd = join(dataDir, "switched");
	const receiverArtifacts = join(dataDir, "receiver-artifacts");
	const switchedArtifacts = join(dataDir, "switched-artifacts");
	const hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const delivery = Promise.withResolvers<DeliveryEvent>();
	const waitForCompletedMaterialization = async (): Promise<void> => {
		const localRoot = join(receiverArtifacts, "local");
		for (let attempt = 0; attempt < 100; attempt++) {
			if (existsSync(localRoot)) {
				for (const directory of readdirSync(localRoot)) {
					const file = join(localRoot, directory, "handoff.txt");
					if (existsSync(file) && readFileSync(file, "utf8") === "old session") {
						await Bun.sleep(0);
						return;
					}
				}
			}
			await Bun.sleep(10);
		}
		throw new Error("in-flight attachment materialization did not complete");
	};
	const injected: string[] = [];
	let sender: A2aConnection | undefined;
	let switchPromise: Promise<void> | undefined;
	let sessionSwitch:
		| ((event: unknown, context: typeof switchedContext) => Promise<void>)
		| undefined;
	let sessionStart: typeof sessionSwitch;
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
				if (event === "session_start")
					sessionStart = handler as typeof sessionStart;
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
		if (!commandHandler || !sessionStart)
			throw new Error("A2A extension handlers were not registered");
		await sessionStart({}, receiverContext);
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
		await waitForCompletedMaterialization();

		expect(injected).toEqual([]);
	} finally {
		await sender?.close();
		if (commandHandler) await commandHandler("disconnect", switchedContext);
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
