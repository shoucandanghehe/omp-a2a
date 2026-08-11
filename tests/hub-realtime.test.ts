import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { A2aConnection } from "../src/hub/connection";
import { HubClient } from "../src/hub/client";
import {
	decodeTextPayload,
	encodeTextPayload,
	MAX_TEXT_BYTES,
} from "../src/hub/payload";
import {
	A2A_PROTOCOL_VERSION,
	type ClientFrame,
	type ServerFrame,
} from "../src/hub/realtime-types";
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
	const server = createHttpServer();
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
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
	});
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		socket: connected.promise,
		frames,
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

function acceptedFrame(requestId: string, messageId: string): ServerFrame {
	return {
		type: "accepted",
		requestId,
		message: {
			messageId,
			messageRef: `room:${messageId}`,
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
	jest.useRealTimers();
	const cleanups = [
		...transports.splice(0),
		...hubs.splice(0).map((hub) => () => hub.stop()),
	];
	const outcomes = await Promise.allSettled(
		cleanups.map((cleanup) => cleanup()),
	);
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	const failedCleanup = outcomes.find((outcome) => outcome.status === "rejected");
	if (failedCleanup?.status === "rejected") throw failedCleanup.reason;
});

test("transport close releases Presence and allows name reuse", async () => {
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

test("direct messages and broadcasts target the current Presence snapshot", async () => {
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

test("client handshake timeout leaves no socket or Presence", async () => {
	const stalled = await startTestTransport();
	const timedOut = A2aConnection.connect({
		baseUrl: stalled.baseUrl,
		project: "room",
		name: "api",
		timeoutMs: 250,
	});
	const stalledSocket = await stalled.socket;
	const serverObservedClose = Promise.withResolvers<void>();
	stalledSocket.once("close", () => serverObservedClose.resolve());
	expect(await stalled.frames.next()).toMatchObject({ type: "hello" });
	await expect(timedOut).rejects.toThrow("handshake timed out");
	await serverObservedClose.promise;
});

test("caller abort leaves no socket or Presence", async () => {
	const abortedTransport = await startTestTransport();
	const inFlightController = new AbortController();
	const abortReason = new Error("caller cancelled handshake");
	const abortedHandshake = A2aConnection.connect({
		baseUrl: abortedTransport.baseUrl,
		project: "room",
		name: "api",
		signal: inFlightController.signal,
	});
	const abortedSocket = await abortedTransport.socket;
	const abortObservedClose = Promise.withResolvers<void>();
	abortedSocket.once("close", () => abortObservedClose.resolve());
	expect(await abortedTransport.frames.next()).toMatchObject({ type: "hello" });
	inFlightController.abort(abortReason);
	await expect(abortedHandshake).rejects.toBe(abortReason);
	await abortObservedClose.promise;

	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-abort-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "abort-room" });
	const preAborted = new AbortController();
	const preAbortReason = new Error("caller cancelled before handshake");
	preAborted.abort(preAbortReason);
	await expect(
		A2aConnection.connect({
			baseUrl: hub.meta.baseUrl,
			project: "abort-room",
			name: "api",
			signal: preAborted.signal,
		}),
	).rejects.toBe(preAbortReason);
	expect(await client.deleteProject("abort-room")).toBe(true);
});

test("a later handshake abort cannot replace the failure that won", async () => {
	for (const scenario of ["timeout", "protocol", "transport"] as const) {
		const transport = await startTestTransport();
		const controller = new AbortController();
		const lateAbort = new Error(`late abort after ${scenario} failure`);
		const connecting = A2aConnection.connect({
			baseUrl: transport.baseUrl,
			project: "room",
			name: scenario,
			signal: controller.signal,
			timeoutMs: scenario === "timeout" ? 20 : 5_000,
			events: {
				onClose: () => controller.abort(lateAbort),
			},
		});
		const socket = await transport.socket;
		expect(await transport.frames.next()).toMatchObject({ type: "hello" });

		if (scenario === "protocol") {
			socket.send(
				JSON.stringify({
					type: "error",
					code: "protocol_mismatch",
					message: "wrong protocol",
				}),
			);
		} else if (scenario === "transport") {
			socket.close(1011, "upstream failed");
		}

		const expected =
			scenario === "timeout"
				? "handshake timed out"
				: scenario === "protocol"
					? "protocol_mismatch: wrong protocol"
					: "A2A connection closed (1011): upstream failed";
		await expect(connecting).rejects.toThrow(expected);
		expect(controller.signal.aborted).toBe(true);
	}
});

test("connection lifecycle timeout overrides reject invalid and over-limit values", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-invalid-timeouts-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "invalid-timeouts" });
	const cases: Array<{
		label: string;
		options: {
			timeoutMs?: number;
			goodbyeTimeoutMs?: number;
			closeTimeoutMs?: number;
		};
	}> = [
		{ label: "timeoutMs", options: { timeoutMs: Number.NaN } },
		{ label: "goodbyeTimeoutMs", options: { goodbyeTimeoutMs: -1 } },
		{
			label: "closeTimeoutMs",
			options: { closeTimeoutMs: Number.POSITIVE_INFINITY },
		},
		{ label: "timeoutMs", options: { timeoutMs: 5_001 } },
		{ label: "goodbyeTimeoutMs", options: { goodbyeTimeoutMs: 1_001 } },
		{ label: "closeTimeoutMs", options: { closeTimeoutMs: 2_001 } },
	];

	for (const [index, { label, options }] of cases.entries()) {
		const outcome = await A2aConnection.connect({
			baseUrl: hub.meta.baseUrl,
			project: "invalid-timeouts",
			name: `invalid-${index}`,
			...options,
		}).then(
			(connection) => connection,
			(error: unknown) => error,
		);
		if (outcome instanceof A2aConnection) await outcome.close();
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toContain(label);
	}

	const atLimit = await A2aConnection.connect({
		baseUrl: hub.meta.baseUrl,
		project: "invalid-timeouts",
		name: "at-limit",
		timeoutMs: 5_000,
		goodbyeTimeoutMs: 1_000,
		closeTimeoutMs: 2_000,
	});
	await atLimit.close();
	expect(await client.deleteProject("invalid-timeouts")).toBe(true);
});

test("the Hub rejects non-exact goodbye without releasing Presence", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-exact-goodbye-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "exact-goodbye" });
	const api = await connect(hub.meta.baseUrl, "exact-goodbye", "api");
	await api.frames.next();

	api.socket.send(JSON.stringify({ type: "goodbye", unexpected: true }));
	expect(await api.frames.next()).toMatchObject({
		type: "error",
		code: "invalid_frame",
	});

	const duplicate = await connect(hub.meta.baseUrl, "exact-goodbye", "api");
	expect(await duplicate.frames.next()).toMatchObject({
		type: "error",
		code: "name_in_use",
	});
	duplicate.socket.terminate();

	const closed = Promise.withResolvers<void>();
	api.socket.once("close", () => closed.resolve());
	api.socket.send(JSON.stringify({ type: "goodbye" }));
	expect(await api.frames.next()).toEqual({ type: "goodbye" });
	await closed.promise;
});

test("the Hub closes transport after acknowledging goodbye", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-server-goodbye-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "server-goodbye" });
	const observer = await connect(
		hub.meta.baseUrl,
		"server-goodbye",
		"observer",
	);
	await observer.frames.next();
	const api = await connect(hub.meta.baseUrl, "server-goodbye", "api");
	await api.frames.next();
	await observer.frames.next();
	const closed = Promise.withResolvers<void>();
	api.socket.once("close", () => closed.resolve());

	api.socket.send(JSON.stringify({ type: "goodbye" }));
	expect(await api.frames.next()).toEqual({ type: "goodbye" });
	expect(await observer.frames.next()).toMatchObject({
		type: "presence_left",
		peer: { name: "api" },
	});
	await closed.promise;
	const observerClosed = Promise.withResolvers<void>();
	observer.socket.once("close", () => observerClosed.resolve());
	observer.socket.terminate();
	await observerClosed.promise;
});

test("the Hub terminates a transport whose close frames cannot reach the peer", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-server-terminate-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "server-terminate" });
	const observer = await connect(
		hub.meta.baseUrl,
		"server-terminate",
		"observer",
	);
	await observer.frames.next();
	const api = await connect(hub.meta.baseUrl, "server-terminate", "api");
	const closed = Promise.withResolvers<void>();
	api.socket.once("close", () => closed.resolve());
	expect(await api.frames.next()).toMatchObject({ type: "claimed" });
	await observer.frames.next();

	const closeSpy = spyOn(WebSocket.prototype, "close").mockImplementation(
		() => {},
	);
	try {
		jest.useFakeTimers();
		api.socket.send(JSON.stringify({ type: "goodbye" }));
		expect(await api.frames.next()).toEqual({ type: "goodbye" });
		expect(await observer.frames.next()).toMatchObject({
			type: "presence_left",
			peer: { name: "api" },
		});
		jest.advanceTimersByTime(2_001);
		await closed.promise;
	} finally {
		closeSpy.mockRestore();
	}

	const replacement = await connect(
		hub.meta.baseUrl,
		"server-terminate",
		"api",
	);
	expect(await replacement.frames.next()).toMatchObject({ type: "claimed" });
	replacement.socket.terminate();
	observer.socket.terminate();
});

test("client reports a non-exact goodbye acknowledgement", async () => {
	const transport = await startTestTransport();
	const protocolError = Promise.withResolvers<Error>();
	const connecting = A2aConnection.connect({
		baseUrl: transport.baseUrl,
		project: "room",
		name: "api",
		goodbyeTimeoutMs: 50,
		closeTimeoutMs: 50,
		events: { onError: (error) => protocolError.resolve(error) },
	});
	const socket = await transport.socket;
	await transport.frames.next();
	socket.send(JSON.stringify(claimedFrame("api")));
	const connection = await connecting;

	socket.send(JSON.stringify({ type: "goodbye", unexpected: true }));
	await protocolError.promise;

	const closing = connection.close();
	expect(await transport.frames.next()).toEqual({ type: "goodbye" });
	socket.send(JSON.stringify({ type: "goodbye" }));
	await closing;
}, 2_000);

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
	const observerClosed = Promise.withResolvers<void>();
	observer.socket.once("close", () => observerClosed.resolve());
	observer.socket.send(JSON.stringify({ type: "goodbye" }));
	expect(await observer.frames.next()).toEqual({ type: "goodbye" });
	await observerClosed.promise;
	expect(await client.deleteProject("goodbye-room")).toBe(true);
});

test("close completes normally when the peer omits its goodbye acknowledgement", async () => {
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
	await closing;
	expect((await closed.promise).code).toBe(1000);
});

test("client termination bounds a close whose frames cannot reach the Hub", async () => {
	const transport = await startTestTransport();
	const closeEvents: Array<{
		manual: boolean;
		code: number;
		reason: string;
	}> = [];
	const connection = await (async () => {
		const connecting = A2aConnection.connect({
			baseUrl: transport.baseUrl,
			project: "room",
			name: "api",
			goodbyeTimeoutMs: 25,
			closeTimeoutMs: 25,
			events: { onClose: (event) => closeEvents.push(event) },
		});
		const socket = await transport.socket;
		await transport.frames.next();
		socket.send(JSON.stringify(claimedFrame("api")));
		return await connecting;
	})();
	const pendingOutcome = connection
		.send(
			{ target: { type: "project" }, text: "never receives an outcome" },
			{ timeoutMs: 500 },
		)
		.catch((error: unknown) => error);
	await transport.frames.next();

	const closeSpy = spyOn(WebSocket.prototype, "close").mockImplementation(
		() => {},
	);
	try {
		jest.useFakeTimers();
		const closing = connection.close();
		expect(await transport.frames.next()).toEqual({ type: "goodbye" });
		jest.advanceTimersByTime(26);
		await Promise.resolve();
		jest.advanceTimersByTime(26);
		await closing;
	} finally {
		closeSpy.mockRestore();
	}
	const pendingFailure = await pendingOutcome;
	expect(pendingFailure).toBeInstanceOf(Error);
	expect((pendingFailure as Error).message).toContain(
		"the WebSocket closed (1006: WebSocket close timed out after 25ms)",
	);
	expect(closeEvents).toEqual([
		{
			manual: true,
			code: 1006,
			reason: "WebSocket close timed out after 25ms",
		},
	]);
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
	const abortedFrame = await transport.frames.next();
	if (abortedFrame.type !== "message")
		throw new Error("expected aborted message request");
	controller.abort();
	await expect(aborted).rejects.toThrow("outcomes are unknown");
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
	const timedOutFrame = await transport.frames.next();
	if (timedOutFrame.type !== "message")
		throw new Error("expected timed out message request");
	await expect(timedOut).rejects.toThrow("outcomes are unknown");
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

test("message timeout overrides reject invalid and over-limit values before dispatch", async () => {
	const transport = await startTestTransport();
	const connecting = A2aConnection.connect({
		baseUrl: transport.baseUrl,
		project: "room",
		name: "api",
		goodbyeTimeoutMs: 50,
		closeTimeoutMs: 50,
	});
	const socket = await transport.socket;
	await transport.frames.next();
	socket.send(JSON.stringify(claimedFrame("api")));
	const connection = await connecting;
	socket.on("message", (data) => {
		const frame = JSON.parse(data.toString()) as ClientFrame;
		if (frame.type === "message")
			socket.send(
				JSON.stringify(acceptedFrame(frame.requestId, frame.messageId)),
			);
	});

	for (const timeoutMs of [Number.NaN, 15_001]) {
		const outcome = await connection
			.send(
				{
					target: { type: "project" },
					text: "invalid timeout",
					messageId: `invalid-timeout-${String(timeoutMs)}`,
				},
				{ timeoutMs },
			)
			.then(
				(value) => value,
				(error: unknown) => error,
			);
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toContain(
			Number.isNaN(timeoutMs) ? "finite positive" : "must not exceed 15000ms",
		);
	}

	const valid = connection.send(
		{
			target: { type: "project" },
			text: "valid timeout",
			messageId: "valid-after-invalid",
		},
		{ timeoutMs: 15_000 },
	);
	const validFrame = await transport.frames.next();
	expect(validFrame).toMatchObject({
		type: "message",
		messageId: "valid-after-invalid",
	});
	if (validFrame.type !== "message")
		throw new Error("expected valid message request");
	await valid;

	const closing = connection.close();
	expect(await transport.frames.next()).toEqual({ type: "goodbye" });
	socket.send(JSON.stringify({ type: "goodbye" }));
	await closing;
});

test("send returns a rejected Promise when payload encoding fails", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-send-rejection-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "send-rejection" });
	const connection = await A2aConnection.connect({
		baseUrl: hub.meta.baseUrl,
		project: "send-rejection",
		name: "api",
	});
	let sending: Promise<unknown> | undefined;

	expect(() => {
		sending = connection.send({
			target: { type: "project" },
			text: "x".repeat(MAX_TEXT_BYTES + 1),
			messageId: "oversized-message",
		});
	}).not.toThrow();
	expect(sending).toBeInstanceOf(Promise);
	await expect(sending).rejects.toThrow(
		`message text exceeds ${MAX_TEXT_BYTES} bytes`,
	);
	await connection.close();
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
