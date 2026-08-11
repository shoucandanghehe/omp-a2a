import { PROJECT_NAME_RE } from "../types";
import type { EncodedAttachment, EncodedTextPayload } from "./types";

export const A2A_PROTOCOL_VERSION = 3;

export const MESSAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

type ParsedMessageRef = { project: string; sequence: number };

export function formatMessageRef(project: string, sequence: number): string {
	if (
		!PROJECT_NAME_RE.test(project) ||
		!Number.isSafeInteger(sequence) ||
		sequence <= 0
	) {
		throw new Error("invalid message reference components");
	}
	return `${project}:${sequence}`;
}

export function parseMessageRef(reference: string): ParsedMessageRef {
	const separator = reference.lastIndexOf(":");
	const project = reference.slice(0, separator);
	const sequenceText = reference.slice(separator + 1);
	const sequence = Number(sequenceText);
	if (
		separator <= 0 ||
		!PROJECT_NAME_RE.test(project) ||
		!/^[1-9]\d*$/.test(sequenceText) ||
		!Number.isSafeInteger(sequence)
	) {
		throw new Error(`invalid message reference: ${reference}`);
	}
	return { project, sequence };
}

export type Peer = {
	name: string;
	presenceId: string;
};

export type MessageTarget =
	| { type: "agent"; name: string; presenceId?: string }
	| { type: "project" };

export type MessageRequestTarget =
	| { type: "agent"; name: string }
	| { type: "project" };

export type AcceptedMessage = {
	message: RealtimeMessage;
	recipients: string[];
};

export type DeliveryEvent = {
	messageId: string;
	to: string;
} & (
	| { status: "delivered" | "disconnected" }
	| { status: "failed"; error: string }
);

export type RealtimeMessage = {
	messageId: string;
	messageRef: string;
	project: string;
	sequence: number;
	from: Peer;
	target: MessageTarget;
	payload: EncodedTextPayload;
	attachments: EncodedAttachment[];
	createdAt: number;
	replyTo?: string;
};

export type HistoryQuery = {
	project: string;
	before?: string;
	after?: string;
	limit?: number;
	from?: string;
};

export type HistoryPage = {
	messages: RealtimeMessage[];
};

export type ClientFrame =
	| { type: "hello"; protocolVersion: number; project: string; name: string }
	| {
			type: "message";
			requestId: string;
			messageId: string;
			target: MessageRequestTarget;
			payload: EncodedTextPayload;
			attachments: EncodedAttachment[];
			replyTo?: string;
	  }
	| { type: "delivered"; messageId: string }
	| { type: "delivery_failed"; messageId: string; error: string };

export type ServerFrame =
	| {
			type: "claimed";
			protocolVersion: typeof A2A_PROTOCOL_VERSION;
			project: string;
			self: Peer;
			peers: Peer[];
	  }
	| { type: "presence_joined"; peer: Peer }
	| {
			type: "presence_left";
			peer: Peer;
			reason: "connection_closed" | "heartbeat_timeout" | "hub_shutdown";
	  }
	| {
			type: "accepted";
			requestId: string;
			message: RealtimeMessage;
			recipients: string[];
	  }
	| { type: "message"; message: RealtimeMessage }
	| ({ type: "delivery" } & DeliveryEvent)
	| { type: "error"; code: string; message: string; requestId?: string };
