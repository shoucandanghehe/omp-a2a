import { AGENT_ID_RE } from "../types";

export class InvalidMessageRefError extends Error {}

export type MessageRef = {
	recipient: string;
	serverSequence: number;
};

export function formatMessageRef(recipient: string, serverSequence: number): string {
	if (!AGENT_ID_RE.test(recipient) || !Number.isSafeInteger(serverSequence) || serverSequence <= 0) {
		throw new InvalidMessageRefError("invalid message reference components");
	}
	return `${recipient}:${serverSequence}`;
}

export function parseMessageRef(reference: string): MessageRef {
	const separator = reference.indexOf(":");
	const recipient = reference.slice(0, separator);
	const sequenceText = reference.slice(separator + 1);
	const serverSequence = Number(sequenceText);
	if (
		separator <= 0 ||
		!AGENT_ID_RE.test(recipient) ||
		!/^[1-9]\d*$/.test(sequenceText) ||
		!Number.isSafeInteger(serverSequence)
	) {
		throw new InvalidMessageRefError(`invalid messageRef: ${reference}`);
	}
	return { recipient, serverSequence };
}
