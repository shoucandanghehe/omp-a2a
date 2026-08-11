import { gunzipSync, gzipSync } from "node:zlib";
import type {
	EncodedAttachment,
	EncodedBinaryPayload,
	EncodedTextPayload,
} from "./types";

export const PAYLOAD_COMPRESSION_THRESHOLD_BYTES = 32 * 1024;

const CONTROL_CHARACTER_RE = /\p{Cc}/u;

function hasExactKeys(
	value: unknown,
	expectedKeys: readonly string[],
): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actualKeys = Reflect.ownKeys(value);
	return (
		actualKeys.length === expectedKeys.length &&
		expectedKeys.every((key) => Object.hasOwn(value, key))
	);
}

function decodeCanonicalBase64(data: unknown, label: string): Buffer {
	if (typeof data !== "string")
		throw new Error(`${label} data must be a string`);
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data)
		throw new Error(`${label} data is not canonical base64`);
	return bytes;
}

export function validateAttachmentName(
	value: unknown,
	names: Set<string>,
): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value === "." ||
		value === ".." ||
		value.includes("/") ||
		value.includes("\\") ||
		CONTROL_CHARACTER_RE.test(value)
	) {
		throw new Error(`invalid attachment name: ${String(value)}`);
	}
	if (names.has(value)) throw new Error(`duplicate attachment name: ${value}`);
	names.add(value);
	return value;
}

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
	if (!hasExactKeys(payload, ["encoding", "data"]))
		throw new Error("message text payload must contain only encoding and data");
	if (typeof payload.data !== "string")
		throw new Error("message text data must be a string");
	if (payload.encoding === "identity") return payload.data;
	if (payload.encoding === "gzip+base64") {
		return gunzipSync(
			decodeCanonicalBase64(payload.data, "message text"),
		).toString("utf8");
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
	if (!hasExactKeys(payload, ["encoding", "data"]))
		throw new Error("attachment payload must contain only encoding and data");
	const encoded = decodeCanonicalBase64(payload.data, "attachment");
	if (payload.encoding === "base64") return encoded;
	if (payload.encoding === "gzip+base64") return gunzipSync(encoded);
	throw new Error("unsupported attachment encoding");
}

export function parseEncodedAttachments(value: unknown): EncodedAttachment[] {
	if (!Array.isArray(value)) throw new Error("attachments must be an array");
	const names = new Set<string>();
	return value.map((candidate) => {
		if (!hasExactKeys(candidate, ["name", "payload"]))
			throw new Error("invalid attachment");
		const name = validateAttachmentName(candidate.name, names);
		const payloadValue = candidate.payload;
		if (
			!hasExactKeys(payloadValue, ["encoding", "data"]) ||
			(payloadValue.encoding !== "base64" &&
				payloadValue.encoding !== "gzip+base64") ||
			typeof payloadValue.data !== "string"
		) {
			throw new Error(`invalid attachment payload: ${name}`);
		}
		const payload: EncodedBinaryPayload = {
			encoding: payloadValue.encoding,
			data: payloadValue.data,
		};
		decodeBinaryPayload(payload);
		return { name, payload };
	});
}
