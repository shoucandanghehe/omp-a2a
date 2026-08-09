import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
	let help = "";

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
		} as never);

		if (!commandHandler) throw new Error("a2a command was not registered");
		await commandHandler(`connect ${project} --as api`, context);
		const messageTool = tools.get("a2a_message");
		const historyTool = tools.get("a2a_history");
		if (!messageTool || !historyTool)
			throw new Error("a2a model tools were not registered");

		expect(messageTool.description).toContain(
			"Replies arrive automatically as inbound A2A messages",
		);
		expect(messageTool.description).toContain(
			"never wait, sleep, or call a2a_history",
		);
		expect(historyTool.description).toContain(
			"Use only when past context is needed",
		);
		expect(historyTool.description).toContain(
			"never call this tool to wait for or poll a new reply",
		);

		const result = await messageTool.execute("send-1", {
			target: { type: "agent", name: "worker" },
			text: "reply with pong",
		} as never);
		expect(result.content[0]?.text).toContain(
			"Replies arrive automatically as inbound A2A messages",
		);
		expect(result.content[0]?.text).toContain(
			"never wait, sleep, or call a2a_history",
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
	const receiverError = Promise.withResolvers<void>();
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
			logger: { warn: () => receiverError.resolve() },
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
		const outcome = await delivery.promise;
		if (outcome.status === "disconnected") await receiverError.promise;
		await switchPromise;

		expect(injected).toEqual([]);
	} finally {
		await sender?.close();
		if (commandHandler) await commandHandler("disconnect", switchedContext);
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
