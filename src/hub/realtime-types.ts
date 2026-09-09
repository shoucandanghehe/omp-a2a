import { AGENT_NAME_RE, PROJECT_NAME_RE } from "../types";
import { decodeTextPayload, parseEncodedAttachments } from "./payload";
import type { EncodedAttachment, EncodedTextPayload } from "./types";

export const A2A_PROTOCOL_VERSION = 5;
export const DELIVERY_ACKNOWLEDGE_TIMEOUT_MS = 2_000;

export const MESSAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

/** Magic target selecting every current Project Presence except the sender. */
export const ALL_TARGET = "@all";

const PEER_KEYS = ["name", "presenceId"] as const;
const ALL_TARGET_KEYS = ["type"] as const;
const AGENTS_TARGET_KEYS = ["type", "names", "presenceIds"] as const;
const PAYLOAD_KEYS = ["encoding", "data"] as const;
const ATTACHMENT_KEYS = ["name", "payload"] as const;
const USER_APPROVAL_KEYS = ["kind"] as const;
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
	"userApproval",
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

function stringArrayField(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string[] {
	const field = value[key];
	if (!Array.isArray(field))
		throw new Error(`${label}.${key} must be an array`);
	return field.map((entry) => {
		if (typeof entry !== "string")
			throw new Error(`${label}.${key} entries must be strings`);
		return entry;
	});
}

function optionalStringArrayField(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string[] | undefined {
	if (value[key] === undefined) return undefined;
	return stringArrayField(value, key, label);
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

/**
 * Canonicalizes one outbound target list: entries are current peer names, or the
 * single magic value `@all`. Names are sorted so one recipient set has one
 * canonical form; duplicates and mixing `@all` with names are rejected.
 */
export function normalizeRequestTarget(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error(
			`target must be a non-empty array of peer names or ["${ALL_TARGET}"]`,
		);
	const entries: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string")
			throw new Error("target entries must be strings");
		entries.push(entry);
	}
	if (entries.includes(ALL_TARGET)) {
		if (entries.length > 1)
			throw new Error(`target must not mix ${ALL_TARGET} with peer names`);
		return [ALL_TARGET];
	}
	for (const name of entries) {
		if (!AGENT_NAME_RE.test(name))
			throw new Error(`invalid target name: ${name}`);
	}
	if (new Set(entries).size !== entries.length)
		throw new Error("target names must be unique");
	return entries.sort();
}

function decodeTarget(value: unknown): MessageTarget {
	const candidate = record(value, "message.target");
	const type = stringField(candidate, "type", "message.target");
	if (type === "all") {
		exactRecord(candidate, "message.target", ALL_TARGET_KEYS);
		return { type };
	}
	if (type !== "agents") throw new Error("message.target.type is invalid");
	const target = exactRecord(candidate, "message.target", AGENTS_TARGET_KEYS);
	const names = stringArrayField(target, "names", "message.target");
	if (names.length === 0)
		throw new Error("message.target.names must not be empty");
	if (new Set(names).size !== names.length)
		throw new Error("message.target.names must be unique");
	for (const name of names) {
		if (!AGENT_NAME_RE.test(name))
			throw new Error("message.target.names is invalid");
	}
	const presenceIds = optionalStringArrayField(
		target,
		"presenceIds",
		"message.target",
	);
	if (presenceIds) {
		if (presenceIds.length !== names.length)
			throw new Error("message.target.presenceIds must match names");
		for (const presenceId of presenceIds) {
			if (!presenceId) throw new Error("message.target.presenceIds is invalid");
		}
	}
	return presenceIds === undefined
		? { type, names }
		: { type, names, presenceIds };
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
export function decodeUserApprovalReceipt(
	value: unknown,
	label = "userApproval",
): UserApprovalReceipt {
	const receipt = exactRecord(value, label, USER_APPROVAL_KEYS);
	if (stringField(receipt, "kind", label) !== "omp-ui")
		throw new Error(`${label}.kind is invalid`);
	return { kind: "omp-ui" };
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
	if (message.userApproval !== undefined) {
		decoded.userApproval = decodeUserApprovalReceipt(
			message.userApproval,
			"message.userApproval",
		);
	}
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
	| { type: "all" }
	| { type: "agents"; names: string[]; presenceIds?: string[] };
export type UserApprovalReceipt = { kind: "omp-ui" };

/** Requested recipients: current peer names, or the single magic value `@all`. */
export type MessageRequestTarget = string[];

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
	userApproval?: UserApprovalReceipt;
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
			userApproval?: UserApprovalReceipt;
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
