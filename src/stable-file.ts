import { open } from "node:fs/promises";

/** Read one regular file, failing if it changes while being read. */
export async function readStableFile(
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
