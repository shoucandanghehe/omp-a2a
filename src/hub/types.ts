export type HubMeta = {
	pid: number;
	port: number;
	baseUrl: string;
	dataDir: string;
	startedAt: number;
	protocolVersion: number;
};

export type EncodedTextPayload =
	| { encoding: "identity"; data: string; uncompressedBytes: number }
	| { encoding: "gzip+base64"; data: string; uncompressedBytes: number };
