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
import { encodeBinaryPayload, validateAttachmentName } from "./hub/payload";
import type { EncodedAttachment } from "./hub/types";
import type { MessageAttachment } from "./operations";

export type LocalAttachmentReference = {
	name: string;
	url: string;
};

export type MaterializedLocalAttachments = {
	attachments: LocalAttachmentReference[];
	commit(): void;
	dispose(): Promise<void>;
};

async function readStableFile(
	filePath: string,
	source: string,
	signal?: AbortSignal,
): Promise<Buffer> {
	signal?.throwIfAborted();
	const file = await open(filePath, "r");
	try {
		signal?.throwIfAborted();
		const before = await file.stat();
		signal?.throwIfAborted();
		if (!before.isFile())
			throw new Error(`attachment source must be a regular file: ${source}`);
		const buffer = Buffer.allocUnsafe(before.size);
		let offset = 0;
		while (offset < buffer.byteLength) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(
				buffer,
				offset,
				buffer.byteLength - offset,
				offset,
			);
			signal?.throwIfAborted();
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const after = await file.stat();
		signal?.throwIfAborted();
		if (offset !== before.size || after.size !== before.size)
			throw new Error(`attachment changed while being read: ${source}`);
		return buffer;
	} finally {
		await file.close();
	}
}

export async function snapshotLocalAttachments(
	sources: string[],
	localProtocolOptions: LocalProtocolOptions | undefined,
	signal?: AbortSignal,
): Promise<EncodedAttachment[]> {
	signal?.throwIfAborted();
	if (sources.length === 0) return [];
	if (!localProtocolOptions)
		throw new Error("current OMP session does not expose local:// storage");

	const attachments: EncodedAttachment[] = [];
	const names = new Set<string>();
	for (const source of sources) {
		if (!source.startsWith("local://"))
			throw new Error(`attachment source must use local://: ${source}`);
		signal?.throwIfAborted();
		const resolved = await resolveLocalUrlToFile(source, {
			localProtocolOptions,
		});
		signal?.throwIfAborted();
		if (!resolved)
			throw new Error(`attachment source must be a regular file: ${source}`);
		const bytes = await readStableFile(resolved.path, source, signal);
		signal?.throwIfAborted();
		const name = validateAttachmentName(path.basename(resolved.path), names);
		attachments.push({
			name,
			payload: encodeBinaryPayload(bytes),
		});
	}
	return attachments;
}

export async function materializeLocalAttachments(
	attachments: MessageAttachment[],
	localProtocolOptions: LocalProtocolOptions | undefined,
	signal?: AbortSignal,
): Promise<MaterializedLocalAttachments> {
	signal?.throwIfAborted();
	if (attachments.length === 0) {
		return {
			attachments: [],
			commit() {},
			async dispose() {},
		};
	}
	const names = new Set<string>();
	for (const attachment of attachments)
		validateAttachmentName(attachment.name, names);
	if (!localProtocolOptions)
		throw new Error("current OMP session does not expose local:// storage");

	let outputDirectory: string | null = null;
	try {
		const localRoot = resolveLocalUrlToPath("local://", localProtocolOptions);
		signal?.throwIfAborted();
		await mkdir(localRoot, { recursive: true });
		signal?.throwIfAborted();
		const realRoot = await realpath(localRoot);
		signal?.throwIfAborted();
		outputDirectory = await mkdtemp(path.join(realRoot, "a2a-"));
		signal?.throwIfAborted();

		const references: LocalAttachmentReference[] = [];
		for (const attachment of attachments) {
			signal?.throwIfAborted();
			const filePath = path.join(outputDirectory, attachment.name);
			await writeFile(filePath, attachment.bytes, {
				flag: "wx",
				mode: 0o600,
				signal,
			});
			signal?.throwIfAborted();
			references.push({
				name: attachment.name,
				url: `local://${encodeURIComponent(path.basename(outputDirectory))}/${encodeURIComponent(attachment.name)}`,
			});
		}

		const directory = outputDirectory;
		let state: "pending" | "committed" | "disposed" = "pending";
		let cleanup: Promise<void> | null = null;
		let abort: (() => void) | undefined;
		const dispose = async (): Promise<void> => {
			if (state === "committed") return;
			if (!cleanup) {
				state = "disposed";
				if (abort) signal?.removeEventListener("abort", abort);
				cleanup = rm(directory, { recursive: true, force: true });
			}
			await cleanup;
		};
		abort = () => {
			void dispose().catch(() => undefined);
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			await dispose();
			signal.throwIfAborted();
		}
		return {
			attachments: references,
			commit() {
				signal?.throwIfAborted();
				if (state === "disposed")
					throw new Error("A2A attachment materialization was disposed");
				state = "committed";
				if (abort) signal?.removeEventListener("abort", abort);
			},
			dispose,
		};
	} catch (error) {
		if (!outputDirectory) throw error;
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
