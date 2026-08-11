import WebSocket from "ws";
import { encodeTextPayload } from "./payload";
import {
	A2A_PROTOCOL_VERSION,
	type AcceptedMessage,
	type ClientFrame,
	type DeliveryEvent,
	type MessageRequestTarget,
	type Peer,
	type RealtimeMessage,
	type ServerFrame,
} from "./realtime-types";
import type { EncodedAttachment } from "./types";

function deliveryFailureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (Buffer.byteLength(message, "utf8") <= 512)
		return message || "receiver failed to inject message";
	return Buffer.from(message, "utf8")
		.subarray(0, 512)
		.toString("utf8")
		.replace(/\uFFFD$/, "");
}

export type A2aConnectionEvents = {
	onPresenceJoined?: (peer: Peer) => void;
	onPresenceLeft?: (
		peer: Peer,
		reason: Extract<ServerFrame, { type: "presence_left" }>["reason"],
	) => void;
	onMessage?: (message: RealtimeMessage) => void | Promise<void>;
	onDelivery?: (delivery: DeliveryEvent) => void;
	onClose?: (event: { manual: boolean; code: number; reason: string }) => void;
	onError?: (error: Error) => void;
};

type PendingRequest = {
	resolve: (result: AcceptedMessage) => void;
	reject: (error: Error) => void;
};

export class A2aConnection {
	#socket: WebSocket;
	#project: string;
	#name: string;
	#self: Peer | null = null;
	#peers = new Map<string, Peer>();
	#pending = new Map<string, PendingRequest>();
	#events: A2aConnectionEvents;
	#ready: Promise<void>;
	#resolveReady!: () => void;
	#rejectReady!: (error: Error) => void;
	#closed: Promise<void>;
	#resolveClosed!: () => void;
	#manualClose = false;
	#messageQueue = Promise.resolve();

	#terminateHandshake(reason: unknown): void {
		this.#manualClose = true;
		const failure =
			reason instanceof Error
				? reason
				: new DOMException("A2A connection handshake aborted", "AbortError");
		this.#rejectReady(failure);
		if (
			this.#socket.readyState === WebSocket.CONNECTING ||
			this.#socket.readyState === WebSocket.OPEN
		)
			this.#socket.terminate();
	}

	private constructor(
		baseUrl: string,
		project: string,
		name: string,
		events: A2aConnectionEvents,
	) {
		this.#project = project;
		this.#name = name;
		this.#events = events;
		this.#ready = new Promise<void>((resolve, reject) => {
			this.#resolveReady = resolve;
			this.#rejectReady = reject;
		});
		this.#closed = new Promise<void>((resolve) => {
			this.#resolveClosed = resolve;
		});
		this.#socket = new WebSocket(
			`${baseUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/connect`,
		);
		this.#socket.on("open", () =>
			this.#send({
				type: "hello",
				protocolVersion: A2A_PROTOCOL_VERSION,
				project: this.#project,
				name: this.#name,
			}),
		);
		this.#socket.on("message", (data) =>
			this.#handleFrame(JSON.parse(data.toString()) as ServerFrame),
		);
		this.#socket.on("error", (error) => {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.#events.onError?.(failure);
			if (!this.#self) this.#rejectReady(failure);
		});
		this.#socket.on("close", (code, reason) => {
			const failure = new Error(
				`A2A connection closed (${code}): ${reason.toString() || "no reason"}`,
			);
			if (!this.#self) this.#rejectReady(failure);
			for (const pending of this.#pending.values()) pending.reject(failure);
			this.#pending.clear();
			this.#events.onClose?.({
				manual: this.#manualClose,
				code,
				reason: reason.toString(),
			});
			this.#resolveClosed();
		});
	}

	static async connect(options: {
		baseUrl: string;
		project: string;
		name: string;
		events?: A2aConnectionEvents;
		signal?: AbortSignal;
	}): Promise<A2aConnection> {
		if (options.signal?.aborted)
			throw options.signal.reason instanceof Error
				? options.signal.reason
				: new DOMException("A2A connection handshake aborted", "AbortError");
		const connection = new A2aConnection(
			options.baseUrl,
			options.project,
			options.name,
			options.events ?? {},
		);
		const abort = () => connection.#terminateHandshake(options.signal?.reason);
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			await connection.#ready;
			if (options.signal?.aborted) {
				abort();
				throw options.signal.reason instanceof Error
					? options.signal.reason
					: new DOMException("A2A connection handshake aborted", "AbortError");
			}
			return connection;
		} catch (error) {
			connection.#terminateHandshake(error);
			await connection.#closed;
			throw error;
		} finally {
			options.signal?.removeEventListener("abort", abort);
		}
	}

	get project(): string {
		return this.#project;
	}

	get name(): string {
		return this.#name;
	}

	get self(): Peer {
		if (!this.#self) throw new Error("A2A connection is not ready");
		return { ...this.#self };
	}

	peers(): Peer[] {
		return Array.from(this.#peers.values(), (peer) => ({ ...peer })).sort(
			(left, right) => left.name.localeCompare(right.name),
		);
	}

	send(options: {
		target: MessageRequestTarget;
		text: string;
		attachments?: EncodedAttachment[];
		replyTo?: string;
		messageId?: string;
	}): Promise<AcceptedMessage> {
		const requestId = crypto.randomUUID();
		const messageId = options.messageId ?? crypto.randomUUID();
		return new Promise<AcceptedMessage>((resolve, reject) => {
			this.#pending.set(requestId, { resolve, reject });
			try {
				this.#send({
					type: "message",
					requestId,
					messageId,
					target: options.target,
					payload: encodeTextPayload(options.text),
					attachments: options.attachments ?? [],
					replyTo: options.replyTo,
				});
			} catch (error) {
				this.#pending.delete(requestId);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): Promise<void> {
		this.#manualClose = true;
		if (this.#socket.readyState === WebSocket.CLOSED) return Promise.resolve();
		this.#socket.close(1000, "client disconnect");
		return this.#closed;
	}

	#handleFrame(frame: ServerFrame): void {
		switch (frame.type) {
			case "claimed":
				this.#self = frame.self;
				this.#peers = new Map(
					frame.peers.map((peer) => [peer.presenceId, peer]),
				);
				this.#resolveReady();
				return;
			case "presence_joined":
				this.#peers.set(frame.peer.presenceId, frame.peer);
				this.#events.onPresenceJoined?.({ ...frame.peer });
				return;
			case "presence_left":
				this.#peers.delete(frame.peer.presenceId);
				this.#events.onPresenceLeft?.({ ...frame.peer }, frame.reason);
				return;
			case "message":
				this.#messageQueue = this.#messageQueue.then(() =>
					this.#deliverMessage(frame.message),
				);
				return;
			case "delivery":
				this.#events.onDelivery?.(
					frame.status === "failed"
						? {
								messageId: frame.messageId,
								to: frame.to,
								status: frame.status,
								error: frame.error,
							}
						: {
								messageId: frame.messageId,
								to: frame.to,
								status: frame.status,
							},
				);
				return;
			case "accepted": {
				const pending = this.#pending.get(frame.requestId);
				if (!pending) return;
				this.#pending.delete(frame.requestId);
				pending.resolve({
					message: frame.message,
					recipients: frame.recipients,
				});
				return;
			}
			case "error": {
				const failure = new Error(`${frame.code}: ${frame.message}`);
				if (frame.requestId) {
					const pending = this.#pending.get(frame.requestId);
					if (pending) {
						this.#pending.delete(frame.requestId);
						pending.reject(failure);
						return;
					}
				}
				if (!this.#self) this.#rejectReady(failure);
				else this.#events.onError?.(failure);
				return;
			}
		}
	}

	async #deliverMessage(message: RealtimeMessage): Promise<void> {
		try {
			await this.#events.onMessage?.(message);
			this.#send({
				type: "delivered",
				messageId: message.messageId,
			});
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			try {
				this.#send({
					type: "delivery_failed",
					messageId: message.messageId,
					error: deliveryFailureMessage(failure),
				});
			} catch (sendError) {
				this.#events.onError?.(
					sendError instanceof Error ? sendError : new Error(String(sendError)),
				);
			}
			this.#events.onError?.(failure);
		}
	}

	#send(frame: ClientFrame): void {
		if (this.#socket.readyState !== WebSocket.OPEN)
			throw new Error("A2A WebSocket is not open");
		this.#socket.send(JSON.stringify(frame));
	}
}
