import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { AcpBridge } from "./bridge";
import { AcpClient } from "./client";

const usage =
	"Usage: bun run acp --hub-url URL --room ROOM --name NAME --cwd DIR -- COMMAND [ARGS...]";

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		options: {
			"hub-url": { type: "string" },
			room: { type: "string" },
			name: { type: "string" },
			cwd: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
	});
	if (values.help) {
		console.log(usage);
		return;
	}
	const [command, ...args] = positionals;
	const hubUrl = values["hub-url"];
	const { room, name, cwd } = values;
	if (!hubUrl || !room || !name || !cwd || !command) throw new Error(usage);
	if (!process.stdin.isTTY || !process.stderr.isTTY)
		throw new Error(
			"ACP bridge requires a local terminal for message and permission approval",
		);

	const ui = createInterface({
		input: process.stdin,
		output: process.stderr,
		terminal: true,
	});
	const closed = new AbortController();
	let bridge: AcpBridge | undefined;
	let client: AcpClient | undefined;
	const stop = () => closed.abort();
	ui.on("close", stop);
	ui.on("SIGINT", () => {
		if (bridge?.cancel())
			console.error("Cancelled the pending ACP operation. Ctrl+D exits.");
		else ui.close();
	});
	process.once("SIGTERM", stop);
	const ended = new Promise<void>((resolve) =>
		closed.signal.addEventListener("abort", () => resolve(), { once: true }),
	);
	let asking = false;
	const approve = async (
		label: string,
		detail: string,
		signal: AbortSignal,
	) => {
		const ownerSignal = AbortSignal.any([closed.signal, signal]);
		if (ownerSignal.aborted || asking) return false;
		asking = true;
		try {
			const answer = await ui.question(
				`${label}\n${JSON.stringify(detail).replace(/[\u202a-\u202e\u2066-\u2069]/gu, (mark) => `\\u${mark.charCodeAt(0).toString(16)}`)}\nType yes to approve: `,
				{ signal: ownerSignal },
			);
			return !ownerSignal.aborted && answer.trim() === "yes";
		} catch {
			return false;
		} finally {
			asking = false;
		}
	};

	try {
		client = await AcpClient.start({
			command,
			args,
			cwd,
			requestPermission: async (permission, signal) => {
				const once = permission.options.find(
					(option) => option.kind === "allow_once",
				);
				if (!once) return undefined;
				const detail = [permission.title, once.name, permission.detail]
					.filter(Boolean)
					.join("\n");
				return (await approve(
					"Allow this ACP tool action once?",
					detail,
					signal,
				))
					? once.id
					: undefined;
			},
		});
		void client.terminated.then((error) => {
			if (error.kind === "closed" || closed.signal.aborted) return;
			console.error("ACP executable exited:", error.message);
			process.exitCode = 1;
			stop();
		});
		if (closed.signal.aborted) return;
		const acp = client;
		bridge = new AcpBridge({
			hubUrl,
			room,
			name,
			prompt: (text, signal) => acp.prompt(text, signal),
			accept: (message, signal) =>
				approve(
					`Send ${message.messageRef} from ${message.from.name} to this ACP session?`,
					message.text,
					signal,
				),
			approveReply: (message, text, signal) =>
				approve(
					`Send this reply to ${message.from.name} in ${message.room}?`,
					text,
					signal,
				),
			onError: (error) =>
				console.error(
					"ACP bridge:",
					error instanceof Error ? error.message : "Operation failed",
				),
			onClose: stop,
		});
		await bridge.connect();
		console.error(
			`ACP bridge joined ${room} as ${name}. Ctrl+C cancels the active operation; Ctrl+D exits.`,
		);
		await ended;
	} finally {
		ui.close();
		process.removeListener("SIGTERM", stop);
		await Promise.all([bridge?.close(), client?.close()]);
	}
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "ACP bridge failed");
	process.exitCode = 1;
});
