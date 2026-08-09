import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../src/hub/client";
import type {
	A2aConnection,
	A2aConnectionEvents,
} from "../src/hub/connection";
import type { DeliveryEvent } from "../src/hub/realtime-types";
import { type HubServerHandle, startHubServer } from "../src/hub/server";
import { A2aRuntime, type MessageView } from "../src/operations";

const roots: string[] = [];
const hubs: HubServerHandle[] = [];

afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("one runtime path serves discovery, messaging, delivery, and history", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-runtime-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
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
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
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
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
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

test("connection stays bound to its HubClient and failed switches preserve it", async () => {
	const calls: string[] = [];
	const makeClient = (baseUrl: string) =>
		({
			baseUrl,
			async meta() {
				calls.push(`meta:${baseUrl}`);
				return { baseUrl };
			},
			async history() {
				calls.push(`history:${baseUrl}`);
				return { messages: [] };
			},
		}) as unknown as HubClient;
	const firstClient = makeClient("http://first");
	const secondClient = makeClient("http://second");
	let selected = firstClient;
	const closed: string[] = [];
	const connect = async (options: {
		baseUrl: string;
		project: string;
		name: string;
		events?: A2aConnectionEvents;
	}) => {
		if (options.name === "failure") throw new Error("candidate failed");
		return {
			project: options.project,
			name: options.name,
			self: { presenceId: `${options.baseUrl}:presence`, name: options.name },
			peers: () => [],
			close: async () => {
				closed.push(options.baseUrl);
				options.events?.onClose?.({
					manual: true,
					code: 1000,
					reason: "closed",
				});
			},
		} as unknown as A2aConnection;
	};
	const runtime = new A2aRuntime({
		getClient: async () => selected,
		connect,
	});

	await runtime.connect("project", "agent");
	selected = secondClient;
	await expect(runtime.connect("project", "failure")).rejects.toThrow(
		"candidate failed",
	);
	expect(runtime.connected).toBe(true);
	expect((await runtime.status()).hub.baseUrl).toBe("http://first");
	await runtime.history();
	expect(calls).toContain("history:http://first");

	await runtime.connect("project", "agent");
	expect(closed).toContain("http://first");
	expect((await runtime.status()).hub.baseUrl).toBe("http://second");
	await runtime.history();
	expect(calls).toContain("history:http://second");
});

test("latest concurrent transition wins and suppresses stale candidate events", async () => {
	const client = { baseUrl: "http://hub" } as HubClient;
	const candidates: Array<{
		options: {
			baseUrl: string;
			project: string;
			name: string;
			events?: A2aConnectionEvents;
		};
		resolve(connection: A2aConnection): void;
	}> = [];
	const closes: string[] = [];
	const events: string[] = [];
	const makeConnection = (
		name: string,
		options: { events?: A2aConnectionEvents },
	) =>
		({
			project: "project",
			name,
			self: { presenceId: `${name}:presence`, name },
			peers: () => [],
			close: async () => {
				closes.push(name);
				options.events?.onClose?.({
					manual: true,
					code: 1000,
					reason: "closed",
				});
			},
		}) as unknown as A2aConnection;
	const runtime = new A2aRuntime({
		getClient: async () => client,
		events: { onPresenceJoined: (peer) => events.push(peer.name) },
		connect: async (options) =>
			await new Promise<A2aConnection>((resolve) => {
				candidates.push({ options, resolve });
			}),
	});

	const stale = runtime.connect("project", "stale");
	await Promise.resolve();
	const latest = runtime.connect("project", "latest");
	await Promise.resolve();
	const latestCandidate = candidates.find(
		(candidate) => candidate.options.name === "latest",
	);
	if (!latestCandidate) throw new Error("latest candidate was not created");
	latestCandidate.resolve(makeConnection("latest", latestCandidate.options));
	await latest;
	const staleCandidate = candidates.find(
		(candidate) => candidate.options.name === "stale",
	);
	if (!staleCandidate) throw new Error("stale candidate was not created");
	staleCandidate.options.events?.onPresenceJoined?.({
		presenceId: "peer:presence",
		name: "stale-peer",
	});
	staleCandidate.resolve(makeConnection("stale", staleCandidate.options));
	await expect(stale).rejects.toThrow("superseded");
	expect(runtime.name).toBe("latest");
	expect(events).toEqual([]);
	expect(closes).toContain("stale");

	const disconnectRace = runtime.connect("project", "disconnect-race");
	await Promise.resolve();
	const disconnect = runtime.disconnect();
	const raceCandidate = candidates.find(
		(candidate) => candidate.options.name === "disconnect-race",
	);
	if (!raceCandidate) throw new Error("disconnect candidate was not created");
	raceCandidate.resolve(
		makeConnection("disconnect-race", raceCandidate.options),
	);
	await disconnect;
	await expect(disconnectRace).rejects.toThrow("superseded");
	expect(runtime.connected).toBe(false);
	expect(closes).toContain("disconnect-race");
});

test("a published candidate that closes during predecessor cleanup cannot report success", async () => {
	const client = { baseUrl: "http://hub" } as HubClient;
	let releasePreviousClose!: () => void;
	let markPreviousCloseStarted!: () => void;
	const previousCloseStarted = new Promise<void>((resolve) => {
		markPreviousCloseStarted = resolve;
	});
	const previousClose = new Promise<void>((resolve) => {
		releasePreviousClose = resolve;
	});
	let latestEvents: A2aConnectionEvents | undefined;
	const runtime = new A2aRuntime({
		getClient: async () => client,
		connect: async (options) => {
			const connection = {
				project: options.project,
				name: options.name,
				self: {
					presenceId: `${options.name}:presence`,
					name: options.name,
				},
				peers: () => [],
				close: async () => {
					if (options.name === "previous") {
						markPreviousCloseStarted();
						await previousClose;
					}
				},
			} as unknown as A2aConnection;
			if (options.name === "latest") latestEvents = options.events;
			return connection;
		},
	});

	await runtime.connect("project", "previous");
	const switching = runtime.connect("project", "latest");
	await previousCloseStarted;
	latestEvents?.onClose?.({
		manual: false,
		code: 1006,
		reason: "candidate lost",
	});
	releasePreviousClose();
	await expect(switching).rejects.toThrow("candidate lost");
	expect(runtime.connected).toBe(false);
});

test("disconnect aborts an in-flight connection handshake", async () => {
	const client = { baseUrl: "http://hub" } as HubClient;
	let resolveStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	let handshakeSignal: AbortSignal | undefined;
	const runtime = new A2aRuntime({
		getClient: async () => client,
		connect: async (options) =>
			await new Promise<A2aConnection>((_resolve, reject) => {
				handshakeSignal = options.signal;
				if (!options.signal)
					throw new Error("runtime did not provide a handshake signal");
				options.signal.addEventListener(
					"abort",
					() => reject(options.signal?.reason),
					{ once: true },
				);
				resolveStarted();
			}),
	});

	const connecting = runtime.connect("project", "stalled");
	await started;
	expect(await runtime.disconnect()).toBe(false);
	await expect(connecting).rejects.toThrow("superseded");
	expect(handshakeSignal?.aborted).toBe(true);
	expect(runtime.connected).toBe(false);
});

test("history forwards caller cancellation to the bound HubClient", async () => {
	const controller = new AbortController();
	let receivedSignal: AbortSignal | undefined;
	const client = {
		baseUrl: "http://hub",
		async history(_query: unknown, options: { signal?: AbortSignal }) {
			receivedSignal = options.signal;
			throw options.signal?.reason;
		},
	} as unknown as HubClient;
	const runtime = new A2aRuntime({
		getClient: async () => client,
		connect: async (options) =>
			({
				project: options.project,
				name: options.name,
				self: { presenceId: "presence", name: options.name },
				peers: () => [],
				close: async () => {},
			}) as unknown as A2aConnection,
	});
	await runtime.connect("project", "agent");
	const reason = new Error("cancelled by model");
	controller.abort(reason);
	await expect(runtime.history({}, { signal: controller.signal })).rejects.toBe(
		reason,
	);
	expect(receivedSignal).toBe(controller.signal);
});
