import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBinaryPayload } from "../src/hub/payload";
import {
	materializeLocalAttachments,
	snapshotLocalAttachments,
} from "../src/local-attachments";

test("attachment materialization rejects unsafe and duplicate names", async () => {
	const artifacts = mkdtempSync(join(tmpdir(), "omp-a2a-materialization-"));
	const localProtocolOptions = {
		getArtifactsDir: () => artifacts,
		getSessionId: () => "materialization-test",
	};
	const invalidNames = [
		"../escape.txt",
		String.raw`folder\file.txt`,
		"",
		"   ",
		".",
		"..",
		"line\nbreak.txt",
	];

	try {
		for (const name of invalidNames) {
			await expect(
				materializeLocalAttachments(
					[{ name, bytes: Buffer.from("attachment") }],
					localProtocolOptions,
				),
			).rejects.toThrow();
		}
		await expect(
			materializeLocalAttachments(
				[
					{ name: "duplicate.txt", bytes: Buffer.from("first") },
					{ name: "duplicate.txt", bytes: Buffer.from("second") },
				],
				localProtocolOptions,
			),
		).rejects.toThrow();
	} finally {
		rmSync(artifacts, { recursive: true, force: true });
	}
});

test("attachment snapshots use session-local files without following links outside the root", async () => {
	const artifacts = mkdtempSync(join(tmpdir(), "omp-a2a-snapshot-"));
	const localRoot = join(artifacts, "local");
	const localProtocolOptions = {
		getArtifactsDir: () => artifacts,
		getSessionId: () => "snapshot-test",
	};
	try {
		mkdirSync(localRoot);
		writeFileSync(join(localRoot, "binary.dat"), Buffer.from([0, 255, 42]));
		const attachments = await snapshotLocalAttachments(
			["local://binary.dat"],
			localProtocolOptions,
		);
		const [attachment] = attachments;
		if (!attachment) throw new Error("attachment snapshot missing");
		expect(attachment.name).toBe("binary.dat");
		expect(decodeBinaryPayload(attachment.payload)).toEqual(
			Buffer.from([0, 255, 42]),
		);

		writeFileSync(join(artifacts, "outside.dat"), "private");
		symlinkSync(join(artifacts, "outside.dat"), join(localRoot, "escape.dat"));
		await expect(
			snapshotLocalAttachments(["local://escape.dat"], localProtocolOptions),
		).rejects.toThrow("escapes");
	} finally {
		rmSync(artifacts, { recursive: true, force: true });
	}
});
