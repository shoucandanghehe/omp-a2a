import { gunzipSync, gzipSync } from "node:zlib";
import { formatMessageRef, parseMessageRef } from "./message-ref";
import type { EncodedTextPayload, HubEnvelope, HubWireEnvelope } from "./types";

export const TEXT_COMPRESSION_THRESHOLD_BYTES = 32 * 1024;
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export class PayloadTooLargeError extends Error {}

export function encodeTextPayload(text: string): EncodedTextPayload {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength > MAX_TEXT_BYTES) {
		throw new PayloadTooLargeError(`message text exceeds ${MAX_TEXT_BYTES} bytes`);
	}
	if (bytes.byteLength < TEXT_COMPRESSION_THRESHOLD_BYTES) {
		return { encoding: "identity", data: text, uncompressedBytes: bytes.byteLength };
	}
	return {
		encoding: "gzip+base64",
		data: gzipSync(bytes).toString("base64"),
		uncompressedBytes: bytes.byteLength,
	};
}

export function decodeTextPayload(payload: EncodedTextPayload): string {
	if (payload.uncompressedBytes > MAX_TEXT_BYTES) {
		throw new PayloadTooLargeError(`message text exceeds ${MAX_TEXT_BYTES} bytes after decoding`);
	}
	let bytes: Buffer;
	if (payload.encoding === "identity") {
		bytes = Buffer.from(payload.data, "utf8");
	} else if (payload.encoding === "gzip+base64") {
		try {
			bytes = gunzipSync(Buffer.from(payload.data, "base64"), { maxOutputLength: MAX_TEXT_BYTES + 1 });
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ERR_BUFFER_TOO_LARGE"
			) {
				throw new PayloadTooLargeError(`message text exceeds ${MAX_TEXT_BYTES} bytes after decoding`);
			}
			throw error;
		}
	} else {
		throw new Error("unsupported message text encoding");
	}
	if (bytes.byteLength > MAX_TEXT_BYTES) {
		throw new PayloadTooLargeError(`message text exceeds ${MAX_TEXT_BYTES} bytes after decoding`);
	}
	if (bytes.byteLength !== payload.uncompressedBytes) {
		throw new Error("message text size does not match payload metadata");
	}
	return bytes.toString("utf8");
}

export function decodeWireEnvelope(message: HubWireEnvelope): HubEnvelope {
	let serverSequence = message.serverSequence;
	if (serverSequence === undefined) {
		serverSequence = 0;
	} else if (!Number.isSafeInteger(serverSequence) || serverSequence <= 0) {
		throw new Error("invalid Inbox server sequence");
	}
	const messageRef = serverSequence > 0 ? formatMessageRef(message.to, serverSequence) : undefined;
	if (message.messageRef !== undefined && message.messageRef !== messageRef) {
		throw new Error("Inbox messageRef does not match recipient sequence");
	}
	if (message.replyToRef !== undefined) {
		parseMessageRef(message.replyToRef);
		if (message.replyTo === undefined) throw new Error("Inbox replyToRef requires replyTo");
	}
	const base = {
		msgId: message.msgId,
		project: message.project,
		from: message.from,
		to: message.to,
		text: decodeTextPayload(message.payload),
		createdAt: message.createdAt,
		serverSequence,
		messageRef,
		replyTo: message.replyTo,
		replyToRef: message.replyToRef,
	};
	const kind = message.kind;
	if (kind === undefined || kind === "message") return { ...base, kind: "message" };
	if (kind === "delivery_receipt") {
		if (typeof message.receiptFor !== "string" || typeof message.deliveredAt !== "number") {
			throw new Error("invalid delivery receipt metadata");
		}
		return {
			...base,
			kind,
			receiptFor: message.receiptFor,
			deliveredAt: message.deliveredAt,
		};
	}
	throw new Error(`unsupported inbox envelope kind: ${String(kind)}`);
}
