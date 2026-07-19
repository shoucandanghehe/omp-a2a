export type HubMeta = {
	pid: number;
	port: number;
	baseUrl: string;
	dataDir: string;
	startedAt: number;
};

export type EncodedTextPayload =
	| { encoding: "identity"; data: string; uncompressedBytes: number }
	| { encoding: "gzip+base64"; data: string; uncompressedBytes: number };

export type HubWireEnvelope = {
	msgId: string;
	project: string;
	from: string;
	to: string;
	payload: EncodedTextPayload;
	createdAt: number;
};

export type HubEnvelope = {
	msgId: string;
	project: string;
	from: string;
	to: string;
	text: string;
	createdAt: number;
};

export type HubRegisterBody = {
	project: string;
	agentId: string;
	cwd: string;
	pid?: number;
	caps?: string[];
	displayName?: string;
	sessionId?: string;
};

export type HubSendBody = {
	project: string;
	from: string;
	to: string;
	payload: EncodedTextPayload;
};

export type HubSendInput = {
	project: string;
	from: string;
	to: string;
	text: string;
};
