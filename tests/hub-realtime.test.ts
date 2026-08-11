import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { createProject } from "../src/registry";
import { A2aConnection } from "../src/hub/connection";
import { HubClient } from "../src/hub/client";
import type { MessageDraft } from "../src/hub/messages";
import { decodeTextPayload, encodeTextPayload } from "../src/hub/payload";
import {
	A2A_PROTOCOL_VERSION,
	type ClientFrame,
	type RealtimeMessage,
	type ServerFrame,
} from "../src/hub/realtime-types";
import {
	RealtimeHub,
	type RealtimeHubOptions,
} from "../src/hub/realtime-server";
import { type HubServerHandle, startHubServer } from "../src/hub/server";

const roots: string[] = [];
const hubs: HubServerHandle[] = [];
const transports: Array<() => Promise<void>> = [];

class FrameQueue<Frame = ServerFrame> {
	#frames: Frame[] = [];
	#waiters: Array<(frame: Frame) => void> = [];

	push(frame: Frame): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter(frame);
		else this.#frames.push(frame);
	}

	next(): Promise<Frame> {
		const frame = this.#frames.shift();
		if (frame) return Promise.resolve(frame);
		return new Promise<Frame>((resolve) => this.#waiters.push(resolve));
	}

	size(): number {
		return this.#frames.length;
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

async function startTestTransport(): Promise<{
	baseUrl: string;
	socket: Promise<WebSocket>;
	frames: FrameQueue<ClientFrame>;
}> {
	const server = createServer();
	const websocketServer = new WebSocketServer({ server });
	const connected = Promise.withResolvers<WebSocket>();
	const frames = new FrameQueue<ClientFrame>();
	websocketServer.once("connection", (socket) => {
		connected.resolve(socket);
		socket.on("message", (data) =>
			frames.push(JSON.parse(data.toString()) as ClientFrame),
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("expected test transport TCP address");
	transports.push(async () => {
		for (const socket of websocketServer.clients) socket.terminate();
		await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		socket: connected.promise,
		frames,
	};
}

type MessageLedger = ConstructorParameters<typeof RealtimeHub>[1];

class ManualScheduler {
	#tasks: Array<{ callback: () => void; cancelled: boolean }> = [];

	schedule = (callback: () => void): (() => void) => {
		const task = { callback, cancelled: false };
		this.#tasks.push(task);
		return () => {
			task.cancelled = true;
		};
	};

	runNext(): void {
		let task = this.#tasks.shift();
		while (task?.cancelled) task = this.#tasks.shift();
		if (!task) throw new Error("expected a scheduled delivery action");
		task.callback();
	}

	get pending(): number {
		return this.#tasks.filter((task) => !task.cancelled).length;
	}
}

function messageFromDraft(draft: MessageDraft): RealtimeMessage {
	return {
		messageId: draft.messageId,
		messageRef: `${draft.project}:1`,
		project: draft.project,
		sequence: 1,
		from: { ...draft.from },
		target: { ...draft.target },
		payload: { ...draft.payload },
		attachments: draft.attachments,
		createdAt: draft.createdAt,
		replyTo: draft.replyTo,
	};
}

function acceptingLedger(appendError?: Error): MessageLedger {
	const stored = new Map<string, RealtimeMessage>();
	return {
		append(draft) {
			if (appendError) throw appendError;
			const replayed = stored.get(draft.messageId);
			if (replayed) return { replayed: true, message: replayed };
			const message = messageFromDraft(draft);
			stored.set(draft.messageId, message);
			return { replayed: false, message };
		},
		replay(draft) {
			const replayed = stored.get(draft.messageId);
			return replayed ? { replayed: true, message: replayed } : null;
		},
	};
}

async function startRealtimeTransport(
	messages: MessageLedger,
	options: RealtimeHubOptions = {},
): Promise<{ baseUrl: string; realtime: RealtimeHub }> {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-retry-policy-"));
	roots.push(dataDir);
	createProject({ name: "room", dataDir });
	const server = createServer();
	const realtime = new RealtimeHub(server, messages, dataDir, options);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("expected realtime test TCP address");
	transports.push(async () => {
		await realtime.close();
		if (server.listening)
			await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		realtime,
	};
}

function claimedFrame(name: string): ServerFrame {
	return {
		type: "claimed",
		protocolVersion: A2A_PROTOCOL_VERSION,
		project: "room",
		self: { name, presenceId: `${name}-presence` },
		peers: [],
	};
}

function acceptedFrame(
	requestId: string,
	messageId: string,
): Extract<ServerFrame, { type: "accepted" }> {
	return {
		type: "accepted",
		requestId,
		replayed: false,
		message: {
			messageId,
			messageRef: "room:1",
			project: "room",
			sequence: 1,
			from: { name: "api", presenceId: "api-presence" },
			target: { type: "project" },
			payload: encodeTextPayload("accepted"),
			attachments: [],
			createdAt: 1,
		},
		recipients: [],
	};
}

afterEach(async () => {
	await Promise.all(transports.splice(0).map((stop) => stop()));
	await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("WebSocket lifetime is the complete Presence lifetime", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-realtime-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "room" });

	const api = await connect(hub.meta.baseUrl, "room", "api");
	const apiClaimed = await api.frames.next();
	expect(apiClaimed).toMatchObject({
		type: "claimed",
		project: "room",
		self: { name: "api" },
		peers: [],
	});

	const duplicate = await connect(hub.meta.baseUrl, "room", "api");
	expect(await duplicate.frames.next()).toMatchObject({
		type: "error",
		code: "name_in_use",
	});
	duplicate.socket.terminate();

	const web = await connect(hub.meta.baseUrl, "room", "web");
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

	const replacement = await connect(hub.meta.baseUrl, "room", "web");
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

test("direct messages and broadcasts bind the current concrete Presences", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-realtime-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "chat" });

	const api = await connect(hub.meta.baseUrl, "chat", "api");
	await api.frames.next();
	const web = await connect(hub.meta.baseUrl, "chat", "web");
	await web.frames.next();
	await api.frames.next();
	const testPeer = await connect(hub.meta.baseUrl, "chat", "test");
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
		replayed: false,
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
		replayed: false,
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
		replayed: false,
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
	api.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "request-direct-replay",
			messageId: "direct-1",
			target: { type: "agent", name: "web" },
			payload: encodeTextPayload("check login"),
			attachments: [],
		}),
	);
	const replayed = await api.frames.next();
	expect(replayed).toMatchObject({
		type: "accepted",
		requestId: "request-direct-replay",
		replayed: true,
		message: { messageRef: "chat:1" },
	});
	expect("recipients" in replayed).toBe(false);
	const replacement = await connect(hub.meta.baseUrl, "chat", "web");
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
	const firstClient = new HubClient(first.meta.baseUrl);
	await firstClient.createProject({ name: "durable-chat" });
	const api = await connect(first.meta.baseUrl, "durable-chat", "api");
	await api.frames.next();
	const web = await connect(first.meta.baseUrl, "durable-chat", "web");
	await web.frames.next();
	await api.frames.next();
	const attachmentBytes = Buffer.from("# Training handoff\nseed=20\n", "utf8");
	const attachment = {
		name: "training-handoff.md",
		payload: {
			encoding: "base64",
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
	const secondClient = new HubClient(second.meta.baseUrl);
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

	const replacement = await connect(second.meta.baseUrl, "durable-chat", "web");
	expect(await replacement.frames.next()).toMatchObject({
		type: "claimed",
		peers: [],
	});
	replacement.socket.close();
});

test("client handshake timeout and caller abort leave no socket or Presence", async () => {
	const stalled = await startTestTransport();
	const timedOut = expect(
		A2aConnection.connect({
			baseUrl: stalled.baseUrl,
			project: "room",
			name: "api",
			timeoutMs: 250,
		}),
	).rejects.toThrow("handshake timed out");
	const stalledSocket = await stalled.socket;
	const serverObservedClose = Promise.withResolvers<void>();
	stalledSocket.once("close", () => serverObservedClose.resolve());
	expect(await stalled.frames.next()).toMatchObject({ type: "hello" });
	await timedOut;
	await serverObservedClose.promise;

	const abortedTransport = await startTestTransport();
	const inFlightController = new AbortController();
	const abortedHandshake = expect(
		A2aConnection.connect({
			baseUrl: abortedTransport.baseUrl,
			project: "room",
			name: "api",
			signal: inFlightController.signal,
		}),
	).rejects.toThrow("handshake aborted");
	const abortedSocket = await abortedTransport.socket;
	const abortObservedClose = Promise.withResolvers<void>();
	abortedSocket.once("close", () => abortObservedClose.resolve());
	expect(await abortedTransport.frames.next()).toMatchObject({ type: "hello" });
	inFlightController.abort();
	await abortedHandshake;
	await abortObservedClose.promise;

	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-abort-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "abort-room" });
	const preAborted = new AbortController();
	preAborted.abort();
	await expect(
		A2aConnection.connect({
			baseUrl: hub.meta.baseUrl,
			project: "abort-room",
			name: "api",
			signal: preAborted.signal,
		}),
	).rejects.toThrow("aborted before connecting");
	expect(await client.deleteProject("abort-room")).toBe(true);
});

test("close shares one goodbye barrier and releases the name before resolving", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-goodbye-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "goodbye-room" });
	const observer = await connect(hub.meta.baseUrl, "goodbye-room", "observer");
	await observer.frames.next();
	const api = await A2aConnection.connect({
		baseUrl: hub.meta.baseUrl,
		project: "goodbye-room",
		name: "api",
	});
	expect(await observer.frames.next()).toMatchObject({
		type: "presence_joined",
		peer: { name: "api" },
	});

	const firstClose = api.close();
	const secondClose = api.close();
	expect(secondClose).toBe(firstClose);
	await firstClose;
	expect(await observer.frames.next()).toMatchObject({
		type: "presence_left",
		peer: { name: "api" },
	});

	const replacement = await A2aConnection.connect({
		baseUrl: hub.meta.baseUrl,
		project: "goodbye-room",
		name: "api",
	});
	expect(await observer.frames.next()).toMatchObject({
		type: "presence_joined",
		peer: { name: "api" },
	});
	await Promise.all([replacement.close(), replacement.close()]);
	expect(await observer.frames.next()).toMatchObject({
		type: "presence_left",
		peer: { name: "api" },
	});
	observer.socket.send(JSON.stringify({ type: "goodbye" }));
	expect(await observer.frames.next()).toEqual({ type: "goodbye" });
	expect(await client.deleteProject("goodbye-room")).toBe(true);
	observer.socket.close();
});

test("close falls back to bounded termination when goodbye and close stall", async () => {
	const transport = await startTestTransport();
	const closed = Promise.withResolvers<{ code: number }>();
	const connecting = A2aConnection.connect({
		baseUrl: transport.baseUrl,
		project: "room",
		name: "api",
		goodbyeTimeoutMs: 100,
		closeTimeoutMs: 100,
		events: { onClose: ({ code }) => closed.resolve({ code }) },
	});
	const socket = await transport.socket;
	expect(await transport.frames.next()).toMatchObject({ type: "hello" });
	socket.send(JSON.stringify(claimedFrame("api")));
	const connection = await connecting;
	const closing = connection.close();
	expect(await transport.frames.next()).toEqual({ type: "goodbye" });
	socket.pause();
	await closing;
	expect((await closed.promise).code).toBe(1006);
	socket.resume();
});

test("aborted and timed out message requests ignore late acceptance and errors", async () => {
	const transport = await startTestTransport();
	const unexpectedErrors: Error[] = [];
	const connecting = A2aConnection.connect({
		baseUrl: transport.baseUrl,
		project: "room",
		name: "api",
		goodbyeTimeoutMs: 10,
		closeTimeoutMs: 10,
		events: { onError: (error) => unexpectedErrors.push(error) },
	});
	const socket = await transport.socket;
	await transport.frames.next();
	socket.send(JSON.stringify(claimedFrame("api")));
	const connection = await connecting;

	const controller = new AbortController();
	const aborted = connection.send(
		{ target: { type: "project" }, text: "abort", messageId: "abort-message" },
		{ signal: controller.signal },
	);
	const abortedResult = expect(aborted).rejects.toThrow("outcomes are unknown");
	const abortedFrame = await transport.frames.next();
	if (abortedFrame.type !== "message")
		throw new Error("expected aborted message request");
	controller.abort();
	await abortedResult;
	socket.send(
		JSON.stringify(acceptedFrame(abortedFrame.requestId, "abort-message")),
	);

	const timedOut = connection.send(
		{
			target: { type: "project" },
			text: "timeout",
			messageId: "timeout-message",
		},
		{ timeoutMs: 10 },
	);
	const timedOutResult = expect(timedOut).rejects.toThrow(
		"outcomes are unknown",
	);
	const timedOutFrame = await transport.frames.next();
	if (timedOutFrame.type !== "message")
		throw new Error("expected timed out message request");
	await timedOutResult;
	socket.send(
		JSON.stringify({
			type: "error",
			requestId: timedOutFrame.requestId,
			code: "late_error",
			message: "late request error",
		}),
	);

	const final = connection.send({
		target: { type: "project" },
		text: "final",
		messageId: "final-message",
	});
	const finalFrame = await transport.frames.next();
	if (finalFrame.type !== "message")
		throw new Error("expected final message request");
	socket.send(JSON.stringify(acceptedFrame(finalFrame.requestId, "final-message")));
	expect((await final).message.messageId).toBe("final-message");
	expect(unexpectedErrors).toEqual([]);
	const closing = connection.close();
	expect(await transport.frames.next()).toEqual({ type: "goodbye" });
	socket.send(JSON.stringify({ type: "goodbye" }));
	await closing;
});

test("malformed accepted frames reject the matching request", async () => {
	const cases: Array<{
		name: string;
		frame: (requestId: string, messageId: string) => unknown;
	}> = [
		{
			name: "missing replayed",
			frame(requestId, messageId) {
				const frame = {
					...acceptedFrame(requestId, messageId),
				} as unknown as Record<string, unknown>;
				delete frame.replayed;
				return frame;
			},
		},
		{
			name: "non-boolean replayed",
			frame(requestId, messageId) {
				return {
					...acceptedFrame(requestId, messageId),
					replayed: "false",
				};
			},
		},
		{
			name: "new acceptance missing recipients",
			frame(requestId, messageId) {
				const frame = {
					...acceptedFrame(requestId, messageId),
				} as unknown as Record<string, unknown>;
				delete frame.recipients;
				return frame;
			},
		},
		{
			name: "new acceptance with malformed recipients",
			frame(requestId, messageId) {
				return {
					...acceptedFrame(requestId, messageId),
					recipients: ["receiver", 1],
				};
			},
		},
		{
			name: "replay containing recipients",
			frame(requestId, messageId) {
				const accepted = acceptedFrame(requestId, messageId);
				return {
					type: "accepted",
					requestId,
					replayed: true,
					message: accepted.message,
					recipients: [],
				};
			},
		},
		{
			name: "unknown acceptance field",
			frame(requestId, messageId) {
				return {
					...acceptedFrame(requestId, messageId),
					unexpected: true,
				};
			},
		},
		{
			name: "unknown canonical message field",
			frame(requestId, messageId) {
				const accepted = acceptedFrame(requestId, messageId);
				return {
					...accepted,
					message: { ...accepted.message, unexpected: true },
				};
			},
		},
		{
			name: "canonical message missing attachments",
			frame(requestId, messageId) {
				const accepted = acceptedFrame(requestId, messageId);
				const message = {
					...accepted.message,
				} as unknown as Record<string, unknown>;
				delete message.attachments;
				return { ...accepted, message };
			},
		},
	];

	for (const [index, malformed] of cases.entries()) {
		const transport = await startTestTransport();
		const connecting = A2aConnection.connect({
			baseUrl: transport.baseUrl,
			project: "room",
			name: "api",
		});
		const socket = await transport.socket;
		await transport.frames.next();
		socket.send(JSON.stringify(claimedFrame("api")));
		const connection = await connecting;
		const messageId = `malformed-acceptance-${index}`;
		const pending = connection.send({
			target: { type: "project" },
			text: malformed.name,
			messageId,
		});
		const request = await transport.frames.next();
		if (request.type !== "message")
			throw new Error("expected message request for malformed acceptance");
		socket.send(JSON.stringify(malformed.frame(request.requestId, messageId)));
		await expect(pending).rejects.toThrow(/accepted/i);
		socket.terminate();
		await connection.close();
	}
});

test("delivery cleanup is fenced by recipient and sender Presence", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-delivery-cleanup-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "cleanup" });
	const sender = await connect(hub.meta.baseUrl, "cleanup", "sender");
	await sender.frames.next();
	const recipient = await connect(hub.meta.baseUrl, "cleanup", "recipient");
	await recipient.frames.next();
	await sender.frames.next();

	sender.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "recipient-disconnect-request",
			messageId: "recipient-disconnect",
			target: { type: "agent", name: "recipient" },
			payload: encodeTextPayload("recipient leaves"),
			attachments: [],
		}),
	);
	await recipient.frames.next();
	await sender.frames.next();
	recipient.socket.send(JSON.stringify({ type: "goodbye" }));
	expect(await recipient.frames.next()).toEqual({ type: "goodbye" });
	expect(await sender.frames.next()).toEqual({
		type: "delivery",
		messageId: "recipient-disconnect",
		to: "recipient",
		status: "disconnected",
	});
	await sender.frames.next();

	const recipientReplacement = await connect(
		hub.meta.baseUrl,
		"cleanup",
		"recipient",
	);
	await recipientReplacement.frames.next();
	await sender.frames.next();
	recipientReplacement.socket.send(
		JSON.stringify({ type: "delivered", messageId: "recipient-disconnect" }),
	);
	recipientReplacement.socket.send(JSON.stringify({ type: "goodbye" }));
	expect(await recipientReplacement.frames.next()).toEqual({ type: "goodbye" });
	await sender.frames.next();

	const recipientTwo = await connect(
		hub.meta.baseUrl,
		"cleanup",
		"recipient",
	);
	await recipientTwo.frames.next();
	await sender.frames.next();
	sender.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "sender-disconnect-request",
			messageId: "sender-disconnect",
			target: { type: "agent", name: "recipient" },
			payload: encodeTextPayload("sender leaves"),
			attachments: [],
		}),
	);
	await recipientTwo.frames.next();
	await sender.frames.next();
	sender.socket.send(JSON.stringify({ type: "goodbye" }));
	expect(await sender.frames.next()).toEqual({ type: "goodbye" });
	expect(await recipientTwo.frames.next()).toMatchObject({
		type: "presence_left",
		peer: { name: "sender" },
	});

	const senderReplacement = await connect(
		hub.meta.baseUrl,
		"cleanup",
		"sender",
	);
	await senderReplacement.frames.next();
	await recipientTwo.frames.next();
	recipientTwo.socket.send(
		JSON.stringify({ type: "delivered", messageId: "sender-disconnect" }),
	);
	recipientTwo.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "delivery-barrier-request",
			messageId: "delivery-barrier",
			target: { type: "agent", name: "sender" },
			payload: encodeTextPayload("barrier"),
			attachments: [],
		}),
	);
	expect(await senderReplacement.frames.next()).toMatchObject({
		type: "message",
		message: { messageId: "delivery-barrier" },
	});
	await recipientTwo.frames.next();
	senderReplacement.socket.send(
		JSON.stringify({ type: "delivered", messageId: "delivery-barrier" }),
	);
	await recipientTwo.frames.next();
	senderReplacement.socket.close();
	recipientTwo.socket.close();
	sender.socket.close();
	recipient.socket.close();
	recipientReplacement.socket.close();
});

test("broadcast persists before one local Presence enumeration and enqueue does not wait for writes", async () => {
	const scheduler = new ManualScheduler();
	let enumerations = 0;
	let sends = 0;
	const { baseUrl } = await startRealtimeTransport(acceptingLedger(), {
		deliveryRetryPolicy: { schedule: scheduler.schedule },
		enumerateProjectPresences(project, current) {
			expect(project).toBe("room");
			enumerations += 1;
			return current();
		},
		sendDeliveryFrame(socket, payload) {
			sends += 1;
			socket.send(payload);
		},
	});
	const sender = await connect(baseUrl, "room", "sender");
	await sender.frames.next();
	const first = await connect(baseUrl, "room", "first");
	await first.frames.next();
	await sender.frames.next();
	const second = await connect(baseUrl, "room", "second");
	await second.frames.next();
	await sender.frames.next();
	await first.frames.next();

	sender.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "broadcast-order",
			messageId: "broadcast-order",
			target: { type: "project" },
			payload: encodeTextPayload("fan out"),
			attachments: [],
		}),
	);
	expect(await first.frames.next()).toMatchObject({
		type: "message",
		message: { messageId: "broadcast-order" },
	});
	expect(await second.frames.next()).toMatchObject({
		type: "message",
		message: { messageId: "broadcast-order" },
	});
	expect(await sender.frames.next()).toMatchObject({
		type: "accepted",
		replayed: false,
		recipients: ["first", "second"],
	});
	expect(enumerations).toBe(1);
	expect(sends).toBe(2);

	const late = await connect(baseUrl, "room", "late");
	expect(await late.frames.next()).toMatchObject({ type: "claimed" });
	expect(late.frames.size()).toBe(0);
	expect(enumerations).toBe(1);
	expect(scheduler.pending).toBe(2);
	sender.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "broadcast-replay",
			messageId: "broadcast-order",
			target: { type: "project" },
			payload: encodeTextPayload("fan out"),
			attachments: [],
		}),
	);
	const replayed = await sender.frames.next();
	expect(replayed).toMatchObject({
		type: "accepted",
		requestId: "broadcast-replay",
		replayed: true,
	});
	expect("recipients" in replayed).toBe(false);
	expect(enumerations).toBe(1);
	expect(sends).toBe(2);
	sender.socket.close();
	first.socket.close();
	second.socket.close();
	late.socket.close();
});

test("failed broadcast append performs no Presence enumeration or send", async () => {
	let enumerations = 0;
	let sends = 0;
	const { baseUrl } = await startRealtimeTransport(
		acceptingLedger(new Error("append unavailable")),
		{
			enumerateProjectPresences(_project, current) {
				enumerations += 1;
				return current();
			},
			sendDeliveryFrame() {
				sends += 1;
			},
		},
	);
	const sender = await connect(baseUrl, "room", "sender");
	await sender.frames.next();
	const recipient = await connect(baseUrl, "room", "recipient");
	await recipient.frames.next();
	await sender.frames.next();

	sender.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "append-failure",
			messageId: "append-failure",
			target: { type: "project" },
			payload: encodeTextPayload("must persist first"),
			attachments: [],
		}),
	);
	expect(await sender.frames.next()).toMatchObject({
		type: "error",
		requestId: "append-failure",
		message: "append unavailable",
	});
	expect(enumerations).toBe(0);
	expect(sends).toBe(0);
	expect(recipient.frames.size()).toBe(0);
	sender.socket.close();
	recipient.socket.close();
});

test("transport write errors retry only the bound Presence", async () => {
	const scheduler = new ManualScheduler();
	let attempts = 0;
	const { baseUrl } = await startRealtimeTransport(acceptingLedger(), {
		deliveryRetryPolicy: { schedule: scheduler.schedule },
		sendDeliveryFrame(socket, payload, callback) {
			attempts += 1;
			if (attempts === 1) {
				callback(new Error("temporary write failure"));
				return;
			}
			socket.send(payload, callback);
		},
	});
	const sender = await connect(baseUrl, "room", "sender");
	await sender.frames.next();
	const recipient = await connect(baseUrl, "room", "recipient");
	await recipient.frames.next();
	await sender.frames.next();
	sender.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "transport-retry",
			messageId: "transport-retry",
			target: { type: "agent", name: "recipient" },
			payload: encodeTextPayload("retry write"),
			attachments: [],
		}),
	);
	expect(await sender.frames.next()).toMatchObject({
		type: "accepted",
		replayed: false,
	});
	expect(attempts).toBe(1);
	scheduler.runNext();
	expect(await recipient.frames.next()).toMatchObject({
		type: "message",
		message: { messageId: "transport-retry" },
	});
	recipient.socket.send(
		JSON.stringify({ type: "delivered", messageId: "transport-retry" }),
	);
	expect(await sender.frames.next()).toEqual({
		type: "delivery",
		messageId: "transport-retry",
		to: "recipient",
		status: "delivered",
	});
	expect(attempts).toBe(2);
	expect(scheduler.pending).toBe(0);
	sender.socket.close();
	recipient.socket.close();
});

test("ACK retries end unknown while terminal failure and sender departure cancel retry", async () => {
	const scheduler = new ManualScheduler();
	let attempts = 0;
	const { baseUrl } = await startRealtimeTransport(acceptingLedger(), {
		deliveryRetryPolicy: { schedule: scheduler.schedule },
		sendDeliveryFrame(socket, payload, callback) {
			attempts += 1;
			socket.send(payload, callback);
		},
	});
	const sender = await connect(baseUrl, "room", "sender");
	await sender.frames.next();
	const recipient = await connect(baseUrl, "room", "recipient");
	await recipient.frames.next();
	await sender.frames.next();

	sender.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "unknown-request",
			messageId: "unknown-delivery",
			target: { type: "agent", name: "recipient" },
			payload: encodeTextPayload("drop every ACK"),
			attachments: [],
		}),
	);
	await recipient.frames.next();
	await sender.frames.next();
	scheduler.runNext();
	await recipient.frames.next();
	scheduler.runNext();
	await recipient.frames.next();
	scheduler.runNext();
	expect(await sender.frames.next()).toEqual({
		type: "delivery",
		messageId: "unknown-delivery",
		to: "recipient",
		status: "unknown",
		error: "recipient did not acknowledge delivery after 3 attempts",
	});
	expect(attempts).toBe(3);
	expect(scheduler.pending).toBe(0);

	sender.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "failed-request",
			messageId: "terminal-failure",
			target: { type: "agent", name: "recipient" },
			payload: encodeTextPayload("terminal failure"),
			attachments: [],
		}),
	);
	await recipient.frames.next();
	await sender.frames.next();
	recipient.socket.send(
		JSON.stringify({
			type: "delivery_failed",
			messageId: "terminal-failure",
			error: "receiver rejected injection",
		}),
	);
	expect(await sender.frames.next()).toEqual({
		type: "delivery",
		messageId: "terminal-failure",
		to: "recipient",
		status: "failed",
		error: "receiver rejected injection",
	});
	expect(attempts).toBe(4);
	expect(scheduler.pending).toBe(0);

	sender.socket.send(
		JSON.stringify({
			type: "message",
			requestId: "sender-leaves-request",
			messageId: "sender-leaves",
			target: { type: "agent", name: "recipient" },
			payload: encodeTextPayload("cancel timer"),
			attachments: [],
		}),
	);
	await recipient.frames.next();
	await sender.frames.next();
	expect(scheduler.pending).toBe(1);
	sender.socket.send(JSON.stringify({ type: "goodbye" }));
	expect(await sender.frames.next()).toEqual({ type: "goodbye" });
	expect(await recipient.frames.next()).toMatchObject({
		type: "presence_left",
		peer: { name: "sender" },
	});
	expect(scheduler.pending).toBe(0);
	expect(attempts).toBe(5);
	sender.socket.close();
	recipient.socket.close();
});

test("receiver retains outcomes and amortizes expiry work across a burst", async () => {
	const transport = await startTestTransport();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let injections = 0;
	let outcomeEntryVisits = 0;
	const NativeMap = globalThis.Map;
	class CountingMap<K, V> extends NativeMap<K, V> {
		override *[Symbol.iterator]() {
			for (const entry of super[Symbol.iterator]()) {
				const value = entry[1];
				if (
					typeof value === "object" &&
					value !== null &&
					"frame" in value &&
					"expiresAt" in value
				) {
					outcomeEntryVisits += 1;
				}
				yield entry;
			}
		}
	}
	const connecting = (() => {
		globalThis.Map = CountingMap as MapConstructor;
		try {
			return A2aConnection.connect({
				baseUrl: transport.baseUrl,
				project: "room",
				name: "receiver",
				events: {
					async onMessage() {
						injections += 1;
						started.resolve();
						await release.promise;
					},
				},
			});
		} finally {
			globalThis.Map = NativeMap;
		}
	})();
	const socket = await transport.socket;
	await transport.frames.next();
	socket.send(JSON.stringify(claimedFrame("receiver")));
	const connection = await connecting;
	const accepted = acceptedFrame("unused", "deduplicated-message");
	const retryFrame: ServerFrame = {
		type: "message",
		message: accepted.message,
	};
	socket.send(JSON.stringify(retryFrame));
	socket.send(JSON.stringify(retryFrame));
	await started.promise;
	expect(injections).toBe(1);
	release.resolve();
	expect(await transport.frames.next()).toEqual({
		type: "delivered",
		messageId: "deduplicated-message",
	});
	expect(await transport.frames.next()).toEqual({
		type: "delivered",
		messageId: "deduplicated-message",
	});
	socket.send(JSON.stringify(retryFrame));
	expect(await transport.frames.next()).toEqual({
		type: "delivered",
		messageId: "deduplicated-message",
	});
	expect(injections).toBe(1);
	const laterMessageCount = 512;
	for (let index = 0; index < laterMessageCount; index += 1) {
		const sequence = index + 2;
		socket.send(
			JSON.stringify({
				type: "message",
				message: {
					...accepted.message,
					messageId: `later-message-${index}`,
					messageRef: `room:${sequence}`,
					sequence,
					createdAt: sequence,
				},
			}),
		);
	}
	for (let index = 0; index < laterMessageCount; index += 1) {
		expect(await transport.frames.next()).toEqual({
			type: "delivered",
			messageId: `later-message-${index}`,
		});
	}
	expect(injections).toBe(laterMessageCount + 1);
	expect(outcomeEntryVisits).toBeLessThanOrEqual(laterMessageCount * 2);
	socket.send(JSON.stringify(retryFrame));
	expect(await transport.frames.next()).toEqual({
		type: "delivered",
		messageId: "deduplicated-message",
	});
	expect(injections).toBe(laterMessageCount + 1);
	const closing = connection.close();
	expect(await transport.frames.next()).toEqual({ type: "goodbye" });
	socket.send(JSON.stringify({ type: "goodbye" }));
	await closing;
});
