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

type HubWireEnvelopeBase = {
	msgId: string;
	project: string;
	from: string;
	to: string;
	payload: EncodedTextPayload;
	createdAt: number;
	replyTo?: string;
};

export type HubWireMessageDraft = HubWireEnvelopeBase & { kind: "message" };

export type HubWireMessageEnvelope = HubWireMessageDraft & { serverSequence: number };

export type HubWireDeliveryReceipt = HubWireEnvelopeBase & {
	kind: "delivery_receipt";
	serverSequence: number;
	receiptFor: string;
	deliveredAt: number;
};

export type HubWireEnvelope = HubWireMessageEnvelope | HubWireDeliveryReceipt;

type HubEnvelopeBase = {
	msgId: string;
	project: string;
	from: string;
	to: string;
	text: string;
	createdAt: number;
	replyTo?: string;
	serverSequence: number;
};

export type HubMessageEnvelope = HubEnvelopeBase & { kind: "message" };

export type HubDeliveryReceipt = HubEnvelopeBase & {
	kind: "delivery_receipt";
	receiptFor: string;
	deliveredAt: number;
};

export type HubEnvelope = HubMessageEnvelope | HubDeliveryReceipt;

export type HubWireInboxBatch = {
	messages: HubWireEnvelope[];
	cursor: number;
};

export type HubInboxBatch = {
	messages: HubEnvelope[];
	cursor: number;
};

export type HubAcknowledgment = {
	messageId: string;
	serverSequence: number;
	status: "acknowledged" | "already_acknowledged";
};

export type HubAckBatch = {
	acknowledgments: HubAcknowledgment[];
	cursor: number;
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
	replyTo?: string;
	messageId?: string;
};

export type HubSendInput = {
	project: string;
	from: string;
	to: string;
	text: string;
	replyTo?: string;
	messageId?: string;
};
