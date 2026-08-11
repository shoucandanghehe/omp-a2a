export type HubMeta = {
	protocolVersion: number;
};

export type EncodedTextPayload =
	| { encoding: "identity"; data: string; uncompressedBytes: number }
	| { encoding: "gzip+base64"; data: string; uncompressedBytes: number };

export type EncodedBinaryPayload =
	| { encoding: "base64"; data: string; uncompressedBytes: number }
	| { encoding: "gzip+base64"; data: string; uncompressedBytes: number };

export type EncodedAttachment = {
	name: string;
	payload: EncodedBinaryPayload;
};
