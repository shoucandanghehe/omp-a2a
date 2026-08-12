import WebSocket from "ws";
import { encodeTextPayload } from "./payload";
import {
	A2A_PROTOCOL_VERSION,
	type AcceptedMessage,
	type ClientFrame,
	type DeliveryEvent,
	decodeRealtimeMessage,
	isExactGoodbyeFrame,
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
	return message || "receiver failed to inject message";
}

function unknownMessageOutcome(reason: string): Error {
	return new Error(
		`A2A message acceptance and Delivery outcomes are unknown because ${reason}`,
	);
}
function decodeAcceptedFrame(frame: unknown): AcceptedMessage {
	if (!frame || typeof frame !== "object" || Array.isArray(frame))
		throw new Error("Invalid accepted frame from A2A Hub");
	const candidate = frame as Record<string, unknown>;
	if (
		candidate.type !== "accepted" ||
		typeof candidate.requestId !== "string" ||
		typeof candidate.replayed !== "boolean"
	) {
		throw new Error("Invalid accepted frame from A2A Hub");
	}
	let message: RealtimeMessage;
	try {
		message = decodeRealtimeMessage(candidate.message);
	} catch (error) {
		throw new Error(
			`Invalid accepted frame from A2A Hub: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (candidate.replayed) {
		if (
			Object.keys(candidate).length !== 4 ||
			!Object.hasOwn(candidate, "message")
		) {
			throw new Error("Invalid accepted replay frame from A2A Hub");
		}
		return { replayed: true, message };
	}
	if (
		Object.keys(candidate).length !== 5 ||
		!Array.isArray(candidate.recipients) ||
		!candidate.recipients.every((recipient) => typeof recipient === "string")
	) {
		throw new Error("Invalid new accepted frame from A2A Hub");
	}
	return {
		replayed: false,
		message,
		recipients: candidate.recipients,
	};
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

type DeliveryOutcomeFrame = Extract<
	ClientFrame,
	{ type: "delivered" | "delivery_failed" }
>;

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
	#closeFinalized = false;

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
			{ maxPayload: 0 },
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
		this.#socket.on("close", (code, reason) =>
			this.#finalizeClose(code, reason.toString()),
		);
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
		if (options.signal?.aborted)
			throw options.signal.reason instanceof Error
				? options.signal.reason
				: new DOMException("A2A connection handshake aborted", "AbortError");
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
		const abort = () => connection.#terminateHandshake(options.signal?.reason);
		options.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(
			() =>
				connection.#terminateHandshake(
					new Error(`A2A handshake timed out after ${timeoutMs}ms`),
				),
			timeoutMs,
		);
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
			clearTimeout(timer);
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
		if (this.#socket.readyState === WebSocket.CLOSED)
			return await this.#waitForClose();
		if (!this.#self || this.#socket.readyState !== WebSocket.OPEN) {
			this.#socket.terminate();
			return await this.#waitForClose();
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
		return await this.#waitForClose();
	}

	async #waitForClose(): Promise<void> {
		if (this.#closeFinalized) return await this.#closed;
		let closeTimer: NodeJS.Timeout | undefined;
		await Promise.race([
			this.#closed,
			new Promise<void>((resolve) => {
				closeTimer = setTimeout(() => {
					const reason = `WebSocket close timed out after ${this.#closeTimeoutMs}ms`;
					try {
						this.#finalizeClose(1006, reason);
					} finally {
						if (this.#socket.readyState !== WebSocket.CLOSED)
							this.#socket.terminate();
						resolve();
					}
				}, this.#closeTimeoutMs);
			}),
		]);
		clearTimeout(closeTimer);
		return await this.#closed;
	}

	#finalizeClose(code: number, reason: string): void {
		if (this.#closeFinalized) return;
		this.#closeFinalized = true;
		const failure = unknownMessageOutcome(
			`the WebSocket closed (${code}: ${reason || "no reason"}) before the Hub replied`,
		);
		if (!this.#self)
			this.#rejectReady(
				new Error(`A2A connection closed (${code}): ${reason || "no reason"}`),
			);
		for (const requestId of this.#pending.keys())
			this.#rejectPending(requestId, failure);
		this.#resolveGoodbyeWait?.();
		try {
			this.#events.onClose?.({
				manual: this.#manualClose,
				code,
				reason,
			});
		} finally {
			this.#resolveClosed();
		}
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
				this.#receiveMessage(decodeRealtimeMessage(frame.message));
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
				try {
					pending.resolve(decodeAcceptedFrame(frame));
				} catch (error) {
					pending.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
				}
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

	#receiveMessage(message: RealtimeMessage): void {
		this.#messageQueue = this.#messageQueue.then(async () => {
			const frame = await this.#deliveryOutcome(message);
			this.#sendDeliveryOutcome(frame);
		});
	}

	async #deliveryOutcome(
		message: RealtimeMessage,
	): Promise<DeliveryOutcomeFrame> {
		if (this.#closeFinalized) {
			return {
				type: "delivery_failed",
				messageId: message.messageId,
				error: "receiver connection closed before message injection",
			};
		}
		try {
			await this.#events.onMessage?.(message);
			return {
				type: "delivered",
				messageId: message.messageId,
			};
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.#events.onError?.(failure);
			return {
				type: "delivery_failed",
				messageId: message.messageId,
				error: deliveryFailureMessage(failure),
			};
		}
	}

	#sendDeliveryOutcome(frame: DeliveryOutcomeFrame): void {
		if (this.#closeFinalized) return;
		try {
			this.#send(frame);
		} catch (error) {
			this.#events.onError?.(
				error instanceof Error ? error : new Error(String(error)),
			);
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
