import { createHash } from "node:crypto";
import type { MessageRequestTarget, Peer } from "./hub/realtime-types";
import type { EncodedAttachment } from "./hub/types";

/** Stable identity of one exact outbound Message awaiting sender-side approval. */
export function signatureFingerprint(options: {
	project: string;
	from: Peer;
	target: MessageRequestTarget;
	text: string;
	replyTo?: string;
	messageId: string;
	attachments: EncodedAttachment[];
}): string {
	const value = [
		options.project,
		[options.from.name, options.from.presenceId],
		options.target,
		options.text,
		options.replyTo ?? null,
		options.messageId,
		options.attachments.map((attachment) => [
			attachment.name,
			attachment.payload.encoding,
			attachment.payload.data,
		]),
	];
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
