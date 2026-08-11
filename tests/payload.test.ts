import { expect, test } from "bun:test";
import {
	decodeBinaryPayload,
	decodeTextPayload,
	encodeBinaryPayload,
	encodeTextPayload,
	parseEncodedAttachments,
	PAYLOAD_COMPRESSION_THRESHOLD_BYTES,
} from "../src/hub/payload";

function pseudoRandomBytes(size: number): Buffer {
	const bytes = Buffer.allocUnsafe(size);
	let state = 0x9e3779b9;
	for (let index = 0; index < bytes.byteLength; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[index] = state & 0xff;
	}
	return bytes;
}

test("text payloads round-trip through identity and gzip encodings", () => {
	expect(encodeTextPayload("small")).toEqual({
		encoding: "identity",
		data: "small",
	});
	const text = "compressible payload line\n".repeat(2_000);
	const payload = encodeTextPayload(text);
	expect(payload.encoding).toBe("gzip+base64");
	expect(decodeTextPayload(payload)).toBe(text);
});

test("binary payloads use gzip only when it is smaller", () => {
	const compressible = Buffer.alloc(PAYLOAD_COMPRESSION_THRESHOLD_BYTES, 0);
	const compressed = encodeBinaryPayload(compressible);
	expect(compressed.encoding).toBe("gzip+base64");
	expect(decodeBinaryPayload(compressed)).toEqual(compressible);

	const incompressible = pseudoRandomBytes(
		PAYLOAD_COMPRESSION_THRESHOLD_BYTES,
	);
	const identity = encodeBinaryPayload(incompressible);
	expect(identity.encoding).toBe("base64");
	expect(decodeBinaryPayload(identity)).toEqual(incompressible);
});

test("attachment parsing has no application count limit", () => {
	const attachments = Array.from({ length: 12 }, (_, index) => ({
		name: `${index}.txt`,
		payload: encodeBinaryPayload(Buffer.from([index])),
	}));
	expect(parseEncodedAttachments(attachments)).toEqual(attachments);
});

test("attachment parsing rejects unsafe and duplicate names", () => {
	const payload = encodeBinaryPayload(Buffer.from("attachment"));
	const invalidNames = [
		"",
		"   ",
		".",
		"..",
		"folder/file.txt",
		String.raw`folder\file.txt`,
		"line\nbreak.txt",
	];
	for (const name of invalidNames) {
		expect(() => parseEncodedAttachments([{ name, payload }])).toThrow();
	}
	expect(() =>
		parseEncodedAttachments([
			{ name: "duplicate.txt", payload },
			{ name: "duplicate.txt", payload },
		]),
	).toThrow();
});

test("payload decoders reject invalid and noncanonical Base64", () => {
	for (const data of ["%%%", "YQ", "YR=="]) {
		expect(() => decodeBinaryPayload({ encoding: "base64", data })).toThrow();
		expect(() =>
			parseEncodedAttachments([
				{
					name: "attachment.txt",
					payload: { encoding: "base64", data },
				},
			]),
		).toThrow();
	}

	const compressed = encodeTextPayload("compressible payload\n".repeat(4_000));
	if (compressed.encoding !== "gzip+base64")
		throw new Error("test payload did not compress");
	expect(() =>
		decodeTextPayload({ ...compressed, data: `${compressed.data}\n` }),
	).toThrow();
});

test("payload decoders require exact encoding and data fields", () => {
	expect(() =>
		decodeTextPayload({
			encoding: "identity",
			data: "message",
			uncompressedBytes: 7,
		} as never),
	).toThrow();
	expect(() =>
		decodeTextPayload({
			encoding: "identity",
			data: "message",
			unknown: true,
		} as never),
	).toThrow();
	expect(() =>
		decodeBinaryPayload({
			encoding: "base64",
			data: "YQ==",
			uncompressedBytes: 1,
		} as never),
	).toThrow();
	expect(() =>
		decodeBinaryPayload({
			encoding: "base64",
			data: "YQ==",
			unknown: true,
		} as never),
	).toThrow();
});

test("attachment parsing requires exact attachment and payload fields", () => {
	const payload = { encoding: "base64" as const, data: "YQ==" };
	expect(() =>
		parseEncodedAttachments([
			{ name: "handoff.txt", payload, unknown: true },
		]),
	).toThrow();
	expect(() =>
		parseEncodedAttachments([
			{
				name: "handoff.txt",
				payload: { ...payload, uncompressedBytes: 1 },
			},
		]),
	).toThrow();
	expect(() =>
		parseEncodedAttachments([
			{ name: "handoff.txt", payload: { ...payload, unknown: true } },
		]),
	).toThrow();
});

test("malformed compressed payloads throw their codec errors", () => {
	const data = Buffer.from("not gzip", "utf8").toString("base64");
	expect(() =>
		decodeTextPayload({ encoding: "gzip+base64", data }),
	).toThrow();
	expect(() =>
		decodeBinaryPayload({ encoding: "gzip+base64", data }),
	).toThrow();
});
