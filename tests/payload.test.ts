import { expect, test } from "bun:test";
import {
	decodeBinaryPayload,
	decodeTextPayload,
	encodeBinaryPayload,
	encodeTextPayload,
	MAX_ATTACHMENT_COUNT,
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_TEXT_BYTES,
	parseEncodedAttachments,
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
