import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { getProject } from "../registry";
import {
	MessageIdConflictError,
	type MessageStore,
	UnknownReplyTargetError,
} from "./messages";
import { decodeTextPayload, PayloadTooLargeError } from "./payload";
import { NameInUseError, type Presence, PresenceRegistry } from "./presence";
import {
	A2A_PROTOCOL_VERSION,
	type ClientFrame,
	type MessageTarget,
	type ServerFrame,
} from "./realtime-types";

const MAX_FRAME_BYTES = 6 * 1024 * 1024;
const HEARTBEAT_MS = 10_000;
const HELLO_TIMEOUT_MS = 5_000;

class RecipientNotPresentError extends Error {}

type PendingDelivery = {
	messageId: string;
	senderPresenceId: string;
	recipientPresenceId: string;
	recipientName: string;
};

export class RealtimeHub {
	#server: Server;
	#wss: WebSocketServer;
	#messages: MessageStore;
	#dataDir: string;
	#presences = new PresenceRegistry();
	#alive = new Map<WebSocket, boolean>();
	#closeReasons = new Map<
		WebSocket,
		"connection_closed" | "heartbeat_timeout" | "hub_shutdown"
	>();
	#pendingDeliveries = new Map<string, PendingDelivery>();
	#heartbeat: NodeJS.Timeout;
	#upgradeHandler: (
		request: IncomingMessage,
		socket: Socket,
		head: Buffer,
	) => void;
	#closing = false;

	constructor(server: Server, messages: MessageStore, dataDir: string) {
		this.#server = server;
		this.#messages = messages;
		this.#dataDir = dataDir;
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
		for (const socket of this.#wss.clients) socket.terminate();
		this.#pendingDeliveries.clear();
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
			const presence = this.#presences.remove(socket);
			if (!presence) return;
			this.#failDeliveriesFor(presence);
			if (!this.#closing) {
				this.#broadcast(presence.project, presence.presenceId, {
					type: "presence_left",
					peer: { name: presence.name, presenceId: presence.presenceId },
					reason: this.#closeReasons.get(socket) ?? "connection_closed",
				});
			}
			this.#closeReasons.delete(socket);
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
		if (value.type === "message") {
			this.#handleMessage(
				claimed,
				value as Partial<Extract<ClientFrame, { type: "message" }>>,
			);
			return;
		}
		if (value.type === "delivered") {
			this.#handleDelivered(
				claimed,
				value as Partial<Extract<ClientFrame, { type: "delivered" }>>,
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
				!frame.payload
			) {
				throw new Error(
					"requestId, messageId, target and payload are required",
				);
			}
			if (frame.target.type !== "agent" && frame.target.type !== "project")
				throw new Error("invalid message target");
			if (frame.replyTo !== undefined && typeof frame.replyTo !== "string")
				throw new Error("invalid replyTo");
			const text = decodeTextPayload(frame.payload);
			if (text.trim().length === 0) throw new Error("message text required");
			let target: MessageTarget;
			let recipients: Presence[];
			if (frame.target.type === "agent") {
				if (typeof frame.target.name !== "string")
					throw new Error("recipient name is required");
				const recipient = this.#presences.get(
					presence.project,
					frame.target.name,
				);
				if (!recipient)
					throw new RecipientNotPresentError(
						`recipient is not present: ${frame.target.name}`,
					);
				if (recipient.presenceId === presence.presenceId)
					throw new Error("cannot send to yourself");
				target = {
					type: "agent",
					name: recipient.name,
					presenceId: recipient.presenceId,
				};
				recipients = [recipient];
			} else {
				target = { type: "project" };
				recipients = this.#presences
					.connections(presence.project)
					.filter((recipient) => recipient.presenceId !== presence.presenceId);
			}
			const appended = this.#messages.append({
				messageId: frame.messageId,
				project: presence.project,
				from: { name: presence.name, presenceId: presence.presenceId },
				target,
				payload: frame.payload,
				createdAt: Date.now(),
				replyTo: frame.replyTo,
			});
			if (appended.inserted) {
				for (const recipient of recipients) {
					this.#pendingDeliveries.set(
						`${appended.message.messageId}:${recipient.presenceId}`,
						{
							messageId: appended.message.messageId,
							senderPresenceId: presence.presenceId,
							recipientPresenceId: recipient.presenceId,
							recipientName: recipient.name,
						},
					);
					this.#send(recipient.socket, {
						type: "message",
						message: appended.message,
					});
				}
			}
			this.#send(presence.socket, {
				type: "accepted",
				requestId,
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

	#handleDelivered(
		presence: Presence,
		frame: Partial<Extract<ClientFrame, { type: "delivered" }>>,
	): void {
		if (typeof frame.messageId !== "string")
			throw new Error("messageId is required");
		const key = `${frame.messageId}:${presence.presenceId}`;
		const pending = this.#pendingDeliveries.get(key);
		if (!pending) throw new Error(`unknown delivery: ${frame.messageId}`);
		this.#pendingDeliveries.delete(key);
		const sender = this.#presences
			.connections(presence.project)
			.find((candidate) => candidate.presenceId === pending.senderPresenceId);
		if (sender) {
			this.#send(sender.socket, {
				type: "delivery",
				messageId: pending.messageId,
				to: pending.recipientName,
				status: "delivered",
			});
		}
	}

	#failDeliveriesFor(presence: Presence): void {
		for (const [key, pending] of this.#pendingDeliveries) {
			if (pending.recipientPresenceId !== presence.presenceId) continue;
			this.#pendingDeliveries.delete(key);
			const sender = this.#presences
				.connections(presence.project)
				.find((candidate) => candidate.presenceId === pending.senderPresenceId);
			if (sender) {
				this.#send(sender.socket, {
					type: "delivery",
					messageId: pending.messageId,
					to: pending.recipientName,
					status: "disconnected",
				});
			}
		}
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
