import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

import { NameInUseError, type Presence, PresenceRegistry } from "./presence";
import {
	A2A_PROTOCOL_VERSION,
	type ClientFrame,
	DELIVERY_ACKNOWLEDGE_TIMEOUT_MS,
	isExactGoodbyeFrame,
	type ServerFrame,
} from "./realtime-types";
import {
	type HubStore,
	type MessageAppendResult,
	type MessageDraft,
	MessageIdConflictError,
	UnknownReplyTargetError,
} from "./store";

const HEARTBEAT_MS = 10_000;
const HELLO_TIMEOUT_MS = 5_000;
const GOODBYE_CLOSE_TIMEOUT_MS = 2_000;

export type RealtimeHubOptions = {
	deliveryAcknowledgeTimeoutMs?: number;
};

class RecipientNotPresentError extends Error {}

type PendingDelivery = {
	key: string;
	messageId: string;
	senderPresenceId: string;
	senderSocket: WebSocket;
	recipientPresenceId: string;
	recipientName: string;
	recipientSocket: WebSocket;
	cancelTimeout: () => void;
};

export class RealtimeHub {
	#server: Server;
	#wss: WebSocketServer;
	#store: Pick<HubStore, "append" | "replay" | "getProject">;
	#presences = new PresenceRegistry();
	#alive = new Map<WebSocket, boolean>();
	#closeReasons = new Map<
		WebSocket,
		"connection_closed" | "heartbeat_timeout" | "hub_shutdown"
	>();
	#pendingDeliveries = new Map<string, PendingDelivery>();
	#deliveryAcknowledgeTimeoutMs: number;
	#departed = new WeakSet<WebSocket>();
	#heartbeat: NodeJS.Timeout;
	#upgradeHandler: (
		request: IncomingMessage,
		socket: Socket,
		head: Buffer,
	) => void;
	#closing = false;
	#closePromise: Promise<void> | null = null;

	constructor(
		server: Server,
		store: Pick<HubStore, "append" | "replay" | "getProject">,
		options: RealtimeHubOptions = {},
	) {
		this.#server = server;
		this.#store = store;
		const deliveryAcknowledgeTimeoutMs =
			options.deliveryAcknowledgeTimeoutMs ?? DELIVERY_ACKNOWLEDGE_TIMEOUT_MS;
		if (
			!Number.isFinite(deliveryAcknowledgeTimeoutMs) ||
			deliveryAcknowledgeTimeoutMs <= 0
		) {
			throw new Error(
				"deliveryAcknowledgeTimeoutMs must be a finite positive number",
			);
		}
		if (deliveryAcknowledgeTimeoutMs > DELIVERY_ACKNOWLEDGE_TIMEOUT_MS) {
			throw new Error(
				`deliveryAcknowledgeTimeoutMs must not exceed ${DELIVERY_ACKNOWLEDGE_TIMEOUT_MS}ms`,
			);
		}
		this.#deliveryAcknowledgeTimeoutMs = deliveryAcknowledgeTimeoutMs;
		this.#wss = new WebSocketServer({
			noServer: true,
			maxPayload: 0,
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

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		this.#closePromise = (async () => {
			clearInterval(this.#heartbeat);
			this.#server.off("upgrade", this.#upgradeHandler);
			for (const presence of this.#presences.close()) {
				this.#closeReasons.set(presence.socket, "hub_shutdown");
			}
			for (const pending of this.#pendingDeliveries.values())
				this.#finishDelivery(pending);
			for (const socket of this.#wss.clients) socket.terminate();
			await new Promise<void>((resolve, reject) =>
				this.#wss.close((error) => (error ? reject(error) : resolve())),
			);
		})();
		return this.#closePromise;
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
			if (typeof frame.error !== "string" || frame.error.length === 0) {
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
			if (!this.#store.getProject(frame.project))
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
				const replayed = this.#store.replay(draft);
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
				appended = this.#store.append({
					...draft,
					target: {
						type: "agent",
						name: recipient.name,
						presenceId: recipient.presenceId,
					},
				});
				recipients = [recipient];
			} else {
				appended = this.#store.append(draft);
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
					.filter((recipient) => recipient.presenceId !== presence.presenceId);
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
				this.#startDelivery(
					presence,
					recipient,
					appended.message.messageId,
					payload,
				);
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

	#startDelivery(
		sender: Presence,
		recipient: Presence,
		messageId: string,
		payload: string,
	): void {
		const key = `${messageId}:${recipient.presenceId}`;
		const timeout = setTimeout(() => {
			const pending = this.#pendingDeliveries.get(key);
			if (!pending) return;
			this.#finishDelivery(pending, {
				status: "failed",
				error: `delivery unconfirmed because recipient did not acknowledge within ${this.#deliveryAcknowledgeTimeoutMs}ms`,
			});
		}, this.#deliveryAcknowledgeTimeoutMs);
		const pending: PendingDelivery = {
			key,
			messageId,
			senderPresenceId: sender.presenceId,
			senderSocket: sender.socket,
			recipientPresenceId: recipient.presenceId,
			recipientName: recipient.name,
			recipientSocket: recipient.socket,
			cancelTimeout: () => clearTimeout(timeout),
		};
		this.#pendingDeliveries.set(key, pending);
		try {
			recipient.socket.send(payload, (error) => {
				if (!error || this.#pendingDeliveries.get(key) !== pending) return;
				this.#finishDelivery(pending, {
					status: "failed",
					error: `delivery unconfirmed because WebSocket write failed: ${error.message}`,
				});
			});
		} catch (error) {
			this.#finishDelivery(pending, {
				status: "failed",
				error: `delivery unconfirmed because WebSocket write failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	#finishDelivery(
		pending: PendingDelivery,
		outcome?: { status: "delivered" } | { status: "failed"; error: string },
	): void {
		if (this.#pendingDeliveries.get(pending.key) !== pending) return;
		pending.cancelTimeout();
		this.#pendingDeliveries.delete(pending.key);
		if (!outcome || pending.senderSocket.readyState !== WebSocket.OPEN) return;
		this.#send(
			pending.senderSocket,
			outcome.status === "failed"
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
				this.#finishDelivery(pending, {
					status: "failed",
					error:
						"delivery unconfirmed because recipient disconnected before acknowledging",
				});
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
