import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { HubClient } from "../src/hub/client";
import { decodeTextPayload, encodeTextPayload } from "../src/hub/payload";
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
