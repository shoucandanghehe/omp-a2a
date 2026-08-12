import { AGENT_NAME_RE, PROJECT_NAME_RE } from "../types";
import { decodeTextPayload, parseEncodedAttachments } from "./payload";
import type { EncodedAttachment, EncodedTextPayload } from "./types";

export const A2A_PROTOCOL_VERSION = 3;
export const DELIVERY_ACKNOWLEDGE_TIMEOUT_MS = 2_000;

export const MESSAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

const PEER_KEYS = ["name", "presenceId"] as const;
const PROJECT_TARGET_KEYS = ["type"] as const;
const AGENT_TARGET_KEYS = ["type", "name", "presenceId"] as const;
const PAYLOAD_KEYS = ["encoding", "data"] as const;
const ATTACHMENT_KEYS = ["name", "payload"] as const;
const MESSAGE_KEYS = [
	"messageId",
	"messageRef",
	"project",
	"sequence",
	"from",
	"target",
	"payload",
	"attachments",
	"createdAt",
	"replyTo",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactRecord(
	value: unknown,
	label: string,
	expectedKeys: readonly string[],
): Record<string, unknown> {
	const candidate = record(value, label);
	for (const key of Object.keys(candidate)) {
		if (!expectedKeys.includes(key))
			throw new Error(`${label}.${key} is not allowed`);
	}
	return candidate;
}

function stringField(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const field = value[key];
	if (typeof field !== "string")
		throw new Error(`${label}.${key} must be a string`);
	return field;
}

function optionalStringField(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	const field = value[key];
	if (field === undefined) return undefined;
	if (typeof field !== "string")
		throw new Error(`${label}.${key} must be a string`);
	return field;
}

function safeIntegerField(
	value: Record<string, unknown>,
	key: string,
	label: string,
	minimum: number,
): number {
	const field = value[key];
	if (
		typeof field !== "number" ||
		!Number.isSafeInteger(field) ||
		field < minimum
	) {
		throw new Error(`${label}.${key} must be a safe integer >= ${minimum}`);
	}
	return field;
}

function decodePeer(value: unknown): Peer {
	const peer = exactRecord(value, "message.from", PEER_KEYS);
	const name = stringField(peer, "name", "message.from");
	if (!AGENT_NAME_RE.test(name))
		throw new Error("message.from.name is invalid");
	const presenceId = stringField(peer, "presenceId", "message.from");
	if (!presenceId) throw new Error("message.from.presenceId must not be empty");
	return { name, presenceId };
}

function decodeTarget(value: unknown): MessageTarget {
	const candidate = record(value, "message.target");
	const type = stringField(candidate, "type", "message.target");
	const target = exactRecord(
		candidate,
		"message.target",
		type === "project" ? PROJECT_TARGET_KEYS : AGENT_TARGET_KEYS,
	);
	if (type === "project") return { type };
	if (type !== "agent") throw new Error("message.target.type is invalid");
	const name = stringField(target, "name", "message.target");
	if (!AGENT_NAME_RE.test(name))
		throw new Error("message.target.name is invalid");
	const presenceId = optionalStringField(
		target,
		"presenceId",
		"message.target",
	);
	if (presenceId === "")
		throw new Error("message.target.presenceId is invalid");
	return presenceId === undefined ? { type, name } : { type, name, presenceId };
}

function decodePayload(value: unknown): EncodedTextPayload {
	const payload = exactRecord(value, "message.payload", PAYLOAD_KEYS);
	const encoding = stringField(payload, "encoding", "message.payload");
	const data = stringField(payload, "data", "message.payload");
	if (encoding !== "identity" && encoding !== "gzip+base64")
		throw new Error("message.payload.encoding is invalid");
	const decoded: EncodedTextPayload = { encoding, data };
	decodeTextPayload(decoded);
	return decoded;
}

export function decodeRealtimeMessage(value: unknown): RealtimeMessage {
	const message = exactRecord(value, "message", MESSAGE_KEYS);
	const messageId = stringField(message, "messageId", "message");
	if (!MESSAGE_ID_RE.test(messageId))
		throw new Error("message.messageId is invalid");
	const project = stringField(message, "project", "message");
	if (!PROJECT_NAME_RE.test(project))
		throw new Error("message.project is invalid");
	const sequence = safeIntegerField(message, "sequence", "message", 1);
	const messageRef = stringField(message, "messageRef", "message");
	if (messageRef !== formatMessageRef(project, sequence))
		throw new Error("message.messageRef is not canonical");
	if (Array.isArray(message.attachments)) {
		for (const [index, candidate] of message.attachments.entries()) {
			const label = `message.attachments[${index}]`;
			const attachment = exactRecord(candidate, label, ATTACHMENT_KEYS);
			exactRecord(attachment.payload, `${label}.payload`, PAYLOAD_KEYS);
		}
	}
	const attachments = parseEncodedAttachments(message.attachments);
	const replyTo = optionalStringField(message, "replyTo", "message");
	if (replyTo !== undefined) {
		const reply = parseMessageRef(replyTo);
		if (reply.project !== project)
			throw new Error("message.replyTo belongs to another project");
		if (reply.sequence >= sequence)
			throw new Error("message.replyTo must precede the message");
	}
	const decoded: RealtimeMessage = {
		messageId,
		messageRef,
		project,
		sequence,
		from: decodePeer(message.from),
		target: decodeTarget(message.target),
		payload: decodePayload(message.payload),
		attachments,
		createdAt: safeIntegerField(message, "createdAt", "message", 0),
	};
	if (replyTo !== undefined) decoded.replyTo = replyTo;
	return decoded;
}

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

export function isExactGoodbyeFrame(
	value: unknown,
): value is { type: "goodbye" } {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		"type" in value &&
		value.type === "goodbye"
	);
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

export type AcceptedMessage =
	| {
			replayed: false;
			message: RealtimeMessage;
			recipients: string[];
	  }
	| {
			replayed: true;
			message: RealtimeMessage;
	  };

export type DeliveryEvent = {
	messageId: string;
	to: string;
} & ({ status: "delivered" } | { status: "failed"; error: string });

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
	| { type: "delivery_failed"; messageId: string; error: string }
	| { type: "goodbye" };

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
	| ({
			type: "accepted";
			requestId: string;
	  } & AcceptedMessage)
	| { type: "message"; message: RealtimeMessage }
	| ({ type: "delivery" } & DeliveryEvent)
	| { type: "goodbye" }
	| { type: "error"; code: string; message: string; requestId?: string };
