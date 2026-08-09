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

export const GOODBYE_TIMEOUT_MS = 1_000;
export const CLOSE_TIMEOUT_MS = 2_000;
export const MESSAGE_REQUEST_TIMEOUT_MS = 15_000;
export const HANDSHAKE_TIMEOUT_MS = 5_000;

export class MessageOutcomeUnknownError extends Error {}

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
	reject: (error: unknown) => void;
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
	#goodbyeSent = false;
	#goodbyeTimer: ReturnType<typeof setTimeout> | undefined;
	#closeTimer: ReturnType<typeof setTimeout> | undefined;

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
			clearTimeout(this.#goodbyeTimer);
			clearTimeout(this.#closeTimer);
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
		handshakeTimeoutMs?: number;
	}): Promise<A2aConnection> {
		if (options.signal?.aborted) {
			throw (
				options.signal.reason ?? new Error("A2A connection handshake aborted")
			);
		}
		const handshakeTimeoutMs =
			options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
		if (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
			throw new RangeError(
				"handshakeTimeoutMs must be a positive finite number",
			);
		}
		const connection = new A2aConnection(
			options.baseUrl,
			options.project,
			options.name,
			options.events ?? {},
		);
		const timeout = AbortSignal.timeout(Math.ceil(handshakeTimeoutMs));
		const signal = options.signal
			? AbortSignal.any([options.signal, timeout])
			: timeout;
		try {
			await new Promise<void>((resolve, reject) => {
				const onAbort = () =>
					reject(
						signal.reason ?? new Error("A2A connection handshake aborted"),
					);
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				connection.#ready.then(resolve, reject).finally(() => {
					signal.removeEventListener("abort", onAbort);
				});
			});
			return connection;
		} catch (error) {
			connection.#manualClose = true;
			if (connection.#socket.readyState !== WebSocket.CLOSED)
				connection.#socket.terminate();
			await connection.#closed;
			throw error;
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

	send(
		options: {
			target: MessageRequestTarget;
			text: string;
			attachments?: EncodedAttachment[];
			replyTo?: string;
			messageId?: string;
		},
		requestOptions: { signal?: AbortSignal } = {},
	): Promise<AcceptedMessage> {
		const signal = requestOptions.signal;
		if (signal?.aborted) {
			return Promise.reject(
				signal.reason ?? new Error("A2A message request aborted"),
			);
		}
		const requestId = crypto.randomUUID();
		const messageId = options.messageId ?? crypto.randomUUID();
		return new Promise<AcceptedMessage>((resolve, reject) => {
			let sent = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
			};
			const pending: PendingRequest = {
				resolve: (result) => {
					cleanup();
					resolve(result);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			};
			const rejectUnknownOutcome = (message: string, cause?: unknown) => {
				const current = this.#pending.get(requestId);
				if (current !== pending) return;
				this.#pending.delete(requestId);
				current.reject(new MessageOutcomeUnknownError(message, { cause }));
			};
			const onAbort = () => {
				if (!sent) {
					this.#pending.delete(requestId);
					pending.reject(
						signal?.reason ?? new Error("A2A message request aborted"),
					);
					return;
				}
				rejectUnknownOutcome(
					"A2A message request aborted after dispatch; acceptance and delivery outcome are unknown",
					signal?.reason,
				);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(requestId, pending);
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
				sent = true;
				timeout = setTimeout(
					() =>
						rejectUnknownOutcome(
							`A2A message request timed out after ${MESSAGE_REQUEST_TIMEOUT_MS}ms; acceptance and delivery outcome are unknown`,
						),
					MESSAGE_REQUEST_TIMEOUT_MS,
				);
			} catch (error) {
				this.#pending.delete(requestId);
				pending.reject(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		});
	}

	close(): Promise<void> {
		this.#manualClose = true;
		if (this.#socket.readyState === WebSocket.CLOSED) return Promise.resolve();
		if (
			this.#socket.readyState === WebSocket.OPEN &&
			this.#self &&
			!this.#goodbyeSent
		) {
			this.#goodbyeSent = true;
			this.#send({ type: "goodbye" });
			this.#goodbyeTimer = setTimeout(
				() => this.#beginSocketClose(),
				GOODBYE_TIMEOUT_MS,
			);
		} else if (!this.#goodbyeSent) {
			this.#beginSocketClose();
		}
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
			case "goodbye":
				this.#beginSocketClose();
				return;
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

	#beginSocketClose(): void {
		if (this.#goodbyeTimer) {
			clearTimeout(this.#goodbyeTimer);
			this.#goodbyeTimer = undefined;
		}
		if (this.#socket.readyState === WebSocket.OPEN) {
			this.#socket.close(1000, "client disconnect");
		} else if (this.#socket.readyState === WebSocket.CONNECTING) {
			this.#socket.terminate();
		}
		if (
			this.#socket.readyState !== WebSocket.CLOSED &&
			this.#closeTimer === undefined
		) {
			this.#closeTimer = setTimeout(() => {
				if (this.#socket.readyState !== WebSocket.CLOSED)
					this.#socket.terminate();
			}, CLOSE_TIMEOUT_MS);
		}
	}

	#send(frame: ClientFrame): void {
		if (this.#socket.readyState !== WebSocket.OPEN)
			throw new Error("A2A WebSocket is not open");
		this.#socket.send(JSON.stringify(frame));
	}
}
