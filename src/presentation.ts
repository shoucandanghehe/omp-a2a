import type {
	AgentToolResult,
	MessageRenderer,
} from "@oh-my-pi/pi-coding-agent";
import { UiNode } from "@oh-my-pi/pi-tui";
import type { Peer } from "./hub/realtime-types";
import type { LocalAttachmentReference } from "./local-attachments";
import type { MessageView } from "./operations";

export type MaterializedMessageView = Omit<MessageView, "attachments"> & {
	attachments: LocalAttachmentReference[];
};

export type PeersDetails =
	| { rooms: Array<{ room: string; self: Peer; peers: Peer[] }> }
	| { error: string };

export type HistoryDetails =
	| { messages: MaterializedMessageView[] }
	| { error: string };

function messageHeading(message: MaterializedMessageView): string {
	const target =
		message.target.type === "all" ? "@all" : message.target.names.join(", ");
	return `${message.messageRef} · ${message.from.name} → ${target}`;
}

function messageBody(message: MaterializedMessageView): UiNode[] {
	return [
		...(message.replyTo
			? [new UiNode("text", { text: `Reply to ${message.replyTo}` })]
			: []),
		new UiNode("md", { text: message.text }),
		...(message.attachments.length
			? [
					new UiNode("section", {
						head: "Attachments",
						children: message.attachments.map(
							({ name, url }) =>
								new UiNode("text", { text: `${name}\n${url}` }),
						),
					}),
				]
			: []),
	];
}

function approvalStyle(message: MaterializedMessageView, heading: string) {
	if (message.userApproval?.kind !== "omp-ui") return {};
	const title = "Approved by sender's user";
	return { tone: "success" as const, title, aria: `${heading} · ${title}` };
}

export const renderInboundMessage: MessageRenderer<MaterializedMessageView> = ({
	details,
}) => {
	if (!details) return;
	const heading = `A2A ${messageHeading(details)}`;
	return new UiNode("card", {
		head: heading,
		role: "omp.custom.a2a",
		...approvalStyle(details, heading),
		children: messageBody(details),
	});
};

export function renderToolText(result: AgentToolResult): UiNode[] {
	return result.content.flatMap((part) =>
		part.type === "text" ? [new UiNode("text", { text: part.text })] : [],
	);
}

export function renderPeers(
	result: AgentToolResult<PeersDetails>,
): UiNode | UiNode[] {
	const details = result.details;
	if (!details || !("rooms" in details)) return renderToolText(result);
	return new UiNode("table", {
		cols: [
			{ id: "room", head: "Room" },
			{ id: "name", head: "Name" },
			{ id: "role", head: "Role" },
		],
		rows: details.rooms.flatMap(({ room, self, peers }) =>
			[self, ...peers].map((peer, index) => ({
				id: peer.presenceId,
				cells: { room, name: peer.name, role: index === 0 ? "You" : "Peer" },
			})),
		),
	});
}

export function renderHistory(
	result: AgentToolResult<HistoryDetails>,
): UiNode[] {
	const details = result.details;
	if (!details || !("messages" in details)) return renderToolText(result);
	if (details.messages.length === 0)
		return [new UiNode("text", { text: "No messages." })];
	return details.messages.map((message) => {
		const heading = messageHeading(message);
		return new UiNode("section", {
			key: message.messageId,
			head: heading,
			...approvalStyle(message, heading),
			children: messageBody(message),
		});
	});
}

export function renderMessageCall(args: {
	room?: string;
	target?: string[];
	text?: string;
	attachments?: string[];
	replyTo?: string;
	requestUserSignature?: boolean;
}): UiNode[] {
	const meta = [
		args.target?.length ? `To ${args.target.join(", ")}` : "",
		args.room ? `Room ${args.room}` : "",
		args.replyTo ? `Reply to ${args.replyTo}` : "",
		args.requestUserSignature ? "approval requested" : "",
	].filter(Boolean);
	return [
		...(meta.length ? [new UiNode("text", { text: meta.join(" · ") })] : []),
		...(args.text !== undefined ? [new UiNode("md", { text: args.text })] : []),
		...(args.attachments?.length
			? [
					new UiNode("section", {
						head: "Attachments",
						children: args.attachments.map(
							(url) => new UiNode("text", { text: url }),
						),
					}),
				]
			: []),
	];
}
