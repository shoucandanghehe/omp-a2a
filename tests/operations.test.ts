import { afterEach, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { HubClient } from "../src/hub/client";
import { A2aConnection } from "../src/hub/connection";
import {
	A2A_PROTOCOL_VERSION,
	type DeliveryEvent,
} from "../src/hub/realtime-types";
import { type HubServerHandle, startHubServer } from "../src/hub/server";
import { A2aRuntime, type MessageView } from "../src/operations";

const roots: string[] = [];
const hubs: HubServerHandle[] = [];
const transportStops: Array<() => Promise<void>> = [];
type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
};
afterEach(async () => {
	await Promise.all(transportStops.splice(0).map((stop) => stop()));
	await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("one runtime path serves discovery, messaging, delivery, and history", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-runtime-"));
	roots.push(dataDir);
	const hub = await startHubServer({
		host: "127.0.0.1",
		port: 0,
		dataDir,
	});
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "runtime" });

	let resolveMessage!: (message: MessageView) => void;
	const received = new Promise<MessageView>((resolve) => {
		resolveMessage = resolve;
	});
	let resolveJoined!: () => void;
	const joined = new Promise<void>((resolve) => {
		resolveJoined = resolve;
	});
	let resolveDelivery!: (delivery: DeliveryEvent) => void;
	const delivered = new Promise<DeliveryEvent>((resolve) => {
		resolveDelivery = resolve;
	});
	const api = new A2aRuntime({
		getClient: async () => client,
		events: {
			onDelivery: resolveDelivery,
			onPresenceJoined: () => resolveJoined(),
		},
	});
	const web = new A2aRuntime({
		getClient: async () => client,
		events: { onMessage: resolveMessage },
	});
	expect(await api.status()).toEqual({
		hub: {
			baseUrl: hub.listenUrl,
			protocolVersion: A2A_PROTOCOL_VERSION,
		},
		connection: null,
	});

	await api.connect("runtime", "api");
	await web.connect("runtime", "web");
	await joined;
	expect(api.peers().map((peer) => peer.name)).toEqual(["web"]);

	const accepted = await api.message({
		target: { type: "agent", name: "web" },
		text: "check login",
		messageId: "runtime-message",
	});
	expect(accepted).toMatchObject({
		replayed: false,
		message: { messageRef: "runtime:1" },
		recipients: ["web"],
	});
	expect(await received).toMatchObject({
		from: { name: "api" },
		text: "check login",
	});
	await expect(
		api.message({ target: { type: "agent", name: "api" }, text: "self" }),
	).rejects.toThrow("cannot send to yourself");
	expect(await delivered).toEqual({
		messageId: "runtime-message",
		to: "web",
		status: "delivered",
	});
	expect(await api.history()).toMatchObject([
		{ messageRef: "runtime:1", text: "check login" },
	]);

	await web.disconnect();
	const replayed = await api.message({
		target: { type: "agent", name: "web" },
		text: "check login",
		messageId: "runtime-message",
	});
	expect(replayed).toEqual({
		replayed: true,
		message: accepted.message,
	});
	await expect(
		api.message({
			target: { type: "agent", name: "web" },
			text: "are you there",
		}),
	).rejects.toThrow("recipient_not_present");
	await api.disconnect();
});

test("receiver injection completes in Hub message order", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-runtime-order-"));
	roots.push(dataDir);
	const hub = await startHubServer({
		host: "127.0.0.1",
		port: 0,
		dataDir,
	});
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "runtime-order" });

	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const barrierObserved = Promise.withResolvers<void>();
	const bothDelivered = Promise.withResolvers<void>();
	const injected: string[] = [];
	const deliveries: string[] = [];
	let activeInjections = 0;
	let maxActiveInjections = 0;
	const api = new A2aRuntime({
		getClient: async () => client,
		events: {
			onDelivery: (delivery) => {
				deliveries.push(delivery.messageId);
				if (deliveries.length === 2) bothDelivered.resolve();
			},
		},
	});
	const web = new A2aRuntime({
		getClient: async () => client,
		events: {
			onPresenceJoined: (peer) => {
				if (peer.name === "barrier") barrierObserved.resolve();
			},
			onMessage: async (message) => {
				activeInjections += 1;
				maxActiveInjections = Math.max(maxActiveInjections, activeInjections);
				if (message.text === "first") {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				injected.push(message.text);
				activeInjections -= 1;
			},
		},
	});
	const barrier = new A2aRuntime({
		getClient: async () => client,
		events: {},
	});

	await api.connect("runtime-order", "api");
	await web.connect("runtime-order", "web");
	await api.message({
		target: { type: "agent", name: "web" },
		text: "first",
		messageId: "ordered-first",
	});
	await firstStarted.promise;
	await api.message({
		target: { type: "agent", name: "web" },
		text: "second",
		messageId: "ordered-second",
	});
	await barrier.connect("runtime-order", "barrier");
	await barrierObserved.promise;
	releaseFirst.resolve();
	await bothDelivered.promise;

	expect(maxActiveInjections).toBe(1);
	expect(injected).toEqual(["first", "second"]);
	expect(deliveries).toEqual(["ordered-first", "ordered-second"]);

	await barrier.disconnect();
	await web.disconnect();
	await api.disconnect();
});

test("receiver injection failure produces a terminal failed delivery", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-runtime-failure-"));
	roots.push(dataDir);
	const hub = await startHubServer({
		host: "127.0.0.1",
		port: 0,
		dataDir,
	});
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "runtime-failure" });
	const delivery = Promise.withResolvers<DeliveryEvent>();
	const api = new A2aRuntime({
		getClient: async () => client,
		events: { onDelivery: delivery.resolve },
	});
	const web = new A2aRuntime({
		getClient: async () => client,
		events: {
			onMessage: () => {
				throw new Error("receiver disk full");
			},
			onError() {},
		},
	});

	await api.connect("runtime-failure", "api");
	await web.connect("runtime-failure", "web");
	const accepted = await api.message({
		target: { type: "agent", name: "web" },
		text: "persist despite failed injection",
		messageId: "failed-delivery",
	});
	expect(accepted.replayed).toBe(false);
	expect(accepted.message.messageRef).toBe("runtime-failure:1");
	expect(await delivery.promise).toEqual({
		messageId: "failed-delivery",
		to: "web",
		status: "failed",
		error: "receiver disk full",
	});
	expect(await api.history()).toMatchObject([
		{
			messageId: "failed-delivery",
			text: "persist despite failed injection",
		},
	]);

	await web.disconnect();
	await api.disconnect();
});

test("runtime HTTP operations preserve caller cancellation", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-runtime-cancel-"));
	roots.push(dataDir);
	const hub = await startHubServer({ host: "127.0.0.1", port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "runtime-cancel" });
	const api = new A2aRuntime({ getClient: async () => client });
	await api.connect("runtime-cancel", "api");
	const controller = new AbortController();
	const reason = new Error("caller cancelled runtime HTTP work");
	controller.abort(reason);
	const options = { signal: controller.signal };

	await expect(api.history({}, options)).rejects.toBe(reason);
	await expect(api.status(options)).rejects.toBe(reason);
	await expect(
		api.createProject({ name: "should-not-exist" }, options),
	).rejects.toBe(reason);
	await expect(api.listProjects(options)).rejects.toBe(reason);
	await expect(api.deleteProject("runtime-cancel", options)).rejects.toBe(reason);
	await api.disconnect();
});

test("pre-dispatch message abort sends nothing to history", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-runtime-abort-"));
	roots.push(dataDir);
	const hub = await startHubServer({ host: "127.0.0.1", port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "runtime-abort" });
	const api = new A2aRuntime({
		getClient: async () => client,
		events: {},
	});
	await api.connect("runtime-abort", "api");
	const controller = new AbortController();
	controller.abort();
	await expect(
		api.message(
			{
				target: { type: "project" },
				text: "must not persist",
				messageId: "pre-aborted",
			},
			{ signal: controller.signal },
		),
	).rejects.toThrow("aborted before dispatch");
	expect(await api.history()).toEqual([]);
	await api.disconnect();
});

test("published connection keeps its Hub binding until a replacement succeeds", async () => {
	const firstRoot = mkdtempSync(join(tmpdir(), "omp-a2a-runtime-first-hub-"));
	const secondRoot = mkdtempSync(join(tmpdir(), "omp-a2a-runtime-second-hub-"));
	roots.push(firstRoot, secondRoot);
	const firstHub = await startHubServer({ host: "127.0.0.1", port: 0, dataDir: firstRoot });
	const secondHub = await startHubServer({ host: "127.0.0.1", port: 0, dataDir: secondRoot });
	hubs.push(firstHub, secondHub);
	const firstClient = new HubClient(firstHub.listenUrl);
	const secondClient = new HubClient(secondHub.listenUrl);
	await firstClient.createProject({ name: "hub-binding" });
	await secondClient.createProject({ name: "hub-binding" });

	const firstSignal = Promise.withResolvers<AbortSignal>();
	const secondSignal = Promise.withResolvers<AbortSignal>();
	let signalCount = 0;
	let selectedClient = firstClient;
	const runtime = new A2aRuntime({
		getClient: async () => selectedClient,
		events: {
			onMessage: (_message, signal) => {
				signalCount += 1;
				(signalCount === 1 ? firstSignal : secondSignal).resolve(signal);
			},
		},
	});
	const conflict = new A2aRuntime({
		getClient: async () => secondClient,
	});
	const firstPeer = new A2aRuntime({
		getClient: async () => firstClient,
	});
	const secondPeer = new A2aRuntime({
		getClient: async () => secondClient,
	});
	await runtime.connect("hub-binding", "worker");
	await conflict.connect("hub-binding", "worker");
	await firstPeer.connect("hub-binding", "sender");
	await firstPeer.message({
		target: { type: "agent", name: "worker" },
		text: "first lifecycle",
	});
	const oldSignal = await firstSignal.promise;

	selectedClient = secondClient;
	await expect(runtime.connect("hub-binding", "worker")).rejects.toThrow(
		"name_in_use",
	);
	expect(oldSignal.aborted).toBe(false);
	expect(await runtime.status()).toMatchObject({
		hub: { baseUrl: firstHub.listenUrl },
		connection: { project: "hub-binding", name: "worker" },
	});

	await conflict.disconnect();
	const replacement = await runtime.connect("hub-binding", "worker");
	expect(replacement.presenceId).not.toBe("");
	expect(oldSignal.aborted).toBe(true);
	expect(await runtime.status()).toMatchObject({
		hub: { baseUrl: secondHub.listenUrl },
		connection: { project: "hub-binding", name: "worker" },
	});

	await secondPeer.connect("hub-binding", "sender");
	await secondPeer.message({
		target: { type: "agent", name: "worker" },
		text: "second lifecycle",
	});
	const currentSignal = await secondSignal.promise;
	expect(currentSignal.aborted).toBe(false);
	await runtime.disconnect();
	expect(currentSignal.aborted).toBe(true);
	await firstPeer.disconnect();
	await secondPeer.disconnect();
});

test("superseding a same-name connect waits for the prior candidate teardown", async () => {
	const server = createServer();
	const webSockets = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		webSockets.handleUpgrade(request, socket, head, (webSocket) => {
			webSockets.emit("connection", webSocket, request);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	transportStops.push(async () => {
		for (const socket of webSockets.clients) socket.terminate();
		webSockets.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const firstHello = Promise.withResolvers<void>();
	let helloCount = 0;
	let presence = 0;
	webSockets.on("connection", (socket) => {
		socket.on("message", (data) => {
			const frame = JSON.parse(data.toString()) as {
				type: string;
				project?: string;
				name?: string;
			};
			if (frame.type !== "hello" || !frame.project || !frame.name) return;
			helloCount += 1;
			if (helloCount === 1) {
				firstHello.resolve();
				return;
			}
			presence += 1;
			socket.send(
				JSON.stringify({
					type: "claimed",
					protocolVersion: 3,
					project: frame.project,
					self: { name: frame.name, presenceId: `presence-${presence}` },
					peers: [],
				}),
			);
		});
	});

	let clientRequests = 0;
	let supersededSettled = false;
	const runtime = new A2aRuntime({
		getClient: async () => {
			clientRequests += 1;
			if (clientRequests > 1 && !supersededSettled)
				throw new Error(
					"replacement requested a Hub client before candidate teardown",
				);
			return new HubClient(baseUrl);
		},
	});
	const superseded = runtime.connect("same-name", "worker");
	const supersededFailure = superseded.then(
		() => {
			supersededSettled = true;
			return undefined;
		},
		(error) => {
			supersededSettled = true;
			return error;
		},
	);
	await firstHello.promise;

	const replacement = await runtime.connect("same-name", "worker");
	expect(replacement).toMatchObject({
		project: "same-name",
		name: "worker",
	});
	expect(await supersededFailure).toBeInstanceOf(Error);
	await runtime.disconnect();
});

test("reverse disconnect overlap retains the teardown barrier before reconnect", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-runtime-teardown-"));
	roots.push(dataDir);
	const hub = await startHubServer({ host: "127.0.0.1", port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "teardown-barrier" });

	let clientRequests = 0;
	const runtime = new A2aRuntime({
		getClient: async () => {
			clientRequests += 1;
			return client;
		},
	});
	await runtime.connect("teardown-barrier", "worker");
	expect(clientRequests).toBe(1);

	const closeStarted = Promise.withResolvers<void>();
	const releaseClose = Promise.withResolvers<void>();
	const originalClose = A2aConnection.prototype.close;
	let holdClose = true;
	const closeSpy = vi
		.spyOn(A2aConnection.prototype, "close")
		.mockImplementation(async function (this: A2aConnection) {
			if (holdClose && this.project === "teardown-barrier") {
				closeStarted.resolve();
				await releaseClose.promise;
			}
			return await originalClose.call(this);
		});

	try {
		const disconnect = runtime.disconnect();
		await closeStarted.promise;
		let secondDisconnectSettled = false;
		const secondDisconnect = runtime.disconnect().then((connected) => {
			secondDisconnectSettled = true;
			return connected;
		});
		const reconnect = runtime.connect("teardown-barrier", "worker");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(secondDisconnectSettled).toBe(false);
		expect(clientRequests).toBe(1);

		holdClose = false;
		releaseClose.resolve();
		expect(await disconnect).toBe(true);
		expect(await secondDisconnect).toBe(false);
		expect(await reconnect).toMatchObject({
			project: "teardown-barrier",
			name: "worker",
		});
		expect(clientRequests).toBe(2);
	} finally {
		holdClose = false;
		releaseClose.resolve();
		closeSpy.mockRestore();
		await runtime.disconnect();
	}
});

test("only the latest connection transition can publish or emit events", async () => {
	const server = createServer();
	const webSockets = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		webSockets.handleUpgrade(request, socket, head, (webSocket) => {
			webSockets.emit("connection", webSocket, request);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	transportStops.push(async () => {
		for (const socket of webSockets.clients) socket.terminate();
		webSockets.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const sockets = new Map<string, WebSocket>();
	const socketWaiters = new Map<string, Deferred<WebSocket>>();
	const closeWaiters = new Map<string, Deferred<void>>();
	const socketFor = (name: string): Promise<WebSocket> => {
		const socket = sockets.get(name);
		if (socket) return Promise.resolve(socket);
		const waiter = Promise.withResolvers<WebSocket>();
		socketWaiters.set(name, waiter);
		return waiter.promise;
	};
	const closedFor = (name: string): Promise<void> => {
		const waiter = Promise.withResolvers<void>();
		closeWaiters.set(name, waiter);
		return waiter.promise;
	};
	const claim = (socket: WebSocket, project: string, name: string) => {
		socket.send(
			JSON.stringify({
				type: "claimed",
				protocolVersion: 3,
				project,
				self: { name, presenceId: `${name}-presence` },
				peers: [],
			}),
		);
	};
	webSockets.on("connection", (socket) => {
		let name: string | undefined;
		socket.on("message", (data) => {
			const frame = JSON.parse(data.toString()) as {
				type: string;
				project?: string;
				name?: string;
				messageId?: string;
			};
			if (
				(frame.type === "delivered" || frame.type === "delivery_failed") &&
				frame.messageId === "candidate-message"
			) {
				candidateOutcome.resolve(frame);
				return;
			}
			if (frame.type !== "hello" || !frame.project || !frame.name) return;
			name = frame.name;
			sockets.set(name, socket);
			socketWaiters.get(name)?.resolve(socket);
			if (name === "latest") claim(socket, frame.project, name);
		});
		socket.on("close", () => {
			if (name) closeWaiters.get(name)?.resolve();
		});
	});

	const candidateOutcome = Promise.withResolvers<{
		type: string;
		messageId?: string;
	}>();

	const joined: string[] = [];
	const currentJoined = Promise.withResolvers<void>();
	const closes: Array<{ manual: boolean }> = [];
	const runtime = new A2aRuntime({
		getClient: async () => new HubClient(baseUrl),
		events: {
			onPresenceJoined: (peer) => {
				joined.push(peer.name);
				if (peer.name === "current-peer") currentJoined.resolve();
			},
			onClose: (event) => closes.push(event),
		},
	});

	const slowConnect = runtime.connect("transitions", "slow");
	const slowFailure = slowConnect.catch((error) => error);
	const slowSocket = await socketFor("slow");
	slowSocket.send(
		JSON.stringify({
			type: "message",
			message: {
				messageId: "candidate-message",
				messageRef: "transitions:1",
				project: "transitions",
				sequence: 1,
				from: { name: "sender", presenceId: "sender-presence" },
				target: {
					type: "agent",
					name: "slow",
					presenceId: "slow-presence",
				},
				payload: {
					encoding: "identity",
					data: "must not be falsely acknowledged",
				},
				attachments: [],
				createdAt: 1,
			},
		}),
	);
	expect(await candidateOutcome.promise).toMatchObject({
		type: "delivery_failed",
		messageId: "candidate-message",
	});
	slowSocket.send(
		JSON.stringify({
			type: "presence_joined",
			peer: { name: "candidate-peer", presenceId: "candidate-peer-presence" },
		}),
	);
	const latest = await runtime.connect("transitions", "latest");
	expect(latest.presenceId).toBe("latest-presence");
	if (slowSocket.readyState === WebSocket.OPEN)
		claim(slowSocket, "transitions", "slow");
	expect(await slowFailure).toBeInstanceOf(Error);

	const latestSocket = await socketFor("latest");
	latestSocket.send(
		JSON.stringify({
			type: "presence_joined",
			peer: { name: "current-peer", presenceId: "current-peer-presence" },
		}),
	);
	await currentJoined.promise;
	expect(runtime.name).toBe("latest");
	expect(joined).toEqual(["current-peer"]);

	const pendingConnect = runtime.connect("transitions", "never");
	const pendingFailure = pendingConnect.catch((error) => error);
	await socketFor("never");
	const pendingClosed = closedFor("never");
	expect(await runtime.disconnect()).toBe(true);
	await pendingClosed;
	expect(await pendingFailure).toBeInstanceOf(Error);
	expect(runtime.connected).toBe(false);
	expect(closes).toEqual([]);
});
