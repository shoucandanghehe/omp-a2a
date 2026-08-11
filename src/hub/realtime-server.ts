import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { getProject } from "../registry";
import {
	MessageIdConflictError,
	type MessageAppendResult,
	type MessageDraft,
	type MessageStore,
	UnknownReplyTargetError,
} from "./messages";
import { PayloadTooLargeError } from "./payload";
import { NameInUseError, type Presence, PresenceRegistry } from "./presence";
import {
	A2A_PROTOCOL_VERSION,
	type ClientFrame,
	DELIVERY_ACKNOWLEDGE_TIMEOUT_MS,
	DELIVERY_MAX_ATTEMPTS,
	DELIVERY_OUTCOME_CACHE_TTL_MS,
	DELIVERY_RETRY_DELAY_MS,
	isExactGoodbyeFrame,
	type ServerFrame,
} from "./realtime-types";

const MAX_FRAME_BYTES = 6 * 1024 * 1024;
const HEARTBEAT_MS = 10_000;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_DELIVERY_ERROR_BYTES = 512;
const GOODBYE_CLOSE_TIMEOUT_MS = 2_000;

type DeliveryScheduler = (
	callback: () => void,
	delayMs: number,
) => () => void;

type DeliveryRetryPolicy = {
	maxAttempts: number;
	acknowledgeTimeoutMs: number;
	retryDelayMs: number;
	schedule: DeliveryScheduler;
};

const DEFAULT_DELIVERY_RETRY_POLICY: DeliveryRetryPolicy = {
	maxAttempts: DELIVERY_MAX_ATTEMPTS,
	acknowledgeTimeoutMs: DELIVERY_ACKNOWLEDGE_TIMEOUT_MS,
	retryDelayMs: DELIVERY_RETRY_DELAY_MS,
	schedule(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		return () => clearTimeout(timer);
	},
};

export type RealtimeHubOptions = {
	deliveryRetryPolicy?: {
		maxAttempts?: number;
		acknowledgeTimeoutMs?: number;
		schedule?: DeliveryScheduler;
	};
};

function deliveryRetryPolicy(
	overrides: RealtimeHubOptions["deliveryRetryPolicy"] = {},
): DeliveryRetryPolicy {
	const maxAttempts = overrides.maxAttempts ?? DELIVERY_MAX_ATTEMPTS;
	if (
		!Number.isFinite(maxAttempts) ||
		!Number.isInteger(maxAttempts) ||
		maxAttempts <= 0
	) {
		throw new Error(
			"deliveryRetryPolicy.maxAttempts must be a finite positive integer",
		);
	}
	if (maxAttempts > DELIVERY_MAX_ATTEMPTS) {
		throw new Error(
			`deliveryRetryPolicy.maxAttempts must not exceed ${DELIVERY_MAX_ATTEMPTS}`,
		);
	}

	const acknowledgeTimeoutMs =
		overrides.acknowledgeTimeoutMs ?? DELIVERY_ACKNOWLEDGE_TIMEOUT_MS;
	if (!Number.isFinite(acknowledgeTimeoutMs) || acknowledgeTimeoutMs <= 0) {
		throw new Error(
			"deliveryRetryPolicy.acknowledgeTimeoutMs must be a finite positive number",
		);
	}
	const maximumAcknowledgeTimeoutMs = Math.min(
		DELIVERY_ACKNOWLEDGE_TIMEOUT_MS,
		(DELIVERY_OUTCOME_CACHE_TTL_MS -
			(maxAttempts - 1) * DELIVERY_RETRY_DELAY_MS) /
			maxAttempts,
	);
	if (acknowledgeTimeoutMs > maximumAcknowledgeTimeoutMs) {
		throw new Error(
			`deliveryRetryPolicy.acknowledgeTimeoutMs must not exceed ${maximumAcknowledgeTimeoutMs}ms`,
		);
	}
	if (
		overrides.schedule !== undefined &&
		typeof overrides.schedule !== "function"
	) {
		throw new Error("deliveryRetryPolicy.schedule must be a function");
	}

	return {
		...DEFAULT_DELIVERY_RETRY_POLICY,
		maxAttempts,
		acknowledgeTimeoutMs,
		schedule: overrides.schedule ?? DEFAULT_DELIVERY_RETRY_POLICY.schedule,
	};
}

class RecipientNotPresentError extends Error {}

type MessageLedger = Pick<MessageStore, "append" | "replay">;

type PendingDelivery = {
	key: string;
	messageId: string;
	senderPresenceId: string;
	senderSocket: WebSocket;
	recipientPresenceId: string;
	recipientName: string;
	recipientSocket: WebSocket;
	payload: string;
	attempts: number;
	cancelTimer?: () => void;
	terminal: boolean;
};

export class RealtimeHub {
	#server: Server;
	#wss: WebSocketServer;
	#messages: MessageLedger;
	#dataDir: string;
	#presences = new PresenceRegistry();
	#alive = new Map<WebSocket, boolean>();
	#closeReasons = new Map<
		WebSocket,
		"connection_closed" | "heartbeat_timeout" | "hub_shutdown"
	>();
	#pendingDeliveries = new Map<string, PendingDelivery>();
	#deliveryRetryPolicy: DeliveryRetryPolicy;
	#departed = new WeakSet<WebSocket>();
	#heartbeat: NodeJS.Timeout;
	#upgradeHandler: (
		request: IncomingMessage,
		socket: Socket,
		head: Buffer,
	) => void;
	#closing = false;

	constructor(
		server: Server,
		messages: MessageLedger,
		dataDir: string,
		options: RealtimeHubOptions = {},
	) {
		this.#server = server;
		this.#messages = messages;
		this.#dataDir = dataDir;
		this.#deliveryRetryPolicy = deliveryRetryPolicy(
			options.deliveryRetryPolicy,
		);
		this.#wss = new WebSocketServer({
			noServer: true,
			maxPayload: MAX_FRAME_BYTES,
		});
		this.#upgradeHandler = (request, socket, head) => {
			const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
			if (pathname !== "/v1/connect") {
				socket.destroy();
				return;
			}
			this.#wss.handleUpgrade(request, socket, head, (websocket) =>
				this.#wss.emit("connection", websocket, request),
			);
		};
		this.#server.on("upgrade", this.#upgradeHandler);
		this.#wss.on("connection", (socket) => this.#accept(socket));
		this.#heartbeat = setInterval(
			() => this.#heartbeatConnections(),
			HEARTBEAT_MS,
		);
	}

	count(project: string): number {
		return this.#presences.count(project);
	}

	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		clearInterval(this.#heartbeat);
		this.#server.off("upgrade", this.#upgradeHandler);
		for (const presence of this.#presences.close()) {
			this.#closeReasons.set(presence.socket, "hub_shutdown");
		}
		for (const pending of this.#pendingDeliveries.values())
			this.#finishDelivery(pending);
		for (const socket of this.#wss.clients) socket.terminate();
		this.#wss.close();
	}

	#accept(socket: WebSocket): void {
		this.#alive.set(socket, true);
		socket.on("pong", () => this.#alive.set(socket, true));
		const helloTimeout = setTimeout(() => {
			if (!this.#presences.getBySocket(socket))
				socket.close(1008, "hello timeout");
		}, HELLO_TIMEOUT_MS);
		socket.on("message", (data, isBinary) => {
			if (isBinary) {
				this.#send(socket, {
					type: "error",
					code: "invalid_frame",
					message: "binary frames are not supported",
				});
				return;
			}
			try {
				const frame = JSON.parse(data.toString()) as unknown;
				this.#handleFrame(socket, frame);
			} catch (error) {
				this.#send(socket, {
					type: "error",
					code: "invalid_frame",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		});
		socket.once("close", () => {
			clearTimeout(helloTimeout);
			this.#alive.delete(socket);
			const reason = this.#closeReasons.get(socket) ?? "connection_closed";
			this.#closeReasons.delete(socket);
			this.#release(socket, reason);
		});
	}

	#handleFrame(socket: WebSocket, value: unknown): void {
		if (
			!value ||
			typeof value !== "object" ||
			!("type" in value) ||
			typeof value.type !== "string"
		) {
			throw new Error("frame type is required");
		}
		if (this.#departed.has(socket))
			throw new Error("connection has already left its Presence");
		const claimed = this.#presences.getBySocket(socket);
		if (!claimed) {
			if (value.type !== "hello")
				throw new Error("hello must be the first frame");
			this.#claim(
				socket,
				value as Partial<Extract<ClientFrame, { type: "hello" }>>,
			);
			return;
		}
		if (value.type === "goodbye") {
			if (!isExactGoodbyeFrame(value))
				throw new Error("goodbye frame must contain only type");
			this.#departed.add(socket);
			this.#release(socket, "connection_closed");
			this.#send(socket, { type: "goodbye" });
			this.#closeAfterGoodbye(socket);
			return;
		}
		if (value.type === "message") {
			this.#handleMessage(
				claimed,
				value as Partial<Extract<ClientFrame, { type: "message" }>>,
			);
			return;
		}
		if (value.type === "delivered") {
			const frame = value as Partial<
				Extract<ClientFrame, { type: "delivered" }>
			>;
			this.#handleDeliveryResult(claimed, frame.messageId, "delivered");
			return;
		}
		if (value.type === "delivery_failed") {
			const frame = value as Partial<
				Extract<ClientFrame, { type: "delivery_failed" }>
			>;
			if (
				typeof frame.error !== "string" ||
				frame.error.length === 0 ||
				Buffer.byteLength(frame.error, "utf8") > MAX_DELIVERY_ERROR_BYTES
			) {
				throw new Error("delivery failure error is invalid");
			}
			this.#handleDeliveryResult(
				claimed,
				frame.messageId,
				"failed",
				frame.error,
			);
			return;
		}
		throw new Error(`unsupported frame type: ${value.type}`);
	}

	#claim(
		socket: WebSocket,
		frame: Partial<Extract<ClientFrame, { type: "hello" }>>,
	): void {
		try {
			if (frame.protocolVersion !== A2A_PROTOCOL_VERSION) {
				throw new Error(`Hub requires protocol ${A2A_PROTOCOL_VERSION}`);
			}
			if (typeof frame.project !== "string" || typeof frame.name !== "string") {
				throw new Error("project and name are required");
			}
			if (!getProject(frame.project, this.#dataDir))
				throw new Error(`unknown project: ${frame.project}`);
			const { self, peers } = this.#presences.claim(
				frame.project,
				frame.name,
				socket,
			);
			this.#send(socket, {
				type: "claimed",
				protocolVersion: A2A_PROTOCOL_VERSION,
				project: self.project,
				self: { name: self.name, presenceId: self.presenceId },
				peers,
			});
			this.#broadcast(self.project, self.presenceId, {
				type: "presence_joined",
				peer: { name: self.name, presenceId: self.presenceId },
			});
		} catch (error) {
			const code =
				frame.protocolVersion !== A2A_PROTOCOL_VERSION
					? "protocol_mismatch"
					: error instanceof NameInUseError
						? "name_in_use"
						: "claim_rejected";
			this.#send(socket, {
				type: "error",
				code,
				message: error instanceof Error ? error.message : String(error),
			});
			socket.close(1008, code);
		}
	}

	#handleMessage(
		presence: Presence,
		frame: Partial<Extract<ClientFrame, { type: "message" }>>,
	): void {
		const requestId =
			typeof frame.requestId === "string" ? frame.requestId : undefined;
		try {
			if (
				!requestId ||
				typeof frame.messageId !== "string" ||
				!frame.target ||
				!frame.payload ||
				!frame.attachments
			) {
				throw new Error(
					"requestId, messageId, target, payload and attachments are required",
				);
			}
			if (frame.target.type !== "agent" && frame.target.type !== "project")
				throw new Error("invalid message target");
			if (frame.replyTo !== undefined && typeof frame.replyTo !== "string")
				throw new Error("invalid replyTo");
			if (
				frame.target.type === "agent" &&
				typeof frame.target.name !== "string"
			) {
				throw new Error("recipient name is required");
			}

			const draft: MessageDraft = {
				messageId: frame.messageId,
				project: presence.project,
				from: { name: presence.name, presenceId: presence.presenceId },
				target:
					frame.target.type === "agent"
						? { type: "agent", name: frame.target.name }
						: { type: "project" },
				payload: frame.payload,
				attachments: frame.attachments,
				createdAt: Date.now(),
				replyTo: frame.replyTo,
			};
			let recipients: Presence[];
			let appended: MessageAppendResult;
			if (draft.target.type === "agent") {
				const replayed = this.#messages.replay(draft);
				if (replayed) {
					this.#send(presence.socket, {
						type: "accepted",
						requestId,
						replayed: true,
						message: replayed.message,
					});
					return;
				}
				const recipient = this.#presences.get(
					presence.project,
					draft.target.name,
				);
				if (!recipient) {
					throw new RecipientNotPresentError(
						`recipient is not present: ${draft.target.name}`,
					);
				}
				if (recipient.presenceId === presence.presenceId)
					throw new Error("cannot send to yourself");
				appended = this.#messages.append({
					...draft,
					target: {
						type: "agent",
						name: recipient.name,
						presenceId: recipient.presenceId,
					},
				});
				recipients = [recipient];
			} else {
				appended = this.#messages.append(draft);
				if (appended.replayed) {
					this.#send(presence.socket, {
						type: "accepted",
						requestId,
						replayed: true,
						message: appended.message,
					});
					return;
				}
				recipients = this.#presences
					.connections(presence.project)
					.filter(
						(recipient) =>
							recipient.presenceId !== presence.presenceId,
					);
			}

			if (appended.replayed) {
				this.#send(presence.socket, {
					type: "accepted",
					requestId,
					replayed: true,
					message: appended.message,
				});
				return;
			}
			const payload = JSON.stringify({
				type: "message",
				message: appended.message,
			} satisfies ServerFrame);
			for (const recipient of recipients) {
				const key = `${appended.message.messageId}:${recipient.presenceId}`;
				const pending: PendingDelivery = {
					key,
					messageId: appended.message.messageId,
					senderPresenceId: presence.presenceId,
					senderSocket: presence.socket,
					recipientPresenceId: recipient.presenceId,
					recipientName: recipient.name,
					recipientSocket: recipient.socket,
					payload,
					attempts: 0,
					terminal: false,
				};
				this.#pendingDeliveries.set(key, pending);
				this.#attemptDelivery(pending);
			}
			this.#send(presence.socket, {
				type: "accepted",
				requestId,
				replayed: false,
				message: appended.message,
				recipients: recipients.map((recipient) => recipient.name),
			});
		} catch (error) {
			const code =
				error instanceof RecipientNotPresentError
					? "recipient_not_present"
					: error instanceof MessageIdConflictError
						? "message_id_conflict"
						: error instanceof UnknownReplyTargetError
							? "unknown_reply"
							: error instanceof PayloadTooLargeError
								? "payload_too_large"
								: "message_rejected";
			this.#send(presence.socket, {
				type: "error",
				requestId,
				code,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#handleDeliveryResult(
		presence: Presence,
		messageId: unknown,
		status: "delivered" | "failed",
		error?: string,
	): void {
		if (typeof messageId !== "string") throw new Error("messageId is required");
		const pending = this.#pendingDeliveries.get(
			`${messageId}:${presence.presenceId}`,
		);
		if (!pending || pending.recipientSocket !== presence.socket) return;
		this.#finishDelivery(
			pending,
			status === "failed"
				? {
						status,
						error: error ?? "receiver failed to inject message",
					}
				: { status },
		);
	}

	#attemptDelivery(pending: PendingDelivery): void {
		if (
			pending.terminal ||
			this.#pendingDeliveries.get(pending.key) !== pending
		) {
			return;
		}
		if (!this.#recipientIsCurrent(pending)) {
			this.#finishDelivery(pending, { status: "disconnected" });
			return;
		}
		if (pending.attempts >= this.#deliveryRetryPolicy.maxAttempts) {
			this.#finishDelivery(pending, {
				status: "unknown",
				error: `recipient did not acknowledge delivery after ${pending.attempts} attempts`,
			});
			return;
		}

		pending.attempts += 1;
		const attempt = pending.attempts;
		this.#scheduleDelivery(
			pending,
			this.#deliveryRetryPolicy.acknowledgeTimeoutMs,
			() => this.#handleAcknowledgementTimeout(pending, attempt),
		);
		try {
			pending.recipientSocket.send(pending.payload, (error) => {
				if (error) this.#handleTransportWriteError(pending, attempt, error);
			});
		} catch (error) {
			this.#handleTransportWriteError(
				pending,
				attempt,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	#handleTransportWriteError(
		pending: PendingDelivery,
		attempt: number,
		error: Error,
	): void {
		if (
			pending.terminal ||
			pending.attempts !== attempt ||
			this.#pendingDeliveries.get(pending.key) !== pending
		) {
			return;
		}
		pending.cancelTimer?.();
		pending.cancelTimer = undefined;
		if (!this.#recipientIsCurrent(pending)) {
			this.#finishDelivery(pending, { status: "disconnected" });
			return;
		}
		if (pending.attempts >= this.#deliveryRetryPolicy.maxAttempts) {
			this.#finishDelivery(pending, {
				status: "unknown",
				error: `WebSocket write outcome remained unknown after ${pending.attempts} attempts: ${error.message}`,
			});
			return;
		}
		this.#scheduleDelivery(
			pending,
			this.#deliveryRetryPolicy.retryDelayMs,
			() => this.#attemptDelivery(pending),
		);
	}

	#handleAcknowledgementTimeout(
		pending: PendingDelivery,
		attempt: number,
	): void {
		if (
			pending.terminal ||
			pending.attempts !== attempt ||
			this.#pendingDeliveries.get(pending.key) !== pending
		) {
			return;
		}
		if (!this.#recipientIsCurrent(pending)) {
			this.#finishDelivery(pending, { status: "disconnected" });
			return;
		}
		if (pending.attempts >= this.#deliveryRetryPolicy.maxAttempts) {
			this.#finishDelivery(pending, {
				status: "unknown",
				error: `recipient did not acknowledge delivery after ${pending.attempts} attempts`,
			});
			return;
		}
		this.#attemptDelivery(pending);
	}

	#scheduleDelivery(
		pending: PendingDelivery,
		delayMs: number,
		callback: () => void,
	): void {
		pending.cancelTimer?.();
		pending.cancelTimer = this.#deliveryRetryPolicy.schedule(() => {
			pending.cancelTimer = undefined;
			callback();
		}, delayMs);
	}

	#recipientIsCurrent(pending: PendingDelivery): boolean {
		return (
			pending.recipientSocket.readyState === WebSocket.OPEN &&
			this.#presences.getBySocket(pending.recipientSocket)?.presenceId ===
				pending.recipientPresenceId
		);
	}

	#finishDelivery(
		pending: PendingDelivery,
		outcome?:
			| { status: "delivered" | "disconnected" }
			| { status: "failed" | "unknown"; error: string },
	): void {
		if (
			pending.terminal ||
			this.#pendingDeliveries.get(pending.key) !== pending
		) {
			return;
		}
		pending.terminal = true;
		pending.cancelTimer?.();
		pending.cancelTimer = undefined;
		this.#pendingDeliveries.delete(pending.key);
		if (!outcome || pending.senderSocket.readyState !== WebSocket.OPEN) return;
		this.#send(
			pending.senderSocket,
			outcome.status === "failed" || outcome.status === "unknown"
				? {
						type: "delivery",
						messageId: pending.messageId,
						to: pending.recipientName,
						status: outcome.status,
						error: outcome.error,
					}
				: {
						type: "delivery",
						messageId: pending.messageId,
						to: pending.recipientName,
						status: outcome.status,
					},
		);
	}

	#release(
		socket: WebSocket,
		reason: "connection_closed" | "heartbeat_timeout" | "hub_shutdown",
	): Presence | null {
		const presence = this.#presences.remove(socket);
		if (!presence) return null;
		for (const pending of this.#pendingDeliveries.values()) {
			if (pending.senderPresenceId === presence.presenceId) {
				this.#finishDelivery(pending);
				continue;
			}
			if (pending.recipientPresenceId === presence.presenceId)
				this.#finishDelivery(pending, { status: "disconnected" });
		}
		if (!this.#closing) {
			this.#broadcast(presence.project, presence.presenceId, {
				type: "presence_left",
				peer: { name: presence.name, presenceId: presence.presenceId },
				reason,
			});
		}
		return presence;
	}

	#broadcast(
		project: string,
		excludedPresenceId: string,
		frame: ServerFrame,
	): void {
		for (const presence of this.#presences.connections(project)) {
			if (presence.presenceId !== excludedPresenceId)
				this.#send(presence.socket, frame);
		}
	}

	#closeAfterGoodbye(socket: WebSocket): void {
		socket.close(1000, "goodbye acknowledged");
		const terminateTimer = setTimeout(
			() => socket.terminate(),
			GOODBYE_CLOSE_TIMEOUT_MS,
		);
		terminateTimer.unref();
		socket.once("close", () => clearTimeout(terminateTimer));
	}

	#send(socket: WebSocket, frame: ServerFrame): void {
		if (socket.readyState === WebSocket.OPEN)
			socket.send(JSON.stringify(frame));
	}

	#heartbeatConnections(): void {
		for (const socket of this.#wss.clients) {
			if (this.#alive.get(socket) === false) {
				this.#closeReasons.set(socket, "heartbeat_timeout");
				socket.terminate();
				continue;
			}
			this.#alive.set(socket, false);
			socket.ping();
		}
	}
}
