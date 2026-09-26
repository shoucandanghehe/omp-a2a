import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { encodeBinaryPayload, validateAttachmentName } from "../hub/payload";
import type { EncodedAttachment } from "../hub/types";
import type { MessageView } from "../operations";
import { readStableFile } from "../stable-file";

export type AttachmentPath = { name: string; path: string };

/** Snapshot sender files, resolving relative sources against the project directory. */
export async function snapshotFileAttachments(
	sources: string[],
	projectDir: string,
	signal?: AbortSignal,
): Promise<EncodedAttachment[]> {
	const attachments: EncodedAttachment[] = [];
	const names = new Set<string>();
	for (const source of sources) {
		signal?.throwIfAborted();
		const filePath = path.resolve(projectDir, source);
		const bytes = await readStableFile(filePath, source, signal);
		const name = validateAttachmentName(path.basename(filePath), names);
		attachments.push({ name, payload: encodeBinaryPayload(bytes) });
	}
	return attachments;
}

/**
 * Write Message attachments below `inboxRoot` at a path derived from the
 * Message identity, so inbound delivery and later history reads reuse one copy.
 */
export async function materializeFileAttachments(
	message: Pick<MessageView, "project" | "sequence" | "messageId"> & {
		attachments: MessageView["attachments"];
	},
	inboxRoot: string,
	signal?: AbortSignal,
): Promise<AttachmentPath[]> {
	if (message.attachments.length === 0) return [];
	const names = new Set<string>();
	for (const attachment of message.attachments)
		validateAttachmentName(attachment.name, names);
	const identity = createHash("sha256")
		.update(message.messageId)
		.digest("hex")
		.slice(0, 12);
	const directory = path.join(
		inboxRoot,
		message.project,
		`${message.sequence}-${identity}`,
	);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const paths: AttachmentPath[] = [];
	for (const attachment of message.attachments) {
		signal?.throwIfAborted();
		const filePath = path.join(directory, attachment.name);
		const existing = await stat(filePath).catch(() => null);
		if (existing?.size !== attachment.bytes.byteLength) {
			const temporary = `${filePath}.${process.pid}.${Date.now()}.partial`;
			try {
				await writeFile(temporary, attachment.bytes, { mode: 0o600, signal });
				await rename(temporary, filePath);
			} catch (error) {
				await rm(temporary, { force: true });
				throw error;
			}
		}
		paths.push({ name: attachment.name, path: filePath });
	}
	return paths;
}
