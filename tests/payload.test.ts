import { expect, test } from "bun:test";
import {
	decodeTextPayload,
	encodeTextPayload,
	MAX_TEXT_BYTES,
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
