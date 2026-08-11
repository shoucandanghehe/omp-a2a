export type HubMeta = {
	protocolVersion: number;
};

export type EncodedTextPayload =
	| { encoding: "identity"; data: string }
	| { encoding: "gzip+base64"; data: string };

export type EncodedBinaryPayload =
	| { encoding: "base64"; data: string }
	| { encoding: "gzip+base64"; data: string };

export type EncodedAttachment = {
	name: string;
	payload: EncodedBinaryPayload;
};
