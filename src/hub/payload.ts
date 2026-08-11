import { gunzipSync, gzipSync } from "node:zlib";
import type {
	EncodedAttachment,
	EncodedBinaryPayload,
	EncodedTextPayload,
} from "./types";

export const PAYLOAD_COMPRESSION_THRESHOLD_BYTES = 32 * 1024;

export function encodeTextPayload(text: string): EncodedTextPayload {
	const byteLength = Buffer.byteLength(text, "utf8");
	if (byteLength < PAYLOAD_COMPRESSION_THRESHOLD_BYTES) {
		return { encoding: "identity", data: text };
	}
	const bytes = Buffer.from(text, "utf8");
	const compressed = gzipSync(bytes);
	return compressed.byteLength < bytes.byteLength
		? { encoding: "gzip+base64", data: compressed.toString("base64") }
		: { encoding: "identity", data: text };
}

export function decodeTextPayload(payload: EncodedTextPayload): string {
	if (!payload || typeof payload !== "object")
		throw new Error("message text payload is required");
	if (payload.encoding === "identity") {
		if (typeof payload.data !== "string")
			throw new Error("message text data must be a string");
		return payload.data;
	}
	if (payload.encoding === "gzip+base64") {
		if (typeof payload.data !== "string")
			throw new Error("message text data must be a string");
		return gunzipSync(Buffer.from(payload.data, "base64")).toString("utf8");
	}
	throw new Error("unsupported message text encoding");
}

export function encodeBinaryPayload(bytes: Uint8Array): EncodedBinaryPayload {
	const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.byteLength >= PAYLOAD_COMPRESSION_THRESHOLD_BYTES) {
		const compressed = gzipSync(input);
		if (compressed.byteLength < bytes.byteLength) {
			return {
				encoding: "gzip+base64",
				data: compressed.toString("base64"),
			};
		}
	}
	return { encoding: "base64", data: input.toString("base64") };
}

export function decodeBinaryPayload(payload: EncodedBinaryPayload): Buffer {
	if (!payload || typeof payload !== "object")
		throw new Error("attachment payload is required");
	if (typeof payload.data !== "string")
		throw new Error("attachment data must be a string");
	const encoded = Buffer.from(payload.data, "base64");
	if (payload.encoding === "base64") return encoded;
	if (payload.encoding === "gzip+base64") return gunzipSync(encoded);
	throw new Error("unsupported attachment encoding");
}

export function parseEncodedAttachments(value: unknown): EncodedAttachment[] {
	if (!Array.isArray(value)) throw new Error("attachments must be an array");
	return value.map((candidate) => {
		if (
			!candidate ||
			typeof candidate !== "object" ||
			!("name" in candidate) ||
			typeof candidate.name !== "string" ||
			!("payload" in candidate)
		) {
			throw new Error("invalid attachment");
		}
		const payload = candidate.payload;
		if (
			!payload ||
			typeof payload !== "object" ||
			!("encoding" in payload) ||
			(payload.encoding !== "base64" && payload.encoding !== "gzip+base64") ||
			!("data" in payload) ||
			typeof payload.data !== "string"
		) {
			throw new Error(`invalid attachment payload: ${candidate.name}`);
		}
		const attachment: EncodedAttachment = {
			name: candidate.name,
			payload: {
				encoding: payload.encoding,
				data: payload.data,
			},
		};
		return attachment;
	});
}
