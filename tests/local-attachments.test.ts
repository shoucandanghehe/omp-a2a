import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { materializeLocalAttachments } from "../src/local-attachments";

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
