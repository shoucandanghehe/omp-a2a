import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
	decodeBinaryPayload,
	decodeTextPayload,
	encodeBinaryPayload,
	encodeTextPayload,
	MAX_ATTACHMENT_COUNT,
	MAX_ENCODED_PAYLOAD_BYTES,
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_TEXT_BYTES,
	parseEncodedAttachments,
	PayloadTooLargeError,
	validateMessageContent,
} from "../src/hub/payload";

test("large text compresses and round-trips while decoded size stays bounded", () => {
	const text = "compressible payload line\n".repeat(2_000);
	const payload = encodeTextPayload(text);
	expect(payload.encoding).toBe("gzip+base64");
	expect(decodeTextPayload(payload)).toBe(text);
	expect(() => encodeTextPayload("x".repeat(MAX_TEXT_BYTES + 1))).toThrow(
		`exceeds ${MAX_TEXT_BYTES} bytes`,
	);
});

test("small text remains identity encoded", () => {
	expect(encodeTextPayload("small")).toEqual({
		encoding: "identity",
		data: "small",
		uncompressedBytes: 5,
	});
});

test("binary attachment payload round-trips arbitrary bytes", () => {
	const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
	const payload = encodeBinaryPayload(bytes);
	expect(decodeBinaryPayload(payload)).toEqual(bytes);
	expect(() =>
		decodeBinaryPayload({
			...payload,
			uncompressedBytes: bytes.byteLength + 1,
		}),
	).toThrow("size does not match");
	expect(() =>
		decodeBinaryPayload({
			encoding: "base64",
			data: `${payload.data}\n`,
			uncompressedBytes: bytes.byteLength,
		}),
	).toThrow("canonical Base64");
	expect(() =>
		decodeBinaryPayload({
			encoding: "base64",
			data: "A".repeat(MAX_ENCODED_PAYLOAD_BYTES + 1),
			uncompressedBytes: 1,
		}),
	).toThrow(`exceeds ${MAX_ENCODED_PAYLOAD_BYTES} bytes`);
});

test("message content and attachment count share explicit bounds", () => {
	const fullSizeAttachment = {
		name: "full.bin",
		payload: encodeBinaryPayload(Buffer.alloc(MAX_MESSAGE_CONTENT_BYTES)),
	};
	expect(() =>
		validateMessageContent(encodeTextPayload("x"), [fullSizeAttachment]),
	).toThrow(`exceeds ${MAX_MESSAGE_CONTENT_BYTES} bytes`);
	expect(() =>
		parseEncodedAttachments(
			Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, index) => ({
				name: `${index}.txt`,
				payload: encodeBinaryPayload(Buffer.alloc(0)),
			})),
		),
	).toThrow(`more than ${MAX_ATTACHMENT_COUNT} attachments`);
});

test("oversized identity payloads are rejected at decode", () => {
	const data = "x".repeat(32 * 1024);
	expect(() =>
		decodeTextPayload({
			encoding: "identity",
			data,
			uncompressedBytes: Buffer.byteLength(data),
		}),
	).toThrow("identity payload must be smaller");
});

test("declared and actual gzip overflow are classified as payload too large", () => {
	const compressedBomb = gzipSync(Buffer.alloc(MAX_TEXT_BYTES + 1)).toString(
		"base64",
	);
	expect(() =>
		decodeTextPayload({
			encoding: "gzip+base64",
			data: compressedBomb,
			uncompressedBytes: MAX_TEXT_BYTES + 1,
		}),
	).toThrow(`exceeds ${MAX_TEXT_BYTES} bytes`);
	expect(() =>
		decodeTextPayload({
			encoding: "gzip+base64",
			data: compressedBomb,
			uncompressedBytes: MAX_TEXT_BYTES,
		}),
	).toThrow(`exceeds ${MAX_TEXT_BYTES} bytes`);
});

test("malformed gzip and decoded-size mismatch remain distinct", () => {
	let malformedError: unknown;
	try {
		decodeTextPayload({
			encoding: "gzip+base64",
			data: Buffer.from("not gzip").toString("base64"),
			uncompressedBytes: 8,
		});
	} catch (error) {
		malformedError = error;
	}
	expect(malformedError).toBeInstanceOf(Error);
	expect(malformedError).not.toBeInstanceOf(PayloadTooLargeError);
	expect(() =>
		decodeTextPayload({
			encoding: "gzip+base64",
			data: gzipSync("short").toString("base64"),
			uncompressedBytes: 6,
		}),
	).toThrow("does not match payload metadata");
});

test("encoded payloads are canonical and size bounded", () => {
	const canonical = gzipSync("small").toString("base64");
	expect(() =>
		decodeTextPayload({
			encoding: "gzip+base64",
			data: `${canonical}\n`,
			uncompressedBytes: 5,
		}),
	).toThrow("canonical Base64");
	expect(() =>
		decodeTextPayload({
			encoding: "gzip+base64",
			data: "A".repeat(MAX_ENCODED_PAYLOAD_BYTES + 1),
			uncompressedBytes: 1,
		}),
	).toThrow(`exceeds ${MAX_ENCODED_PAYLOAD_BYTES} bytes`);
});
