import WebSocket from "ws";
import {
	decodeTextPayload,
	encodeTextPayload,
	parseEncodedAttachments,
} from "./payload";
import {
	A2A_PROTOCOL_VERSION,
	type AcceptedMessage,
	type ClientFrame,
	DELIVERY_OUTCOME_CACHE_TTL_MS,
	type DeliveryEvent,
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

export type DeliveryOutcomeScheduler = {
	now: () => number;
	schedule: (callback: () => void, delayMs: number) => () => void;
};

const DEFAULT_DELIVERY_OUTCOME_SCHEDULER: DeliveryOutcomeScheduler = {
	now: () => performance.now(),
	schedule(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		return () => clearTimeout(timer);
	},
};

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
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return (
		keys.length === expected.length &&
		keys.every((key) => expected.includes(key))
	);
}

function isPeer(value: unknown): value is Peer {
	return (
		isJsonObject(value) &&
		hasExactKeys(value, ["name", "presenceId"]) &&
		typeof value.name === "string" &&
		typeof value.presenceId === "string"
	);
}

function isMessageTarget(value: unknown): value is RealtimeMessage["target"] {
	if (!isJsonObject(value) || typeof value.type !== "string") return false;
	if (value.type === "project") return hasExactKeys(value, ["type"]);
	if (value.type !== "agent") return false;
	const expectedKeys =
		"presenceId" in value ? ["type", "name", "presenceId"] : ["type", "name"];
	return (
		hasExactKeys(value, expectedKeys) &&
		typeof value.name === "string" &&
		(!("presenceId" in value) || typeof value.presenceId === "string")
	);
}

function isEncodedTextPayload(
	value: unknown,
): value is RealtimeMessage["payload"] {
	return (
		isJsonObject(value) &&
		hasExactKeys(value, ["encoding", "data"]) &&
		(value.encoding === "identity" || value.encoding === "gzip+base64") &&
		typeof value.data === "string"
	);
}

function isEncodedAttachment(
	value: unknown,
): value is RealtimeMessage["attachments"][number] {
	if (
		!isJsonObject(value) ||
		!hasExactKeys(value, ["name", "payload"]) ||
		typeof value.name !== "string" ||
		!isJsonObject(value.payload)
	) {
		return false;
	}
	return (
		hasExactKeys(value.payload, ["encoding", "data"]) &&
		(value.payload.encoding === "base64" ||
			value.payload.encoding === "gzip+base64") &&
		typeof value.payload.data === "string"
	);
}

function isRealtimeMessage(value: unknown): value is RealtimeMessage {
	if (!isJsonObject(value)) return false;
	const expectedKeys =
		"replyTo" in value
			? [
					"messageId",
					"messageRef",
					"project",
					"sequence",
					"from",
					"target",
					"payload",
					"attachments",
					"createdAt",
					"replyTo",
				]
			: [
					"messageId",
					"messageRef",
					"project",
					"sequence",
					"from",
					"target",
					"payload",
					"attachments",
					"createdAt",
				];
	const structurallyValid =
		hasExactKeys(value, expectedKeys) &&
		typeof value.messageId === "string" &&
		typeof value.messageRef === "string" &&
		typeof value.project === "string" &&
		typeof value.sequence === "number" &&
		Number.isSafeInteger(value.sequence) &&
		value.sequence > 0 &&
		isPeer(value.from) &&
		isMessageTarget(value.target) &&
		isEncodedTextPayload(value.payload) &&
		Array.isArray(value.attachments) &&
		value.attachments.every(isEncodedAttachment) &&
		typeof value.createdAt === "number" &&
		Number.isFinite(value.createdAt) &&
		(!("replyTo" in value) || typeof value.replyTo === "string");
	if (!structurallyValid) return false;
	try {
		decodeTextPayload(value.payload as RealtimeMessage["payload"]);
		parseEncodedAttachments(value.attachments);
		return true;
	} catch {
		return false;
	}
}

function decodeAcceptedFrame(frame: unknown): AcceptedMessage {
	if (
		!isJsonObject(frame) ||
		frame.type !== "accepted" ||
		typeof frame.requestId !== "string" ||
		typeof frame.replayed !== "boolean" ||
		!isRealtimeMessage(frame.message)
	) {
		throw new Error("Invalid accepted frame from A2A Hub");
	}
	if (frame.replayed) {
		if (!hasExactKeys(frame, ["type", "requestId", "replayed", "message"]))
			throw new Error("Invalid accepted replay frame from A2A Hub");
		return { replayed: true, message: frame.message };
	}
	if (
		!hasExactKeys(frame, [
			"type",
			"requestId",
			"replayed",
			"message",
			"recipients",
		]) ||
		!Array.isArray(frame.recipients) ||
		!frame.recipients.every((recipient) => typeof recipient === "string")
	) {
		throw new Error("Invalid new accepted frame from A2A Hub");
	}
	return {
		replayed: false,
		message: frame.message,
		recipients: frame.recipients,
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
	#deliveryInflight = new Map<string, Promise<DeliveryOutcomeFrame>>();
	#deliveryOutcomes = new Map<
		string,
		{ frame: DeliveryOutcomeFrame; expiresAt: number }
	>();
	#cancelDeliveryOutcomeExpiry: (() => void) | null = null;
	#deliveryOutcomeScheduler: DeliveryOutcomeScheduler;
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
		deliveryOutcomeScheduler: DeliveryOutcomeScheduler,
	) {
		this.#project = project;
		this.#name = name;
		this.#events = events;
		this.#goodbyeTimeoutMs = goodbyeTimeoutMs;
		this.#closeTimeoutMs = closeTimeoutMs;
		this.#deliveryOutcomeScheduler = deliveryOutcomeScheduler;
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
		deliveryOutcomeScheduler?: DeliveryOutcomeScheduler;
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
			options.deliveryOutcomeScheduler ?? DEFAULT_DELIVERY_OUTCOME_SCHEDULER,
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
		this.#deliveryInflight.clear();
		this.#clearDeliveryOutcomes();
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
				this.#receiveMessage(frame.message);
				return;
			case "delivery":
				this.#events.onDelivery?.(
					frame.status === "failed" || frame.status === "unknown"
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
		const cached = this.#deliveryOutcomes.get(message.messageId);
		if (cached) {
			if (cached.expiresAt > this.#deliveryOutcomeScheduler.now()) {
				this.#sendDeliveryOutcome(cached.frame);
				return;
			}
			this.#deliveryOutcomes.delete(message.messageId);
			this.#rescheduleDeliveryOutcomeExpiry();
		}
		const inflight = this.#deliveryInflight.get(message.messageId);
		if (inflight) {
			void inflight.then((outcome) => this.#sendDeliveryOutcome(outcome));
			return;
		}

		const outcome = this.#messageQueue.then(() =>
			this.#deliveryOutcome(message),
		);
		this.#messageQueue = outcome.then(() => undefined);
		this.#deliveryInflight.set(message.messageId, outcome);
		void outcome.then((frame) => {
			if (
				this.#closeFinalized ||
				this.#deliveryInflight.get(message.messageId) !== outcome
			) {
				return;
			}
			this.#deliveryInflight.delete(message.messageId);
			const now = this.#deliveryOutcomeScheduler.now();
			this.#deliveryOutcomes.set(message.messageId, {
				frame,
				expiresAt: now + DELIVERY_OUTCOME_CACHE_TTL_MS,
			});
			this.#scheduleDeliveryOutcomeExpiry();
			this.#sendDeliveryOutcome(frame);
		});
	}

	#scheduleDeliveryOutcomeExpiry(): void {
		if (
			this.#closeFinalized ||
			this.#cancelDeliveryOutcomeExpiry ||
			this.#deliveryOutcomes.size === 0
		) {
			return;
		}
		const earliest = this.#deliveryOutcomes.values().next().value;
		if (!earliest) return;
		const delayMs = Math.max(
			0,
			earliest.expiresAt - this.#deliveryOutcomeScheduler.now(),
		);
		this.#cancelDeliveryOutcomeExpiry = this.#deliveryOutcomeScheduler.schedule(
			() => {
				this.#cancelDeliveryOutcomeExpiry = null;
				const now = this.#deliveryOutcomeScheduler.now();
				for (const [messageId, retained] of this.#deliveryOutcomes) {
					if (retained.expiresAt > now) break;
					this.#deliveryOutcomes.delete(messageId);
				}
				this.#scheduleDeliveryOutcomeExpiry();
			},
			delayMs,
		);
	}

	#rescheduleDeliveryOutcomeExpiry(): void {
		this.#cancelDeliveryOutcomeExpiry?.();
		this.#cancelDeliveryOutcomeExpiry = null;
		this.#scheduleDeliveryOutcomeExpiry();
	}

	#clearDeliveryOutcomes(): void {
		this.#cancelDeliveryOutcomeExpiry?.();
		this.#cancelDeliveryOutcomeExpiry = null;
		this.#deliveryOutcomes.clear();
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
