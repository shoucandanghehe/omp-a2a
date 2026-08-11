import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadLocalConfig } from "./config";
import { HubClient, resolveHubUrl } from "./hub/client";
import type { MessageRequestTarget } from "./hub/realtime-types";
import {
	type LocalAttachmentReference,
	materializeLocalAttachments,
	snapshotLocalAttachments,
} from "./local-attachments";
import { A2aRuntime, type MessageView } from "./operations";
import {
	AGENT_NAME_RE,
	type A2aLocalConfig,
	PROJECT_NAME_RE,
} from "./types";

const ASYNC_REPLY_GUIDANCE =
	"Replies arrive automatically. After sending, continue independent work; if blocked, end the current turn. Never wait, sleep, or poll a2a_history for a reply.";

function parseArgs(raw: string): {
	positional: string[];
	flags: Record<string, string | boolean>;
} {
	const tokens = raw.trim().length === 0 ? [] : raw.trim().split(/\s+/);
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token) continue;
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const separator = token.indexOf("=");
		if (separator > 2) {
			flags[token.slice(2, separator)] = token.slice(separator + 1);
			continue;
		}
		const name = token.slice(2);
		const next = tokens[index + 1];
		if (next && !next.startsWith("--")) {
			flags[name] = next;
			index++;
		} else {
			flags[name] = true;
		}
	}
	return { positional, flags };
}

interface CompletionOption {
	token: string;
	description: string;
	continues?: boolean;
}

const ROOT_COMPLETIONS: CompletionOption[] = [
	{ token: "hub", description: "Show Hub status" },
	{
		token: "project",
		description: "Create, list, or delete Projects",
		continues: true,
	},
	{
		token: "connect",
		description: "Connect this OMP session to a Project",
		continues: true,
	},
	{ token: "disconnect", description: "Disconnect the current Presence" },
	{ token: "status", description: "Show the current connection" },
	{ token: "peers", description: "List currently present Agents" },
	{
		token: "history",
		description: "Query persistent Project history",
		continues: true,
	},
	{ token: "help", description: "Show A2A command help" },
];

const PROJECT_COMPLETIONS: CompletionOption[] = [
	{ token: "create", description: "Create a Project", continues: true },
	{ token: "list", description: "List Projects" },
	{
		token: "delete",
		description: "Delete a Project and its history",
		continues: true,
	},
];

const HISTORY_COMPLETIONS: CompletionOption[] = [
	{
		token: "--before",
		description: "Messages before a MessageRef",
		continues: true,
	},
	{
		token: "--after",
		description: "Messages after a MessageRef",
		continues: true,
	},
	{
		token: "--limit",
		description: "Maximum messages to return",
		continues: true,
	},
	{
		token: "--from",
		description: "Only messages from one Agent name",
		continues: true,
	},
];

function completionItems(
	base: string,
	current: string,
	options: CompletionOption[],
): Array<{ value: string; label: string; description: string }> | null {
	const prefix = current.toLowerCase();
	const items = options
		.filter((option) => option.token.startsWith(prefix))
		.map((option) => ({
			value: `${base}${option.token}${option.continues ? " " : ""}`,
			label: option.token,
			description: option.description,
		}));
	return items.length === 0 ? null : items;
}

function completeA2aArguments(
	argumentPrefix: string,
): Array<{ value: string; label: string; description: string }> | null {
	const trailingSpace = /\s$/.test(argumentPrefix);
	const normalized = argumentPrefix.trim().replace(/\s+/g, " ");
	const words = normalized.length === 0 ? [] : normalized.split(" ");
	const current = trailingSpace ? "" : (words.pop() ?? "");

	if (words.length === 0) return completionItems("", current, ROOT_COMPLETIONS);

	const command = words[0];
	if (command === "project" && words.length === 1) {
		return completionItems("project ", current, PROJECT_COMPLETIONS);
	}
	if (command === "connect" && words.length === 2) {
		return completionItems(`connect ${words[1]} `, current, [
			{ token: "--as", description: "Set this Presence name", continues: true },
		]);
	}
	if (command !== "history") return null;

	const used = new Set<string>();
	const completedArguments = words.slice(1);
	for (let index = 0; index < completedArguments.length; index += 2) {
		const flag = completedArguments[index];
		const value = completedArguments[index + 1];
		if (
			!flag ||
			!HISTORY_COMPLETIONS.some((option) => option.token === flag) ||
			!value ||
			value.startsWith("--")
		) {
			return null;
		}
		used.add(flag);
	}
	if (current && !current.startsWith("--")) return null;
	const available = HISTORY_COMPLETIONS.filter((option) => {
		if (used.has(option.token)) return false;
		if (option.token === "--before" && used.has("--after")) return false;
		if (option.token === "--after" && used.has("--before")) return false;
		return true;
	});
	return completionItems(
		`${words.join(" ")}${words.length === 0 ? "" : " "}`,
		current,
		available,
	);
}

function usage(): string {
	return [
		"A2A anonymous realtime Agent chat",
		"",
		"/a2a hub",
		"/a2a project create <name>",
		"/a2a project list",
		"/a2a project delete <name>",
		"/a2a connect <project> --as <name>",
		"/a2a disconnect",
		"/a2a status",
		"/a2a peers",
		"/a2a history [--before <ref>] [--after <ref>] [--limit <n>] [--from <name>]",
		"/a2a help",
	].join("\n");
}

type MaterializedMessageView = Omit<MessageView, "attachments"> & {
	attachments: LocalAttachmentReference[];
};

async function materializeMessage(
	message: MessageView,
	context: Pick<ExtensionContext, "localProtocolOptions"> | null | undefined,
): Promise<MaterializedMessageView> {
	return {
		...message,
		attachments: await materializeLocalAttachments(
			message.attachments,
			context?.localProtocolOptions,
		),
	};
}

function formatAttachments(attachments: LocalAttachmentReference[]): string {
	if (attachments.length === 0) return "";
	return `\nAttachments:\n${attachments
		.map(
			(attachment) =>
				`- ${attachment.name} (${attachment.uncompressedBytes} bytes): ${attachment.url}`,
		)
		.join("\n")}`;
}

function formatMessages(messages: MaterializedMessageView[]): string {
	if (messages.length === 0) return "No messages.";
	return messages
		.map((message) => {
			const target =
				message.target.type === "project" ? "project" : message.target.name;
			const attachments = formatAttachments(message.attachments);
			return `[${message.messageRef}] ${message.from.name} -> ${target}${message.replyTo ? ` replyTo=${message.replyTo}` : ""}\n${message.text}${attachments}`;
		})
		.join("\n\n");
}

export default function a2aExtension(pi: ExtensionAPI) {
	const type = pi.arktype;
	pi.setLabel("A2A Realtime Chat");

	let client: HubClient | null = null;
	let configuredHubUrl: string | undefined;
	let configError: Error | null = null;
	let configLoaded = false;
	let activeContext: ExtensionContext | null = null;
	let desiredConnection: { project: string; name: string } | null = null;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let reconnectDelayMs = 500;
	let configRevision = 0;

	const refreshLocalConfig = (cwd: string) => {
		try {
			const config = loadLocalConfig(cwd);
			configuredHubUrl = config?.hubUrl;
			configError = null;
			configLoaded = true;
			configRevision += 1;
			return config;
		} catch (error) {
			configuredHubUrl = undefined;
			client = null;
			configError =
				error instanceof Error ? error : new Error(String(error));
			configLoaded = true;
			configRevision += 1;
			throw configError;
		}
	};
	const ensureClient = async (): Promise<HubClient> => {
		if (configError) throw configError;
		if (!configLoaded) {
			throw new Error("A2A config is not loaded for the active Session");
		}
		const revision = configRevision;
		const target = resolveHubUrl({ hubUrl: configuredHubUrl });
		if (client?.baseUrl !== target) client = null;
		if (!client) {
			const connected = await HubClient.connect({
				hubUrl: configuredHubUrl,
			});
			if (revision !== configRevision) {
				if (configError) throw configError;
				return await ensureClient();
			}
			client = connected;
		}
		return client;
	};

	const runtime = new A2aRuntime({
		getClient: ensureClient,
		events: {
			onPresenceJoined: (peer) =>
				activeContext?.ui.notify(`[a2a] ${peer.name} joined`, "info"),
			onPresenceLeft: (peer) =>
				activeContext?.ui.notify(`[a2a] ${peer.name} left`, "info"),
			onDelivery: (delivery) =>
				activeContext?.ui.notify(
					`[a2a] ${delivery.to} ${delivery.status}${delivery.status === "failed" ? `: ${delivery.error}` : ""}`,
					delivery.status === "failed" ? "error" : "info",
				),
			onError: (error) =>
				pi.logger?.warn?.(`a2a realtime error: ${error.message}`),
			onMessage: async (message) => {
				const context = activeContext;
				if (!context)
					throw new Error("A2A inbound message has no active session");
				const materialized = await materializeMessage(message, context);
				if (activeContext !== context)
					throw new Error("A2A inbound message cancelled after session change");
				const attachments = formatAttachments(materialized.attachments);
				pi.sendMessage(
					{
						customType: "a2a-inbound",
						content: `[a2a message] ref=${message.messageRef} from=${message.from.name} project=${message.project} at=${new Date(message.createdAt).toISOString()} replyTo=${message.replyTo ?? "-"}\n${message.text}${attachments}`,
						display: true,
						details: materialized,
					},
					{
						deliverAs: "steer",
						triggerTurn: true,
					},
				);
			},
			onClose: ({ manual }) => {
				if (manual || !desiredConnection) return;
				activeContext?.ui.notify(
					"[a2a] connection lost; reconnecting",
					"warning",
				);
				scheduleReconnect();
			},
		},
	});

	const connectDesired = async (): Promise<void> => {
		if (!desiredConnection) return;
		try {
			await runtime.connect(desiredConnection.project, desiredConnection.name);
			reconnectDelayMs = 500;
			activeContext?.ui.notify(
				`Connected to ${desiredConnection.project} as ${desiredConnection.name}`,
				"info",
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("name_in_use")) {
				desiredConnection = null;
				activeContext?.ui.notify(message, "error");
				return;
			}
			activeContext?.ui.notify(`A2A connect failed: ${message}`, "warning");
			scheduleReconnect();
		}
	};

	function scheduleReconnect(): void {
		if (reconnectTimer || !desiredConnection) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			void connectDesired();
		}, reconnectDelayMs);
		reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
	}

	const activateSession = async (context: ExtensionContext) => {
		activeContext = null;
		client = null;
		configuredHubUrl = undefined;
		configError = null;
		configLoaded = false;
		desiredConnection = null;
		configRevision += 1;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
		}
		await runtime.disconnect();
		activeContext = context;
		let config: A2aLocalConfig | null;
		try {
			config = refreshLocalConfig(context.cwd);
		} catch (error) {
			context.ui.notify(
				`A2A config error: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		if (!config || config.autoConnect === false) return;
		desiredConnection = { project: config.project, name: config.name };
		await connectDesired();
	};

	pi.on("before_agent_start", () => {
		const name = runtime.name;
		if (!name) return;
		return {
			systemPrompt: [
				`Your A2A roster name is ${name}. Address peers only by exact names returned by a2a_peers or by sender names in inbound A2A messages.`,
			],
		};
	});

	pi.on(
		"session_start",
		async (_event, context) => await activateSession(context),
	);
	pi.on(
		"session_switch",
		async (_event, context) => await activateSession(context),
	);
	pi.on("session_shutdown", async () => {
		activeContext = null;
		desiredConnection = null;
		client = null;
		configuredHubUrl = undefined;
		configError = null;
		configLoaded = false;
		configRevision += 1;
		clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
		await runtime.disconnect();
	});

	pi.registerCommand("a2a", {
		description: "A2A realtime chat connection and Project administration",
		getArgumentCompletions: completeA2aArguments,
		handler: async (raw, context) => {
			activeContext = context;
			const { positional, flags } = parseArgs(raw);
			const command = positional[0] ?? "help";
			try {
				refreshLocalConfig(context.cwd);
				if (command === "help" || command === "--help" || command === "-h") {
					context.ui.notify(usage(), "info");
					return;
				}
				if (command === "hub") {
					const status = await runtime.status();
					context.ui.notify(
						`Hub ${status.hub.baseUrl} protocol=${status.hub.protocolVersion} data=${status.hub.dataDir}`,
						"info",
					);
					return;
				}
				if (command === "project" && positional[1] === "create") {
					const name = positional[2];
					if (!name || !PROJECT_NAME_RE.test(name))
						throw new Error("usage: /a2a project create <name>");
					await runtime.createProject({ name, createdByCwd: context.cwd });
					context.ui.notify(`Created Project ${name}`, "info");
					return;
				}
				if (
					command === "project" &&
					(positional[1] === "list" || positional[1] === undefined)
				) {
					const projects = await runtime.listProjects();
					context.ui.notify(
						projects.length === 0
							? "No Projects."
							: projects.map((project) => project.name).join("\n"),
						"info",
					);
					return;
				}
				if (command === "project" && positional[1] === "delete") {
					const name = positional[2];
					if (!name || !PROJECT_NAME_RE.test(name))
						throw new Error("usage: /a2a project delete <name>");
					if (
						!(await context.ui.confirm(
							"Delete A2A Project",
							`Delete ${name} and its complete message history?`,
						))
					)
						return;
					const deleted = await runtime.deleteProject(name);
					context.ui.notify(
						deleted
							? `Deleted Project ${name}`
							: `Project ${name} does not exist`,
						"info",
					);
					return;
				}
				if (command === "connect") {
					const project = positional[1];
					const name = typeof flags.as === "string" ? flags.as : undefined;
					if (
						!project ||
						!PROJECT_NAME_RE.test(project) ||
						!name ||
						!AGENT_NAME_RE.test(name)
					) {
						throw new Error("usage: /a2a connect <project> --as <name>");
					}
					desiredConnection = { project, name };
					await connectDesired();
					return;
				}
				if (command === "disconnect") {
					desiredConnection = null;
					clearTimeout(reconnectTimer);
					reconnectTimer = undefined;
					context.ui.notify(
						(await runtime.disconnect())
							? "Disconnected"
							: "A2A is not connected",
						"info",
					);
					return;
				}
				if (command === "status") {
					const status = await runtime.status();
					context.ui.notify(
						status.connection
							? `Project: ${status.connection.project}\nName: ${status.connection.name}\nConnection: connected\nPeers: ${status.connection.peers.length}\nHub: ${status.hub.baseUrl}`
							: `Connection: disconnected\nHub: ${status.hub.baseUrl}`,
						"info",
					);
					return;
				}
				if (command === "peers") {
					const peers = runtime.peers();
					context.ui.notify(
						peers.length === 0
							? "No other Agents."
							: peers.map((peer) => peer.name).join("\n"),
						"info",
					);
					return;
				}
				if (command === "history") {
					const limit =
						flags.limit === undefined ? undefined : Number(flags.limit);
					const messages = await runtime.history({
						before: typeof flags.before === "string" ? flags.before : undefined,
						after: typeof flags.after === "string" ? flags.after : undefined,
						from: typeof flags.from === "string" ? flags.from : undefined,
						limit,
					});
					context.ui.notify(
						formatMessages(
							await Promise.all(
								messages.map((message) => materializeMessage(message, context)),
							),
						),
						"info",
					);
					return;
				}
				throw new Error(`unknown subcommand. ${usage()}`);
			} catch (error) {
				context.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});

	pi.registerTool({
		name: "a2a_peers",
		label: "A2A Peers",
		description:
			"List the exact A2A roster names currently addressable in this Project. Use only a returned name for target.type=agent.",
		parameters: type({}),
		async execute() {
			try {
				const peers = runtime.peers();
				return {
					content: [
						{
							type: "text",
							text:
								peers.length === 0
									? "No other Agents are present."
									: peers.map((peer) => peer.name).join("\n"),
						},
					],
					details: { peers },
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

	pi.registerTool({
		name: "a2a_message",
		label: "A2A Message",
		description: `Send to one current peer or all current peers. Use target.type=agent with a name from a2a_peers, or target.type=project for all current peers. Set replyTo to reply to an earlier Project message. Attachments must be current-session local:// regular files. ${ASYNC_REPLY_GUIDANCE}`,
		parameters: type({
			target: [{ type: "'agent'", name: "string" }, "|", { type: "'project'" }],
			text: "string",
			"attachments?": "string[]",
			"replyTo?": "string",
			"messageId?": "string",
		}),
		async execute(_id, parameters, _signal, _onUpdate, context) {
			try {
				const attachmentSources = parameters.attachments ?? [];
				const attachments = await snapshotLocalAttachments(
					attachmentSources,
					context?.localProtocolOptions,
				);
				const accepted = await runtime.message({
					target: parameters.target as MessageRequestTarget,
					text: parameters.text,
					attachments,
					replyTo: parameters.replyTo,
					messageId: parameters.messageId,
				});
				const target =
					parameters.target.type === "project"
						? `${accepted.recipients.length} Agents`
						: parameters.target.name;
				return {
					content: [
						{
							type: "text",
							text: `Sent to ${target} ref=${accepted.message.messageRef} attachments=${attachments.length}\n${ASYNC_REPLY_GUIDANCE}`,
						},
					],
					details: {
						...accepted,
						message: {
							...accepted.message,
							attachments: attachments.map((attachment, index) => ({
								name: attachment.name,
								url: attachmentSources[index],
								uncompressedBytes: attachment.payload.uncompressedBytes,
							})),
						},
					},
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

	pi.registerTool({
		name: "a2a_history",
		label: "A2A History",
		description:
			"Review earlier Project messages using before, after, limit, or from. Returned attachment links are valid in the current session. Use only for past context; never wait or poll for new replies.",
		parameters: type({
			"before?": "string",
			"after?": "string",
			"limit?": "number",
			"from?": "string",
		}),
		async execute(_id, parameters, _signal, _onUpdate, context) {
			try {
				const messages = await runtime.history(parameters);
				const materialized = await Promise.all(
					messages.map((message) => materializeMessage(message, context)),
				);
				return {
					content: [{ type: "text", text: formatMessages(materialized) }],
					details: { messages: materialized },
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
