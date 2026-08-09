import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import a2aExtension from "../src/extension";
import { HubClient } from "../src/hub/client";
import { A2aConnection } from "../src/hub/connection";
import { startHubServer } from "../src/hub/server";

interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

interface RegisteredTool {
	name: string;
	description: string;
	execute(
		id: string,
		parameters: never,
	): Promise<{ content: Array<{ type: string; text: string }> }>;
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
