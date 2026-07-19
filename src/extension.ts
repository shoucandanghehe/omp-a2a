import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadLocalConfig } from "./config";
import { HubClient, resolveHubUrl } from "./hub/client";
import type { HubEnvelope, HubMessageEnvelope } from "./hub/types";
import { A2aOperations, type A2aOperationRequest } from "./operations";
import { AGENT_ID_RE, HEARTBEAT_MS, PROJECT_NAME_RE } from "./types";

type TimerContext = {
	setInterval: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
	isIdle: () => boolean;
	ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
};

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
		"/a2a send <agentId> <message...> [--message-id <id>] [--reply-to <msgId>]",
		"/a2a inbox",
		"/a2a status",
		"/a2a hub",
		"/a2a help",
	].join("\n");
}

function commandRequest(raw: string): A2aOperationRequest | null {
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
	if (command === "send") {
		const to = positional[1];
		const text = positional.slice(2).join(" ").trim();
		if (!to || !text) throw new Error("usage: /a2a send <agentId> <message...>");
		return {
			action: "send",
			to,
			text,
			messageId: typeof flags["message-id"] === "string" ? flags["message-id"] : undefined,
			replyTo: typeof flags["reply-to"] === "string" ? flags["reply-to"] : undefined,
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
	let heartbeatTimer: unknown = null;
	let inboxTimer: unknown = null;
	let clearTimer: ((handle: unknown) => void) | null = null;
	let polling = false;

	const refreshHubUrl = (cwd: string) => {
		configuredHubUrl = loadLocalConfig(cwd)?.hubUrl;
	};

	const ensureClient = async (): Promise<HubClient> => {
		const target = resolveHubUrl({ hubUrl: configuredHubUrl });
		if (hub?.baseUrl !== target) hub = null;
		if (hub) return hub;
		hub = await HubClient.connect({ hubUrl: configuredHubUrl });
		return hub;
	};

	const operations = new A2aOperations({ getClient: ensureClient });

	const stopBackground = () => {
		if (clearTimer && heartbeatTimer != null) clearTimer(heartbeatTimer);
		if (clearTimer && inboxTimer != null) clearTimer(inboxTimer);
		heartbeatTimer = null;
		inboxTimer = null;
		polling = false;
	};

	const injectEnvelope = (message: HubMessageEnvelope, deliverAs: "steer" | "followUp") => {
		pi.sendMessage(
			{
				customType: "a2a-inbound",
				content: `[a2a inbound] from=${message.from} project=${message.project} seq=${message.serverSequence} at=${new Date(message.createdAt).toISOString()} msg=${message.msgId} replyTo=${message.replyTo ?? "-"}\n${message.text}`,
				display: true,
				details: message,
			},
			{ deliverAs, triggerTurn: true },
		);
	};

	const startBackground = (context: TimerContext) => {
		stopBackground();
		clearTimer = (handle) => context.clearTimer(handle);
		if (!operations.membership) return;
		heartbeatTimer = context.setInterval(() => {
			void operations.heartbeat().catch((error) => {
				pi.logger?.warn?.(`a2a heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, HEARTBEAT_MS);
		inboxTimer = context.setInterval(() => {
			if (polling) return;
			polling = true;
			void operations
				.receive((message: HubEnvelope) => {
					if (message.kind === "delivery_receipt") {
						context.ui.notify(
							`[a2a delivered] seq=${message.serverSequence} msg=${message.receiptFor} to=${message.from} at=${new Date(message.deliveredAt).toISOString()}`,
							"info",
						);
						return;
					}
					injectEnvelope(message, context.isIdle() ? "followUp" : "steer");
				})
				.catch((error) => {
					pi.logger?.warn?.(`a2a inbox poll failed: ${error instanceof Error ? error.message : String(error)}`);
				})
				.finally(() => {
					polling = false;
				});
		}, 1_000);
	};

	const run = async (request: A2aOperationRequest, context: TimerContext & { cwd: string; sessionId?: string }) => {
		if (request.action === "join" || request.action === "leave") stopBackground();
		const result = await operations.execute(request, { cwd: context.cwd, sessionId: context.sessionId });
		if (result.membershipChanged === "joined") startBackground(context);
		return result;
	};

	pi.on("session_start", async (_event, context) => {
		sessionCwd = context.cwd;
		refreshHubUrl(context.cwd);
		try {
			await ensureClient();
		} catch (error) {
			context.ui.notify(
				`A2A Hub unavailable at ${resolveHubUrl({ hubUrl: configuredHubUrl })}: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		const config = loadLocalConfig(context.cwd);
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
		stopBackground();
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
			refreshHubUrl(context.cwd);
			const raw = args.trim();
			if (!raw || raw === "help" || raw === "--help" || raw === "-h") {
				context.ui.notify(usage(), "info");
				return;
			}
			try {
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
		description:
			"Custom multi-project mesh client for a standalone Hub. Create/list/delete projects; join/leave; list members; send and receive messages. Deleting a project requires every member to be offline.",
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
			displayName: z.string().optional(),
			description: z.string().optional(),
			caps: z.array(z.string()).optional(),
			all: z.boolean().optional(),
		}),
		async execute(_id, params, _signal, _onUpdate, context) {
			sessionCwd = context.cwd;
			refreshHubUrl(context.cwd);
			try {
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
