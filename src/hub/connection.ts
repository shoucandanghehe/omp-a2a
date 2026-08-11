import WebSocket from "ws";
import { encodeTextPayload } from "./payload";
import {
	A2A_PROTOCOL_VERSION,
	type AcceptedMessage,
	isExactGoodbyeFrame,
	type ClientFrame,
	type DeliveryEvent,
	type MessageRequestTarget,
	type Peer,
	type RealtimeMessage,
	type ServerFrame,
} from "./realtime-types";
import type { EncodedAttachment } from "./types";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const MESSAGE_TIMEOUT_MS = 15_000;
const GOODBYE_TIMEOUT_MS = 1_000;
const CLOSE_TIMEOUT_MS = 2_000;

function boundedTimeout(
	value: number | undefined,
	maximumMs: number,
	name: string,
): number {
	if (value === undefined) return maximumMs;
	if (!Number.isFinite(value) || value <= 0)
		throw new Error(`${name} must be a finite positive number`);
	if (value > maximumMs)
		throw new Error(`${name} must not exceed ${maximumMs}ms`);
	return value;
}

function deliveryFailureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (Buffer.byteLength(message, "utf8") <= 512)
		return message || "receiver failed to inject message";
	return Buffer.from(message, "utf8")
		.subarray(0, 512)
		.toString("utf8")
		.replace(/\uFFFD$/, "");
}

function unknownMessageOutcome(reason: string): Error {
	return new Error(
		`A2A message acceptance and Delivery outcomes are unknown because ${reason}`,
	);
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
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
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
	#rejectReady!: (reason?: unknown) => void;
	#closed: Promise<void>;
	#resolveClosed!: () => void;
	#closePromise: Promise<void> | null = null;
	#resolveGoodbyeWait: (() => void) | null = null;
	#goodbyeTimeoutMs: number;
	#closeTimeoutMs: number;
	#manualClose = false;
	#messageQueue = Promise.resolve();
	#handshakeAborted = false;
	#handshakeAbortReason: unknown;

	private constructor(
		baseUrl: string,
		project: string,
		name: string,
		events: A2aConnectionEvents,
		goodbyeTimeoutMs: number,
		closeTimeoutMs: number,
	) {
		this.#project = project;
		this.#name = name;
		this.#events = events;
		this.#goodbyeTimeoutMs = goodbyeTimeoutMs;
		this.#closeTimeoutMs = closeTimeoutMs;
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
			const failure = unknownMessageOutcome(
				`the WebSocket closed (${code}: ${reason.toString() || "no reason"}) before the Hub replied`,
			);
			if (!this.#self)
				this.#rejectReady(
					this.#handshakeAborted
						? this.#handshakeAbortReason
						: new Error(
								`A2A connection closed (${code}): ${reason.toString() || "no reason"}`,
							),
				);
			for (const requestId of this.#pending.keys())
				this.#rejectPending(requestId, failure);
			this.#resolveGoodbyeWait?.();
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
		timeoutMs?: number;
		goodbyeTimeoutMs?: number;
		closeTimeoutMs?: number;
	}): Promise<A2aConnection> {
		if (options.signal?.aborted) throw options.signal.reason;
		const handshakeTimeoutMs = boundedTimeout(
			options.timeoutMs,
			HANDSHAKE_TIMEOUT_MS,
			"timeoutMs",
		);
		const goodbyeTimeoutMs = boundedTimeout(
			options.goodbyeTimeoutMs,
			GOODBYE_TIMEOUT_MS,
			"goodbyeTimeoutMs",
		);
		const closeTimeoutMs = boundedTimeout(
			options.closeTimeoutMs,
			CLOSE_TIMEOUT_MS,
			"closeTimeoutMs",
		);
		const connection = new A2aConnection(
			options.baseUrl,
			options.project,
			options.name,
			options.events ?? {},
			goodbyeTimeoutMs,
			closeTimeoutMs,
		);
		const timeoutMs = handshakeTimeoutMs;
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const failed = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`A2A handshake timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
			if (options.signal) {
				onAbort = () => {
					connection.#handshakeAborted = true;
					connection.#handshakeAbortReason = options.signal?.reason;
					reject(connection.#handshakeAbortReason);
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		});
		try {
			await Promise.race([connection.#ready, failed]);
			if (options.signal?.aborted) throw options.signal.reason;
			return connection;
		} catch (error) {
			connection.#manualClose = true;
			if (connection.#socket.readyState !== WebSocket.CLOSED)
				connection.#socket.terminate();
			await connection.#closed;
			if (options.signal?.aborted) throw options.signal.reason;
			throw error;
		} finally {
			clearTimeout(timer);
			if (options.signal && onAbort)
				options.signal.removeEventListener("abort", onAbort);
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
		request: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<AcceptedMessage> {
		if (this.#closePromise)
			return Promise.reject(new Error("A2A connection is closing"));
		if (request.signal?.aborted)
			return Promise.reject(
				new Error("A2A message request aborted before dispatch"),
			);
		return new Promise<AcceptedMessage>((resolve, reject) => {
			const timeoutMs = boundedTimeout(
				request.timeoutMs,
				MESSAGE_TIMEOUT_MS,
				"timeoutMs",
			);
			const requestId = crypto.randomUUID();
			const messageId = options.messageId ?? crypto.randomUUID();
			const frame: ClientFrame = {
				type: "message",
				requestId,
				messageId,
				target: options.target,
				payload: encodeTextPayload(options.text),
				attachments: options.attachments ?? [],
				replyTo: options.replyTo,
			};
			const timer = setTimeout(() => {
				this.#rejectPending(
					requestId,
					unknownMessageOutcome(
						`the Hub did not reply within ${timeoutMs}ms after dispatch`,
					),
				);
			}, timeoutMs);
			const pending: PendingRequest = {
				resolve,
				reject,
				timer,
				signal: request.signal,
			};
			if (request.signal) {
				pending.onAbort = () =>
					this.#rejectPending(
						requestId,
						unknownMessageOutcome("the caller aborted after dispatch"),
					);
				request.signal.addEventListener("abort", pending.onAbort, {
					once: true,
				});
			}
			this.#pending.set(requestId, pending);
			try {
				this.#send(frame);
			} catch (error) {
				this.#rejectPending(
					requestId,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		});
	}

	close(): Promise<void> {
		this.#manualClose = true;
		this.#closePromise ??= this.#performClose();
		return this.#closePromise;
	}

	async #performClose(): Promise<void> {
		if (this.#socket.readyState === WebSocket.CLOSED) return await this.#closed;
		if (!this.#self || this.#socket.readyState !== WebSocket.OPEN) {
			if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate();
			return await this.#closed;
		}

		try {
			this.#send({ type: "goodbye" });
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					this.#resolveGoodbyeWait = null;
					resolve();
				};
				const timer = setTimeout(finish, this.#goodbyeTimeoutMs);
				this.#resolveGoodbyeWait = finish;
			});
		} catch {
			this.#resolveGoodbyeWait = null;
		}

		if (this.#socket.readyState === WebSocket.OPEN)
			this.#socket.close(1000, "client disconnect");
		if (this.#socket.readyState !== WebSocket.CLOSED) {
			let terminateTimer: NodeJS.Timeout | undefined;
			await Promise.race([
				this.#closed,
				new Promise<void>((resolve) => {
					terminateTimer = setTimeout(() => {
						if (this.#socket.readyState !== WebSocket.CLOSED)
							this.#socket.terminate();
						resolve();
					}, this.#closeTimeoutMs);
				}),
			]);
			clearTimeout(terminateTimer);
		}
		return await this.#closed;
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
			case "goodbye":
				if (!isExactGoodbyeFrame(frame)) {
					this.#events.onError?.(
						new Error("A2A goodbye frame must contain only type"),
					);
					return;
				}
				this.#resolveGoodbyeWait?.();
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
				const pending = this.#takePending(frame.requestId);
				if (!pending) return;
				pending.resolve({
					message: frame.message,
					recipients: frame.recipients,
				});
				return;
			}
			case "error": {
				const failure = new Error(`${frame.code}: ${frame.message}`);
				if (frame.requestId) {
					this.#takePending(frame.requestId)?.reject(failure);
					return;
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

	#takePending(requestId: string): PendingRequest | undefined {
		const pending = this.#pending.get(requestId);
		if (!pending) return undefined;
		this.#pending.delete(requestId);
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort)
			pending.signal.removeEventListener("abort", pending.onAbort);
		return pending;
	}

	#rejectPending(requestId: string, error: Error): void {
		this.#takePending(requestId)?.reject(error);
	}

	#send(frame: ClientFrame): void {
		if (this.#socket.readyState !== WebSocket.OPEN)
			throw new Error("A2A WebSocket is not open");
		this.#socket.send(JSON.stringify(frame));
	}
}
