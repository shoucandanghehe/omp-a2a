import { gunzipSync, gzipSync } from "node:zlib";
import type {
	EncodedAttachment,
	EncodedBinaryPayload,
	EncodedTextPayload,
} from "./types";

export const PAYLOAD_COMPRESSION_THRESHOLD_BYTES = 32 * 1024;
export const MAX_MESSAGE_CONTENT_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_BYTES = MAX_MESSAGE_CONTENT_BYTES;
export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENT_NAME_BYTES = 255;
export const MAX_ENCODED_PAYLOAD_BYTES = 6 * 1024 * 1024 - 64 * 1024;

export class PayloadTooLargeError extends Error {}

function assertUncompressedBytes(value: unknown, label: string): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0
	) {
		throw new PayloadTooLargeError(
			`${label} has invalid uncompressed byte count`,
		);
	}
	if (value > MAX_MESSAGE_CONTENT_BYTES) {
		throw new PayloadTooLargeError(
			`${label} exceeds ${MAX_MESSAGE_CONTENT_BYTES} bytes after decoding`,
		);
	}
	return value;
}

function decodeBase64(data: unknown, label: string): Buffer {
	if (typeof data !== "string")
		throw new Error(`${label} data must be a string`);
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data)
		throw new Error(`${label} data is not canonical Base64`);
	return bytes;
}

export function encodeTextPayload(text: string): EncodedTextPayload {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength > MAX_TEXT_BYTES) {
		throw new PayloadTooLargeError(
			`message text exceeds ${MAX_TEXT_BYTES} bytes`,
		);
	}
	if (bytes.byteLength < PAYLOAD_COMPRESSION_THRESHOLD_BYTES) {
		return {
			encoding: "identity",
			data: text,
			uncompressedBytes: bytes.byteLength,
		};
	}
	return {
		encoding: "gzip+base64",
		data: gzipSync(bytes).toString("base64"),
		uncompressedBytes: bytes.byteLength,
	};
}

export function decodeTextPayload(payload: EncodedTextPayload): string {
	if (!payload || typeof payload !== "object")
		throw new Error("message text payload is required");
	if (typeof payload.data !== "string")
		throw new Error("message text data must be a string");
	if (Buffer.byteLength(payload.data, "utf8") > MAX_ENCODED_PAYLOAD_BYTES) {
		throw new PayloadTooLargeError(
			`encoded message payload exceeds ${MAX_ENCODED_PAYLOAD_BYTES} bytes`,
		);
	}
	const expectedBytes = assertUncompressedBytes(
		payload.uncompressedBytes,
		"message text",
	);
	let bytes: Buffer;
	if (payload.encoding === "identity") {
		bytes = Buffer.from(payload.data, "utf8");
		if (bytes.byteLength >= PAYLOAD_COMPRESSION_THRESHOLD_BYTES) {
			throw new Error(
				`identity payload must be smaller than ${PAYLOAD_COMPRESSION_THRESHOLD_BYTES} bytes`,
			);
		}
	} else if (payload.encoding === "gzip+base64") {
		try {
			bytes = gunzipSync(decodeBase64(payload.data, "message gzip payload"), {
				maxOutputLength: MAX_TEXT_BYTES + 1,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ERR_BUFFER_TOO_LARGE"
			) {
				throw new PayloadTooLargeError(
					`message text exceeds ${MAX_TEXT_BYTES} bytes after decoding`,
				);
			}
			throw error;
		}
	} else {
		throw new Error("unsupported message text encoding");
	}
	if (bytes.byteLength > MAX_TEXT_BYTES) {
		throw new PayloadTooLargeError(
			`message text exceeds ${MAX_TEXT_BYTES} bytes after decoding`,
		);
	}
	if (bytes.byteLength !== expectedBytes) {
		throw new Error("message text size does not match payload metadata");
	}
	return bytes.toString("utf8");
}

export function encodeBinaryPayload(bytes: Uint8Array): EncodedBinaryPayload {
	if (bytes.byteLength > MAX_MESSAGE_CONTENT_BYTES) {
		throw new PayloadTooLargeError(
			`attachment exceeds ${MAX_MESSAGE_CONTENT_BYTES} bytes`,
		);
	}
	const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.byteLength >= PAYLOAD_COMPRESSION_THRESHOLD_BYTES) {
		const compressed = gzipSync(input);
		if (compressed.byteLength < bytes.byteLength) {
			return {
				encoding: "gzip+base64",
				data: compressed.toString("base64"),
				uncompressedBytes: bytes.byteLength,
			};
		}
	}
	return {
		encoding: "base64",
		data: input.toString("base64"),
		uncompressedBytes: bytes.byteLength,
	};
}

export function decodeBinaryPayload(payload: EncodedBinaryPayload): Buffer {
	if (!payload || typeof payload !== "object")
		throw new Error("attachment payload is required");
	if (typeof payload.data !== "string")
		throw new Error("attachment data must be a string");
	if (Buffer.byteLength(payload.data, "utf8") > MAX_ENCODED_PAYLOAD_BYTES) {
		throw new PayloadTooLargeError(
			`encoded attachment payload exceeds ${MAX_ENCODED_PAYLOAD_BYTES} bytes`,
		);
	}
	const expectedBytes = assertUncompressedBytes(
		payload.uncompressedBytes,
		"attachment",
	);
	const encoded = decodeBase64(payload.data, "attachment");
	let bytes: Buffer;
	if (payload.encoding === "base64") {
		bytes = encoded;
	} else if (payload.encoding === "gzip+base64") {
		try {
			bytes = gunzipSync(encoded, {
				maxOutputLength: MAX_MESSAGE_CONTENT_BYTES + 1,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ERR_BUFFER_TOO_LARGE"
			) {
				throw new PayloadTooLargeError(
					`attachment exceeds ${MAX_MESSAGE_CONTENT_BYTES} bytes after decoding`,
				);
			}
			throw error;
		}
	} else {
		throw new Error("unsupported attachment encoding");
	}
	if (bytes.byteLength > MAX_MESSAGE_CONTENT_BYTES) {
		throw new PayloadTooLargeError(
			`attachment exceeds ${MAX_MESSAGE_CONTENT_BYTES} bytes after decoding`,
		);
	}
	if (bytes.byteLength !== expectedBytes)
		throw new Error("attachment size does not match payload metadata");
	return bytes;
}

export function parseEncodedAttachments(value: unknown): EncodedAttachment[] {
	if (!Array.isArray(value)) throw new Error("attachments must be an array");
	if (value.length > MAX_ATTACHMENT_COUNT) {
		throw new PayloadTooLargeError(
			`message has more than ${MAX_ATTACHMENT_COUNT} attachments`,
		);
	}
	const names = new Set<string>();
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
		const name = candidate.name;
		let hasControlCharacter = false;
		for (const character of name) {
			const codePoint = character.codePointAt(0);
			if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
				hasControlCharacter = true;
				break;
			}
		}
		if (
			name.length === 0 ||
			Buffer.byteLength(name, "utf8") > MAX_ATTACHMENT_NAME_BYTES ||
			name === "." ||
			name === ".." ||
			name.includes("/") ||
			name.includes("\\") ||
			hasControlCharacter
		) {
			throw new Error(`invalid attachment name: ${name}`);
		}
		if (names.has(name)) throw new Error(`duplicate attachment name: ${name}`);
		names.add(name);
		const payload = candidate.payload;
		if (
			!payload ||
			typeof payload !== "object" ||
			!("encoding" in payload) ||
			(payload.encoding !== "base64" && payload.encoding !== "gzip+base64") ||
			!("data" in payload) ||
			typeof payload.data !== "string" ||
			!("uncompressedBytes" in payload) ||
			typeof payload.uncompressedBytes !== "number"
		) {
			throw new Error(`invalid attachment payload: ${name}`);
		}
		const normalized: EncodedAttachment = {
			name,
			payload: {
				encoding: payload.encoding,
				data: payload.data,
				uncompressedBytes: payload.uncompressedBytes,
			},
		};
		decodeBinaryPayload(normalized.payload);
		return normalized;
	});
}

export function validateMessageContent(
	payload: EncodedTextPayload,
	attachmentsValue: unknown,
): { attachments: EncodedAttachment[]; contentBytes: number } {
	const text = decodeTextPayload(payload);
	if (text.trim().length === 0) throw new Error("message text required");
	const attachments = parseEncodedAttachments(attachmentsValue);
	const contentBytes = attachments.reduce(
		(total, attachment) => total + attachment.payload.uncompressedBytes,
		payload.uncompressedBytes,
	);
	if (contentBytes > MAX_MESSAGE_CONTENT_BYTES) {
		throw new PayloadTooLargeError(
			`message content exceeds ${MAX_MESSAGE_CONTENT_BYTES} bytes`,
		);
	}
	return { attachments, contentBytes };
}
