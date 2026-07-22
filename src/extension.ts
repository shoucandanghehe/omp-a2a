import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadLocalConfig } from "./config";
import { HubClient, resolveHubUrl } from "./hub/client";
import type { HubEnvelope, HubMessageEnvelope } from "./hub/types";
import { A2aOperations, ASYNC_REPLY_GUIDANCE, type A2aOperationRequest } from "./operations";
import { AGENT_ID_RE, HEARTBEAT_MS, PROJECT_NAME_RE } from "./types";

type TimerContext = Pick<ExtensionContext, "setInterval" | "clearTimer" | "isIdle" | "ui">;

function parseArgs(raw: string): { positional: string[]; flags: Record<string, string | boolean> } {
	const tokens = raw.trim().length === 0 ? [] : raw.trim().split(/\s+/);
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const equals = token.indexOf("=");
		if (equals > 2) {
			flags[token.slice(2, equals)] = token.slice(equals + 1);
			continue;
		}
		const key = token.slice(2);
		const next = tokens[index + 1];
		if (next && !next.startsWith("--")) {
			flags[key] = next;
			index++;
		} else {
			flags[key] = true;
		}
	}
	return { positional, flags };
}

const SEND_OPTION_NAMES = ["message-id", "reply-to", "reply-to-ref"] as const;

function parseSendRequest(raw: string): A2aOperationRequest {
	const tokens = raw.trim().split(/\s+/);
	const to = tokens[1];
	const message: string[] = [];
	const options: Partial<Record<(typeof SEND_OPTION_NAMES)[number], string>> = {};
	let optionsEnded = false;

	for (let index = 2; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		let matched = false;
		if (!optionsEnded) {
			for (const name of SEND_OPTION_NAMES) {
				const prefix = `--${name}`;
				if (token !== prefix && !token.startsWith(`${prefix}=`)) continue;
				let value: string;
				if (token === prefix) {
					const next = tokens[index + 1];
					if (!next || next.startsWith("--")) throw new Error(`missing value for ${prefix}`);
					value = next;
					index += 1;
				} else {
					value = token.slice(prefix.length + 1);
					if (!value) throw new Error(`missing value for ${prefix}`);
				}
				options[name] = value;
				matched = true;
				break;
			}
		}
		if (!matched) message.push(token);
	}

	const text = message.join(" ").trim();
	if (!to || !text) throw new Error("usage: /a2a send <agentId> <message...>");
	return {
		action: "send",
		to,
		text,
		messageId: options["message-id"],
		replyTo: options["reply-to"],
		replyToRef: options["reply-to-ref"],
	};
}

function usage(): string {
	return [
		"A2A multi-project custom mesh (standalone Hub + omp client)",
		"",
		"/a2a project create <name> [--display <text>] [--desc <text>]",
		"/a2a project delete <name>",
		"/a2a project list",
		"/a2a join <project> --as <agentId> [--caps a,b]",
		"/a2a leave",
		"/a2a list [--project <name>] [--all]",
		"/a2a send <agentId> <message...> [--message-id <id>] [--reply-to-ref <agentId:sequence>] [--reply-to <msgId>] [-- <literal option-like text>]",
		"/a2a inbox",
		"/a2a status",
		"/a2a hub",
		"/a2a help",
	].join("\n");
}

function commandRequest(raw: string): A2aOperationRequest | null {
	if (raw.trim().split(/\s+/, 1)[0] === "send") return parseSendRequest(raw);
	const { positional, flags } = parseArgs(raw);
	const command = positional[0] ?? "";
	if (command === "hub" || command === "status" || command === "leave" || command === "inbox") {
		return { action: command };
	}
	if (command === "project" && positional[1] === "create") {
		const project = positional[2];
		if (!project) throw new Error("usage: /a2a project create <name>");
		if (!PROJECT_NAME_RE.test(project)) throw new Error(`invalid project name: ${project}`);
		return {
			action: "project_create",
			project,
			displayName: typeof flags.display === "string" ? flags.display : undefined,
			description:
				typeof flags.desc === "string"
					? flags.desc
					: typeof flags.description === "string"
						? flags.description
						: undefined,
		};
	}
	if (command === "project" && positional[1] === "delete") {
		const project = positional[2];
		if (!project) throw new Error("usage: /a2a project delete <name>");
		if (!PROJECT_NAME_RE.test(project)) throw new Error(`invalid project name: ${project}`);
		return { action: "project_delete", project };
	}
	if (command === "project" && (positional[1] === "list" || positional[1] === undefined)) {
		return { action: "project_list" };
	}
	if (command === "join") {
		const project = positional[1];
		const agentId =
			typeof flags.as === "string" ? flags.as : typeof flags.agent === "string" ? flags.agent : undefined;
		if (!project || !agentId) throw new Error("usage: /a2a join <project> --as <agentId> [--caps a,b]");
		if (!AGENT_ID_RE.test(agentId)) throw new Error(`invalid agentId: ${agentId}`);
		return {
			action: "join",
			project,
			agentId,
			caps:
				typeof flags.caps === "string"
					? flags.caps
						.split(",")
						.map((capability) => capability.trim())
						.filter(Boolean)
					: undefined,
		};
	}
	if (command === "list") {
		return {
			action: "list",
			project: typeof flags.project === "string" ? flags.project : undefined,
			all: flags.all === true || flags.all === "true",
		};
	}
	return null;
}

export default function a2aExtension(pi: ExtensionAPI) {
	const z = pi.zod;
	pi.setLabel("A2A Project Mesh");

	let hub: HubClient | null = null;
	let configuredHubUrl: string | undefined;
	let sessionCwd = process.cwd();
	let heartbeatTimer: ReturnType<ExtensionContext["setInterval"]> | null = null;
	let inboxTimer: ReturnType<ExtensionContext["setInterval"]> | null = null;
	let clearTimer: ExtensionContext["clearTimer"] | null = null;
	let activePoll: Promise<void> | null = null;
	let activeHeartbeat: Promise<void> | null = null;
	let backgroundAbort: AbortController | null = null;

	const refreshHubUrl = (cwd: string) => {
		const config = loadLocalConfig(cwd);
		configuredHubUrl = config?.hubUrl;
		return config;
	};

	const ensureClient = async (): Promise<HubClient> => {
		const target = resolveHubUrl({ hubUrl: configuredHubUrl });
		if (hub?.baseUrl !== target) hub = null;
		if (hub) return hub;
		hub = await HubClient.connect({ hubUrl: configuredHubUrl });
		return hub;
	};

	const operations = new A2aOperations({ getClient: ensureClient });

	const stopBackground = async () => {
		if (clearTimer && heartbeatTimer != null) clearTimer(heartbeatTimer);
		if (clearTimer && inboxTimer != null) clearTimer(inboxTimer);
		heartbeatTimer = null;
		inboxTimer = null;
		const controller = backgroundAbort;
		controller?.abort(new Error("A2A background work stopped"));
		const poll = activePoll;
		const heartbeat = activeHeartbeat;
		await Promise.all([poll?.catch(() => undefined), heartbeat?.catch(() => undefined)]);
		if (activePoll === poll) activePoll = null;
		if (activeHeartbeat === heartbeat) activeHeartbeat = null;
		if (backgroundAbort === controller) backgroundAbort = null;
	};

	const injectEnvelope = (message: HubMessageEnvelope, deliverAs: "steer" | "followUp") => {
		pi.sendMessage(
			{
				customType: "a2a-inbound",
				content: `[a2a inbound] ref=${message.messageRef ?? "-"} from=${message.from} project=${message.project} at=${new Date(message.createdAt).toISOString()} msg=${message.msgId} replyTo=${message.replyToRef ?? message.replyTo ?? "-"}\n${message.text}`,
				display: true,
				details: message,
			},
			{ deliverAs, triggerTurn: true },
		);
	};

	const startBackground = (context: TimerContext) => {
		clearTimer = (handle) => context.clearTimer(handle);
		if (!operations.membership) return;
		const controller = new AbortController();
		backgroundAbort = controller;
		heartbeatTimer = context.setInterval(() => {
			if (activeHeartbeat) return;
			const heartbeat = operations
				.heartbeat(controller.signal)
				.then(() => undefined)
				.catch((error) => {
					if (!controller.signal.aborted) {
						pi.logger?.warn?.(
							`a2a heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				})
				.finally(() => {
					if (activeHeartbeat === heartbeat) activeHeartbeat = null;
				});
			activeHeartbeat = heartbeat;
		}, HEARTBEAT_MS);
		inboxTimer = context.setInterval(() => {
			if (activePoll) return;
			const poll = operations
				.receive((message: HubEnvelope) => {
					if (message.kind === "delivery_receipt") {
						context.ui.notify(
							`[a2a delivered] ref=${message.messageRef ?? "-"} msg=${message.receiptFor} to=${message.from} at=${new Date(message.deliveredAt).toISOString()}`,
							"info",
						);
						return;
					}
					injectEnvelope(message, context.isIdle() ? "followUp" : "steer");
				}, controller.signal)
				.then(() => undefined)
				.catch((error) => {
					if (!controller.signal.aborted) {
						pi.logger?.warn?.(`a2a inbox poll failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				})
				.finally(() => {
					if (activePoll === poll) activePoll = null;
				});
			activePoll = poll;
		}, 1_000);
	};

	const run = async (request: A2aOperationRequest, context: TimerContext & { cwd: string; sessionId?: string }) => {
		const changesMembership = request.action === "join" || request.action === "leave";
		if (changesMembership) await stopBackground();
		try {
			return await operations.execute(request, { cwd: context.cwd, sessionId: context.sessionId });
		} finally {
			if (changesMembership && operations.membership) startBackground(context);
		}
	};

	pi.on("session_start", async (_event, context) => {
		sessionCwd = context.cwd;
		let config;
		try {
			config = refreshHubUrl(context.cwd);
		} catch (error) {
			context.ui.notify(`A2A config error: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		try {
			await ensureClient();
		} catch (error) {
			context.ui.notify(
				`A2A Hub unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		if (!config || config.autoJoin === false) return;
		try {
			const result = await run(
				{
					action: "join",
					project: config.project,
					agentId: config.agentId,
					caps: config.caps,
					displayName: config.displayName,
				},
				context,
			);
			context.ui.notify(result.text, "info");
		} catch (error) {
			context.ui.notify(`A2A auto-join failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		await stopBackground();
		try {
			await operations.execute({ action: "leave" }, { cwd: sessionCwd });
		} catch (error) {
			pi.logger?.warn?.(`a2a leave failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	pi.registerCommand("a2a", {
		description: "A2A multi-project custom mesh client",
		handler: async (args, context) => {
			sessionCwd = context.cwd;
			const raw = args.trim();
			try {
				refreshHubUrl(context.cwd);
				if (!raw || raw === "help" || raw === "--help" || raw === "-h") {
					context.ui.notify(usage(), "info");
					return;
				}
				const request = commandRequest(raw);
				if (!request) throw new Error(`unknown subcommand. ${usage()}`);
				const result = await run(request, context);
				context.ui.notify(result.text, result.cleanupPending ? "warning" : "info");
			} catch (error) {
				context.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "a2a",
		label: "A2A Mesh",
		description: `Custom multi-project mesh client for a standalone Hub. Send messages with agent-friendly refs such as api:42; use replyToRef for causal replies. Create/list/delete projects; join/leave; list members; receive messages. ${ASYNC_REPLY_GUIDANCE}`,
		parameters: z.object({
			op: z.enum([
				"project_create",
				"project_delete",
				"project_list",
				"join",
				"leave",
				"list",
				"status",
				"send",
				"inbox",
				"hub",
			]),
			project: z.string().optional(),
			agentId: z.string().optional(),
			to: z.string().optional(),
			text: z.string().optional(),
			messageId: z.string().optional(),
			replyTo: z.string().optional(),
			replyToRef: z.string().optional(),
			displayName: z.string().optional(),
			description: z.string().optional(),
			caps: z.array(z.string()).optional(),
			all: z.boolean().optional(),
		}),
		async execute(_id, params, _signal, _onUpdate, context) {
			sessionCwd = context.cwd;
			try {
				refreshHubUrl(context.cwd);
				const result = await run(
					{
						action: params.op,
						project: params.project,
						agentId: params.agentId,
						to: params.to,
						text: params.text,
						messageId: params.messageId,
						displayName: params.displayName,
						replyTo: params.replyTo,
						replyToRef: params.replyToRef,
						description: params.description,
						caps: params.caps,
						all: params.all,
					},
					context,
				);
				return {
					content: [{ type: "text", text: result.text }],
					details: result.details,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: message }],
					details: { error: message },
					isError: true,
				};
			}
		},
	});
}
