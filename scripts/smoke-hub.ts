import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HubClient } from "../src/hub/client";
import { A2aConnection } from "../src/hub/connection";
import { decodeTextPayload } from "../src/hub/payload";
import type { DeliveryEvent, RealtimeMessage } from "../src/hub/realtime-types";
import { type HubServerHandle, startHubServer } from "../src/hub/server";

const firstDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-a2a-hub-a-"));
const secondDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-a2a-hub-b-"));
const handles: HubServerHandle[] = [];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERT: ${message}`);
}

class AsyncQueue<T> {
	#values: T[] = [];
	#waiters: Array<(value: T) => void> = [];

	push(value: T): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter(value);
		else this.#values.push(value);
	}

	next(): Promise<T> {
		const value = this.#values.shift();
		if (value) return Promise.resolve(value);
		return new Promise<T>((resolve) => this.#waiters.push(resolve));
	}
}

async function main() {
	console.log("\n== independent Hubs ==");
	const first = await startHubServer({ dataDir: firstDataDir, port: 0 });
	const second = await startHubServer({ dataDir: secondDataDir, port: 0 });
	handles.push(first, second);
	const client = new HubClient(first.meta.baseUrl);
	const otherClient = new HubClient(second.meta.baseUrl);
	await client.createProject({ name: "mesh-demo" });
	assert(
		(await otherClient.listProjects()).length === 0,
		"Hub Projects are isolated",
	);
	const joined = new AsyncQueue<string>();

	console.log("\n== realtime Presence ==");
	const deliveries = new AsyncQueue<DeliveryEvent>();
	const webMessages = new AsyncQueue<RealtimeMessage>();
	const testMessages = new AsyncQueue<RealtimeMessage>();
	const api = await A2aConnection.connect({
		baseUrl: first.meta.baseUrl,
		project: "mesh-demo",
		name: "api",
		events: {
			onDelivery: (delivery) => deliveries.push(delivery),
			onPresenceJoined: (peer) => joined.push(peer.name),
		},
	});
	const web = await A2aConnection.connect({
		baseUrl: first.meta.baseUrl,
		project: "mesh-demo",
		name: "web",
		events: { onMessage: (message) => webMessages.push(message) },
	});
	assert((await joined.next()) === "web", "web join is announced");
	const test = await A2aConnection.connect({
		baseUrl: first.meta.baseUrl,
		project: "mesh-demo",
		name: "test",
		events: { onMessage: (message) => testMessages.push(message) },
	});
	assert((await joined.next()) === "test", "test join is announced");
	assert(
		api
			.peers()
			.map((peer) => peer.name)
			.join(",") === "test,web",
		"Presence snapshot is current",
	);

	console.log("\n== direct message and delivery ==");
	const direct = await api.send({
		target: { type: "agent", name: "web" },
		text: "hello",
		messageId: "smoke-direct",
	});
	assert(
		direct.message.messageRef === "mesh-demo:1",
		"direct message receives Project sequence",
	);
	assert(
		decodeTextPayload((await webMessages.next()).payload) === "hello",
		"direct message arrives in realtime",
	);
	assert(
		(await deliveries.next()).status === "delivered",
		"receiver acknowledgment becomes delivery event",
	);

	console.log("\n== Project broadcast ==");
	const broadcast = await api.send({
		target: { type: "project" },
		text: "freeze contract",
		messageId: "smoke-broadcast",
	});
	assert(
		broadcast.replayed === false,
		"new broadcast is not an idempotent replay",
	);
	assert(
		broadcast.recipients.join(",") === "web,test",
		"broadcast freezes the current Presence snapshot",
	);
	assert(
		decodeTextPayload((await webMessages.next()).payload) === "freeze contract",
		"web receives broadcast",
	);
	assert(
		decodeTextPayload((await testMessages.next()).payload) ===
			"freeze contract",
		"test receives broadcast",
	);
	await deliveries.next();
	await deliveries.next();

	console.log("\n== persistent message history ==");
	await api.close();
	await web.close();
	await test.close();
	await first.stop();
	const restarted = await startHubServer({ dataDir: firstDataDir, port: 0 });
	handles.push(restarted);
	const restartedClient = new HubClient(restarted.meta.baseUrl);
	const history = await restartedClient.history({
		project: "mesh-demo",
		limit: 10,
	});
	assert(history.messages.length === 2, "history survives Hub restart");
	const replacement = await A2aConnection.connect({
		baseUrl: restarted.meta.baseUrl,
		project: "mesh-demo",
		name: "web",
	});
	assert(
		replacement.peers().length === 0,
		"Presence does not survive Hub restart",
	);

	console.log("\n== safe Project deletion ==");
	let activeDeleteRejected = false;
	try {
		await restartedClient.deleteProject("mesh-demo");
	} catch {
		activeDeleteRejected = true;
	}
	assert(activeDeleteRejected, "active Presence blocks Project deletion");
	await replacement.close();
	assert(
		await restartedClient.deleteProject("mesh-demo"),
		"inactive Project deletes with its history",
	);
	assert(
		!(await restartedClient.deleteProject("mesh-demo")),
		"Project deletion is idempotent",
	);

	console.log("\n== PASS ==");
	console.log("Realtime Agent chat Hub smoke OK");
}

main()
	.catch((error) => {
		console.error("\nHUB SMOKE FAILED:", error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await Promise.all(handles.splice(0).map((handle) => handle.stop()));
		if (process.exitCode) {
			console.error(`left smoke data at ${firstDataDir} and ${secondDataDir}`);
		} else {
			fs.rmSync(firstDataDir, { recursive: true, force: true });
			fs.rmSync(secondDataDir, { recursive: true, force: true });
		}
	});
