import type { EncodedAttachment, EncodedTextPayload } from "./types";

export const A2A_PROTOCOL_VERSION = 3;

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
