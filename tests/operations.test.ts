import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../src/hub/client";
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
	const client = new HubClient(hub.meta.baseUrl);
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
