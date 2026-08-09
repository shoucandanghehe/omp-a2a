import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import WebSocket, { WebSocketServer } from "ws";
import {
	A2aConnection,
	CLOSE_TIMEOUT_MS,
	GOODBYE_TIMEOUT_MS,
	MessageOutcomeUnknownError,
} from "../src/hub/connection";
import { HubClient } from "../src/hub/client";
import {
	decodeTextPayload,
	encodeTextPayload,
	MAX_TEXT_BYTES,
} from "../src/hub/payload";
import {
	A2A_PROTOCOL_VERSION,
	type ServerFrame,
} from "../src/hub/realtime-types";
import { type HubServerHandle, startHubServer } from "../src/hub/server";

const roots: string[] = [];
const hubs: HubServerHandle[] = [];

class FrameQueue {
	#frames: ServerFrame[] = [];
	#waiters: Array<(frame: ServerFrame) => void> = [];

	push(frame: ServerFrame): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter(frame);
		else this.#frames.push(frame);
	}

	next(): Promise<ServerFrame> {
		const frame = this.#frames.shift();
		if (frame) return Promise.resolve(frame);
		return new Promise<ServerFrame>((resolve) => this.#waiters.push(resolve));
	}

	takeNow(): ServerFrame | undefined {
		return this.#frames.shift();
	}
}

async function connect(
	baseUrl: string,
	project: string,
	name: string,
): Promise<{ socket: WebSocket; frames: FrameQueue }> {
	const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/v1/connect`);
	const frames = new FrameQueue();
	socket.on("message", (data) =>
		frames.push(JSON.parse(data.toString()) as ServerFrame),
	);
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	socket.send(
		JSON.stringify({
			type: "hello",
			protocolVersion: A2A_PROTOCOL_VERSION,
			project,
			name,
		}),
	);
	return { socket, frames };
}

afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("WebSocket lifetime is the complete Presence lifetime", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-realtime-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "room" });

	const api = await connect(hub.listenUrl, "room", "api");
	const apiClaimed = await api.frames.next();
	expect(apiClaimed).toMatchObject({
		type: "claimed",
		project: "room",
		self: { name: "api" },
		peers: [],
	});

	const duplicate = await connect(hub.listenUrl, "room", "api");
	expect(await duplicate.frames.next()).toMatchObject({
		type: "error",
		code: "name_in_use",
	});
	duplicate.socket.terminate();

	const web = await connect(hub.listenUrl, "room", "web");
	const webClaimed = await web.frames.next();
	expect(webClaimed).toMatchObject({
		type: "claimed",
		self: { name: "web" },
		peers: [{ name: "api" }],
	});
	expect(await api.frames.next()).toMatchObject({
		type: "presence_joined",
		peer: { name: "web" },
	});

	web.socket.close();
	expect(await api.frames.next()).toMatchObject({
		type: "presence_left",
		peer: { name: "web" },
	});

	const replacement = await connect(hub.listenUrl, "room", "web");
	const replacementClaimed = await replacement.frames.next();
	expect(replacementClaimed).toMatchObject({
		type: "claimed",
		self: { name: "web" },
	});
	if (webClaimed.type !== "claimed" || replacementClaimed.type !== "claimed")
		throw new Error("expected claimed frames");
	expect(replacementClaimed.self.presenceId).not.toBe(
		webClaimed.self.presenceId,
	);

	api.socket.close();
	replacement.socket.close();
});

test("direct messages and broadcasts target the current Presence snapshot", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-realtime-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "chat" });

	const api = await connect(hub.listenUrl, "chat", "api");
	await api.frames.next();
	const web = await connect(hub.listenUrl, "chat", "web");
	await web.frames.next();
	await api.frames.next();
	const testPeer = await connect(hub.listenUrl, "chat", "test");
	await testPeer.frames.next();
	await api.frames.next();
	await web.frames.next();

	api.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "request-direct",
			messageId: "direct-1",
			target: { type: "agent", name: "web" },
			payload: encodeTextPayload("check login"),
			attachments: [],
		}),
	);
	const direct = await web.frames.next();
	expect(direct).toMatchObject({
		type: "message",
		message: {
			messageId: "direct-1",
			messageRef: "chat:1",
			from: { name: "api" },
		},
	});
	if (direct.type !== "message") throw new Error("expected message frame");
	expect(decodeTextPayload(direct.message.payload)).toBe("check login");
	expect(await api.frames.next()).toMatchObject({
		type: "accepted",
		requestId: "request-direct",
		recipients: ["web"],
	});
	web.socket.send(JSON.stringify({ type: "delivered", messageId: "direct-1" }));
	expect(await api.frames.next()).toEqual({
		type: "delivery",
		messageId: "direct-1",
		to: "web",
		status: "delivered",
	});

	api.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "request-broadcast",
			messageId: "broadcast-1",
			target: { type: "project" },
			payload: encodeTextPayload("freeze contract"),
			attachments: [],
		}),
	);
	expect(await web.frames.next()).toMatchObject({
		type: "message",
		message: { messageId: "broadcast-1" },
	});
	expect(await testPeer.frames.next()).toMatchObject({
		type: "message",
		message: { messageId: "broadcast-1" },
	});
	expect(await api.frames.next()).toMatchObject({
		type: "accepted",
		requestId: "request-broadcast",
		message: { messageRef: "chat:2", target: { type: "project" } },
		recipients: ["web", "test"],
	});
	web.socket.send(
		JSON.stringify({ type: "delivered", messageId: "broadcast-1" }),
	);
	testPeer.socket.send(
		JSON.stringify({ type: "delivered", messageId: "broadcast-1" }),
	);
	const broadcastDeliveries = [
		await api.frames.next(),
		await api.frames.next(),
	];
	expect(
		broadcastDeliveries
			.map((frame) =>
				frame.type === "delivery" ? `${frame.to}:${frame.status}` : frame.type,
			)
			.sort(),
	).toEqual(["test:delivered", "web:delivered"]);

	api.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "request-disconnect",
			messageId: "disconnect-1",
			target: { type: "agent", name: "web" },
			payload: encodeTextPayload("still there?"),
			attachments: [],
		}),
	);
	expect(await web.frames.next()).toMatchObject({
		type: "message",
		message: { messageId: "disconnect-1" },
	});
	expect(await api.frames.next()).toMatchObject({
		type: "accepted",
		requestId: "request-disconnect",
	});
	web.socket.close();
	expect(await api.frames.next()).toEqual({
		type: "delivery",
		messageId: "disconnect-1",
		to: "web",
		status: "disconnected",
	});
	expect(await api.frames.next()).toMatchObject({
		type: "presence_left",
		peer: { name: "web" },
	});
	const replacement = await connect(hub.listenUrl, "chat", "web");
	const replacementClaimed = await replacement.frames.next();
	if (replacementClaimed.type !== "claimed")
		throw new Error("expected replacement claim");
	const pendingMessage = (
		await client.history({ project: "chat", from: "api" })
	).messages.find((message) => message.messageId === "disconnect-1");
	expect(pendingMessage?.target).toMatchObject({ type: "agent", name: "web" });
	if (pendingMessage?.target.type !== "agent")
		throw new Error("expected direct target");
	expect(pendingMessage.target.presenceId).not.toBe(
		replacementClaimed.self.presenceId,
	);
	replacement.socket.close();

	api.socket.close();
	// web closed above to prove pending delivery does not survive its Presence.
	testPeer.socket.close();
});

test("message history survives Hub restart while Presence does not", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-realtime-"));
	roots.push(dataDir);
	const first = await startHubServer({ port: 0, dataDir });
	hubs.push(first);
	const firstClient = new HubClient(first.listenUrl);
	await firstClient.createProject({ name: "durable-chat" });
	const api = await connect(first.listenUrl, "durable-chat", "api");
	await api.frames.next();
	const web = await connect(first.listenUrl, "durable-chat", "web");
	await web.frames.next();
	await api.frames.next();
	const attachmentBytes = Buffer.from("# Training handoff\nseed=20\n", "utf8");
	const attachment = {
		name: "training-handoff.md",
		payload: {
			encoding: "base64" as const,
			data: attachmentBytes.toString("base64"),
			uncompressedBytes: attachmentBytes.byteLength,
		},
	};
	api.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "request-history",
			messageId: "history-1",
			target: { type: "agent", name: "web" },
			payload: encodeTextPayload("persist this"),
			attachments: [attachment],
		}),
	);
	const inbound = await web.frames.next();
	if (inbound.type !== "message") throw new Error("expected message frame");
	expect(
		"attachments" in inbound.message ? inbound.message.attachments : undefined,
	).toEqual([attachment]);
	await api.frames.next();
	await first.stop();

	const second = await startHubServer({ port: 0, dataDir });
	hubs.push(second);
	const secondClient = new HubClient(second.listenUrl);
	const history = await secondClient.history({
		project: "durable-chat",
		limit: 10,
	});
	expect(history.messages).toHaveLength(1);
	expect(history.messages[0]).toMatchObject({
		messageId: "history-1",
		messageRef: "durable-chat:1",
	});
	const [persisted] = history.messages;
	if (!persisted) throw new Error("expected persisted history");
	expect(decodeTextPayload(persisted.payload)).toBe("persist this");
	expect(
		"attachments" in persisted ? persisted.attachments : undefined,
	).toEqual([attachment]);

	const replacement = await connect(second.listenUrl, "durable-chat", "web");
	expect(await replacement.frames.next()).toMatchObject({
		type: "claimed",
		peers: [],
	});
	replacement.socket.close();
});

test("message retries use original Presence snapshots without redelivery", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-realtime-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "retry-chat" });
	const api = await connect(hub.listenUrl, "retry-chat", "api");
	await api.frames.next();
	const web = await connect(hub.listenUrl, "retry-chat", "web");
	const webClaimed = await web.frames.next();
	await api.frames.next();
	if (webClaimed.type !== "claimed") throw new Error("expected web claim");

	const directFrame = {
		type: "message",
		messageId: "canonical-direct",
		target: { type: "agent", name: "web" },
		payload: encodeTextPayload("canonical direct"),
		attachments: [],
	};
	api.socket.send(JSON.stringify({ ...directFrame, requestId: "direct-first" }));
	await web.frames.next();
	expect(await api.frames.next()).toMatchObject({
		type: "accepted",
		recipients: ["web"],
		message: {
			messageRef: "retry-chat:1",
			target: { presenceId: webClaimed.self.presenceId },
		},
	});
	web.socket.close();
	expect(await api.frames.next()).toMatchObject({
		type: "delivery",
		status: "disconnected",
	});
	await api.frames.next();

	api.socket.send(
		JSON.stringify({ ...directFrame, requestId: "direct-offline-retry" }),
	);
	expect(await api.frames.next()).toMatchObject({
		type: "accepted",
		requestId: "direct-offline-retry",
		recipients: ["web"],
		message: { target: { presenceId: webClaimed.self.presenceId } },
	});

	const replacement = await connect(hub.listenUrl, "retry-chat", "web");
	await replacement.frames.next();
	await api.frames.next();
	api.socket.send(
		JSON.stringify({ ...directFrame, requestId: "direct-replaced-retry" }),
	);
	expect(await api.frames.next()).toMatchObject({
		type: "accepted",
		requestId: "direct-replaced-retry",
		recipients: ["web"],
		message: { target: { presenceId: webClaimed.self.presenceId } },
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(replacement.frames.takeNow()).toBeUndefined();
	const testPeer = await connect(hub.listenUrl, "retry-chat", "test");
	await testPeer.frames.next();
	await api.frames.next();
	await replacement.frames.next();
	const broadcastFrame = {
		type: "message",
		messageId: "canonical-broadcast",
		target: { type: "project" },
		payload: encodeTextPayload("canonical broadcast"),
		attachments: [],
	};
	api.socket.send(
		JSON.stringify({ ...broadcastFrame, requestId: "broadcast-first" }),
	);
	await replacement.frames.next();
	await testPeer.frames.next();
	expect(await api.frames.next()).toMatchObject({
		type: "accepted",
		recipients: ["web", "test"],
		message: { messageRef: "retry-chat:2" },
	});
	replacement.socket.close();
	expect(await api.frames.next()).toMatchObject({
		type: "delivery",
		status: "disconnected",
	});
	await api.frames.next();
	await testPeer.frames.next();
	const aux = await connect(hub.listenUrl, "retry-chat", "aux");
	await aux.frames.next();
	await api.frames.next();
	await testPeer.frames.next();

	api.socket.send(
		JSON.stringify({ ...broadcastFrame, requestId: "broadcast-retry" }),
	);
	expect(await api.frames.next()).toMatchObject({
		type: "accepted",
		requestId: "broadcast-retry",
		recipients: ["web", "test"],
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(testPeer.frames.takeNow()).toBeUndefined();
	expect(aux.frames.takeNow()).toBeUndefined();

	api.socket.send(
		JSON.stringify({
			...directFrame,
			requestId: "direct-conflict",
			payload: encodeTextPayload("changed"),
		}),
	);
	expect(await api.frames.next()).toMatchObject({
		type: "error",
		requestId: "direct-conflict",
		code: "message_id_conflict",
	});
	api.socket.close();
	testPeer.socket.close();
	aux.socket.close();
});

test("realtime validation classifies payload bounds and hides persistence details", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-realtime-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "rejections" });
	const api = await connect(hub.listenUrl, "rejections", "api");
	await api.frames.next();
	const web = await connect(hub.listenUrl, "rejections", "web");
	await web.frames.next();
	await api.frames.next();

	api.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "blank-reply",
			messageId: "blank-reply",
			target: { type: "agent", name: "web" },
			payload: encodeTextPayload("body"),
			attachments: [],
			replyTo: " \t",
		}),
	);
	expect(await api.frames.next()).toMatchObject({
		type: "error",
		requestId: "blank-reply",
		code: "message_rejected",
	});

	api.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "gzip-bomb",
			messageId: "gzip-bomb",
			target: { type: "agent", name: "web" },
			payload: {
				encoding: "gzip+base64",
				data: gzipSync(Buffer.alloc(MAX_TEXT_BYTES + 1)).toString("base64"),
				uncompressedBytes: MAX_TEXT_BYTES,
			},
			attachments: [],
		}),
	);
	expect(await api.frames.next()).toMatchObject({
		type: "error",
		requestId: "gzip-bomb",
		code: "payload_too_large",
	});

	const database = new Database(join(dataDir, "messages.sqlite"));
	database.run(`
		CREATE TRIGGER reject_message_insert
		BEFORE INSERT ON messages
		BEGIN
			SELECT RAISE(ABORT, 'sensitive storage detail');
		END
	`);
	api.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "persistence-failure",
			messageId: "persistence-failure",
			target: { type: "agent", name: "web" },
			payload: encodeTextPayload("body"),
			attachments: [],
		}),
	);
	const failure = await api.frames.next();
	expect(failure).toMatchObject({
		type: "error",
		requestId: "persistence-failure",
		code: "internal_error",
	});
	if (failure.type !== "error") throw new Error("expected error frame");
	expect(failure.message).not.toContain("sensitive storage detail");
	database.run("DROP TRIGGER reject_message_insert");
	database.close();

	api.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "valid",
			messageId: "valid",
			target: { type: "agent", name: "web" },
			payload: encodeTextPayload("valid"),
			attachments: [],
		}),
	);
	expect(await web.frames.next()).toMatchObject({
		type: "message",
		message: { messageRef: "rejections:1" },
	});
	expect(await api.frames.next()).toMatchObject({
		type: "accepted",
		requestId: "valid",
	});
	api.socket.close();
	web.socket.close();
});

test(
	"message aborts report an unknown outcome and close has a bounded fallback",
	async () => {
		const server = createServer();
		const sockets = new WebSocketServer({ server });
		let receivedGoodbye = false;
		let resolveMessage!: () => void;
		const receivedMessage = new Promise<void>((resolve) => {
			resolveMessage = resolve;
		});
		sockets.on("connection", (socket) => {
			socket.on("message", (data) => {
				const frame = JSON.parse(data.toString()) as { type?: string };
				if (frame.type === "hello") {
					socket.send(
						JSON.stringify({
							type: "claimed",
							protocolVersion: A2A_PROTOCOL_VERSION,
							project: "stalled",
							self: { name: "api", presenceId: "presence-api" },
							peers: [],
						} satisfies ServerFrame),
					);
				} else if (frame.type === "message") {
					resolveMessage();
				} else if (frame.type === "goodbye") {
					receivedGoodbye = true;
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("test server did not expose a TCP address");
			const connection = await A2aConnection.connect({
				baseUrl: `http://127.0.0.1:${address.port}`,
				project: "stalled",
				name: "api",
			});
			const controller = new AbortController();
			const pendingMessage = connection.send(
				{ target: { type: "project" }, text: "may be accepted" },
				{ signal: controller.signal },
			);
			await receivedMessage;
			const cancellation = new Error("cancelled by model");
			controller.abort(cancellation);
			let messageFailure: unknown;
			try {
				await pendingMessage;
			} catch (error) {
				messageFailure = error;
			}
			expect(messageFailure).toBeInstanceOf(MessageOutcomeUnknownError);
			expect((messageFailure as Error).cause).toBe(cancellation);
			const startedAt = Date.now();
			await connection.close();
			expect(receivedGoodbye).toBe(true);
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
				GOODBYE_TIMEOUT_MS - 100,
			);
			expect(Date.now() - startedAt).toBeLessThan(
				GOODBYE_TIMEOUT_MS + CLOSE_TIMEOUT_MS + 1_000,
			);
		} finally {
			for (const socket of sockets.clients) socket.terminate();
			sockets.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
	5_000,
);

test(
	"stalled handshakes time out or abort and terminate their sockets",
	async () => {
		const server = createServer();
		const sockets = new WebSocketServer({ server });
		let resolveFirstConnected!: () => void;
		let resolveSecondConnected!: () => void;
		let resolveFirstClosed!: () => void;
		let resolveSecondClosed!: () => void;
		const firstConnected = new Promise<void>((resolve) => {
			resolveFirstConnected = resolve;
		});
		const secondConnected = new Promise<void>((resolve) => {
			resolveSecondConnected = resolve;
		});
		const firstClosed = new Promise<void>((resolve) => {
			resolveFirstClosed = resolve;
		});
		const secondClosed = new Promise<void>((resolve) => {
			resolveSecondClosed = resolve;
		});
		let acceptedSockets = 0;
		sockets.on("connection", (socket) => {
			acceptedSockets++;
			if (acceptedSockets === 1) resolveFirstConnected();
			else resolveSecondConnected();
			socket.once("close", () => {
				if (acceptedSockets === 1) resolveFirstClosed();
				else resolveSecondClosed();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("test server did not expose a TCP address");
			const baseUrl = `http://127.0.0.1:${address.port}`;
			const timed = A2aConnection.connect({
				baseUrl,
				project: "stalled",
				name: "timeout",
				handshakeTimeoutMs: 50,
			});
			await firstConnected;
			let timeoutFailure: unknown;
			try {
				await timed;
			} catch (error) {
				timeoutFailure = error;
			}
			expect(timeoutFailure).toBeInstanceOf(DOMException);
			expect((timeoutFailure as DOMException).name).toBe("TimeoutError");
			await firstClosed;

			const controller = new AbortController();
			const aborted = A2aConnection.connect({
				baseUrl,
				project: "stalled",
				name: "aborted",
				signal: controller.signal,
			});
			await secondConnected;
			const reason = new Error("session shut down");
			controller.abort(reason);
			await expect(aborted).rejects.toBe(reason);
			await secondClosed;
			expect(sockets.clients.size).toBe(0);
		} finally {
			for (const socket of sockets.clients) socket.terminate();
			sockets.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
	2_000,
);
