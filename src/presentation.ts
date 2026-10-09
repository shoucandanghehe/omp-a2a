import type { MessageRenderer } from "@oh-my-pi/pi-coding-agent";
import {
	Box,
	getMarkdownTheme,
	Markdown,
	Spacer,
	Text,
	type Theme,
} from "@oh-my-pi/pi-tui";
import type { CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type {
	NativeToolView,
	ToolRenderResult,
} from "@oh-my-pi/pi-tui/tools/renderer";
import type { Peer } from "./hub/realtime-types";
import type { LocalAttachmentReference } from "./local-attachments";
import type { MessageView } from "./operations";

export type MaterializedMessageView = Omit<MessageView, "attachments"> & {
	attachments: LocalAttachmentReference[];
};

export type PeersDetails = { self: Peer; peers: Peer[] } | { error: string };

export type HistoryDetails =
	| { messages: MaterializedMessageView[] }
	| { error: string };

function messageHeading(message: MaterializedMessageView): string {
	const target =
		message.target.type === "all" ? "@all" : message.target.names.join(", ");
	return `${message.messageRef} · ${message.from.name} → ${target}`;
}

function messageBody(message: MaterializedMessageView): NativeNode[] {
	const items = [
		{ k: "Project", v: message.project },
		{ k: "Message ID", v: message.messageId },
		{ k: "Sequence", v: String(message.sequence) },
		{ k: "Sender presence", v: message.from.presenceId },
		{ k: "Time", v: new Date(message.createdAt).toISOString() },
		{
			k: "Sender user approval",
			v: message.userApproval?.kind === "omp-ui" ? "confirmed" : "unsigned",
		},
	];
	if (message.target.type === "agents" && message.target.presenceIds)
		items.push({
			k: "Recipient presences",
			v: message.target.presenceIds.join(", "),
		});
	if (message.replyTo) items.push({ k: "Reply to", v: message.replyTo });
	const body: NativeNode[] = [
		{ k: "kv", p: { items }, key: "metadata" },
		{ k: "code", p: { text: message.text, lang: "text" }, key: "message" },
	];
	if (message.attachments.length > 0)
		body.push({
			k: "section",
			p: { head: "Attachments" },
			key: "attachments",
			c: message.attachments.map((attachment) => ({
				k: "text",
				p: { text: `${attachment.name}\n${attachment.url}` },
			})),
		});
	return body;
}

class InboundMessageComponent extends Box {
	readonly #view: NativeNode;

	constructor(
		message: CustomMessage<MaterializedMessageView>,
		details: MaterializedMessageView,
		theme: Theme,
	) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.setIgnoreTight(true);
		this.setBorder({
			chars: theme.boxRound,
			color: (text) => theme.fg("borderMuted", text),
		});
		this.addChild(
			new Text(
				theme.fg(
					"customMessageLabel",
					theme.bold(`${theme.icon.package} ${message.customType}`),
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => ("text" in part ? part.text : ""))
						.join("\n");
		this.addChild(
			new Markdown(content, 0, 0, getMarkdownTheme(), {
				color: (text) => theme.fg("customMessageText", text),
			}),
		);
		this.#view = {
			k: "card",
			p: { head: `A2A ${messageHeading(details)}`, role: "omp.custom.a2a" },
			c: messageBody(details),
		};
	}

	override describe(): NativeNode {
		return this.#view;
	}
}

export const renderInboundMessage: MessageRenderer<MaterializedMessageView> = (
	message,
	_options,
	theme,
) =>
	message.details
		? new InboundMessageComponent(message, message.details, theme)
		: undefined;

export function describeToolText(result: ToolRenderResult): NativeToolView {
	return {
		body: result.content
			.filter((part) => part.type === "text")
			.map((part) => ({ k: "text", p: { text: part.text } })),
	};
}

export function describePeers(
	result: ToolRenderResult<PeersDetails>,
): NativeToolView | undefined {
	const details = result.details;
	if (!details || !("peers" in details)) return undefined;
	return {
		body: [
			{
				k: "table",
				p: {
					cols: [
						{ id: "name", head: "Name" },
						{ id: "role", head: "Role" },
						{ id: "presence", head: "Presence" },
					],
					rows: [details.self, ...details.peers].map((peer, index) => ({
						id: peer.presenceId,
						cells: {
							name: peer.name,
							role: index === 0 ? "You" : "Peer",
							presence: peer.presenceId,
						},
					})),
				},
			},
		],
	};
}

export function describeHistory(
	result: ToolRenderResult<HistoryDetails>,
): NativeToolView | undefined {
	const details = result.details;
	if (!details || !("messages" in details)) return undefined;
	return {
		body:
			details.messages.length === 0
				? [{ k: "text", p: { text: "No messages." } }]
				: details.messages.map((message) => ({
						k: "section",
						key: message.messageId,
						p: { head: messageHeading(message) },
						c: messageBody(message),
					})),
	};
}

export function describeMessageCall(args: {
	target?: string[];
	text?: string;
	attachments?: string[];
	replyTo?: string;
	requestUserSignature?: boolean;
}): NativeToolView {
	const body: NativeNode[] = [];
	if (args.text !== undefined)
		body.push({ k: "code", p: { text: args.text, lang: "text" } });
	if (args.attachments?.length)
		body.push({
			k: "section",
			p: { head: "Attachments" },
			c: args.attachments.map((url) => ({ k: "text", p: { text: url } })),
		});
	return {
		tool: {
			title: "A2A Message",
			target: args.target?.join(", "),
			meta: args.replyTo ? [`Reply to ${args.replyTo}`] : undefined,
			note: args.requestUserSignature ? "approval requested" : undefined,
		},
		body,
	};
}
