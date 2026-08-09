import {
	mkdir,
	mkdtemp,
	open,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import {
	type LocalProtocolOptions,
	resolveLocalUrlToFile,
	resolveLocalUrlToPath,
} from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import {
	encodeBinaryPayload,
	MAX_ATTACHMENT_COUNT,
	MAX_MESSAGE_CONTENT_BYTES,
} from "./hub/payload";
import type { EncodedAttachment } from "./hub/types";
import type { MessageAttachment } from "./operations";

export type LocalAttachmentReference = {
	name: string;
	url: string;
	uncompressedBytes: number;
};

async function readStableFile(
	filePath: string,
	maxBytes: number,
	source: string,
): Promise<Buffer> {
	const file = await open(filePath, "r");
	try {
		const before = await file.stat();
		if (!before.isFile())
			throw new Error(`attachment source must be a regular file: ${source}`);
		if (before.size > maxBytes)
			throw new Error(`attachments exceed ${MAX_MESSAGE_CONTENT_BYTES} bytes`);
		const buffer = Buffer.allocUnsafe(before.size + 1);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const { bytesRead } = await file.read(
				buffer,
				offset,
				buffer.byteLength - offset,
				offset,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const after = await file.stat();
		if (offset !== before.size || after.size !== before.size)
			throw new Error(`attachment changed while being read: ${source}`);
		return buffer.subarray(0, offset);
	} finally {
		await file.close();
	}
}

export async function snapshotLocalAttachments(
	sources: string[],
	localProtocolOptions: LocalProtocolOptions | undefined,
): Promise<EncodedAttachment[]> {
	if (sources.length === 0) return [];
	if (!localProtocolOptions)
		throw new Error("current OMP session does not expose local:// storage");
	if (sources.length > MAX_ATTACHMENT_COUNT)
		throw new Error(
			`message has more than ${MAX_ATTACHMENT_COUNT} attachments`,
		);

	const attachments: EncodedAttachment[] = [];
	let totalBytes = 0;
	for (const source of sources) {
		if (!source.startsWith("local://"))
			throw new Error(`attachment source must use local://: ${source}`);
		const resolved = await resolveLocalUrlToFile(source, {
			localProtocolOptions,
		});
		if (!resolved)
			throw new Error(`attachment source must be a regular file: ${source}`);
		const bytes = await readStableFile(
			resolved.path,
			MAX_MESSAGE_CONTENT_BYTES - totalBytes,
			source,
		);
		totalBytes += bytes.byteLength;
		attachments.push({
			name: path.basename(resolved.path),
			payload: encodeBinaryPayload(bytes),
		});
	}
	return attachments;
}

export async function materializeLocalAttachments(
	attachments: MessageAttachment[],
	localProtocolOptions: LocalProtocolOptions | undefined,
): Promise<LocalAttachmentReference[]> {
	if (attachments.length === 0) return [];
	if (!localProtocolOptions)
		throw new Error("current OMP session does not expose local:// storage");

	const localRoot = resolveLocalUrlToPath("local://", localProtocolOptions);
	await mkdir(localRoot, { recursive: true });
	const realRoot = await realpath(localRoot);
	const outputDirectory = await mkdtemp(path.join(realRoot, "a2a-"));
	try {
		const references: LocalAttachmentReference[] = [];
		for (const attachment of attachments) {
			const filePath = path.join(outputDirectory, attachment.name);
			await writeFile(filePath, attachment.bytes, { flag: "wx", mode: 0o600 });
			references.push({
				name: attachment.name,
				url: `local://${encodeURIComponent(path.basename(outputDirectory))}/${encodeURIComponent(attachment.name)}`,
				uncompressedBytes: attachment.bytes.byteLength,
			});
		}
		return references;
	} catch (error) {
		try {
			await rm(outputDirectory, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"failed to materialize and clean up A2A attachments",
			);
		}
		throw error;
	}
}
