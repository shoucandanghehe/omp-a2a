import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../src/hub/client";
import { startHubServer, type HubServerHandle } from "../src/hub/server";

const roots: string[] = [];
const hubs: HubServerHandle[] = [];

afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Inbox messages survive Hub restart and remain until acknowledged", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const first = await startHubServer({ port: 0, dataDir });
	hubs.push(first);
	const sender = new HubClient(first.meta.baseUrl);
	await sender.createProject({ name: "durable" });
	await sender.register({ project: "durable", agentId: "worker", cwd: "/worker", pid: 1 });
	const sent = await sender.send({ project: "durable", from: "controller", to: "worker", text: "persist me" });
	await first.stop();

	const second = await startHubServer({ port: 0, dataDir });
	hubs.push(second);
	const receiver = new HubClient(second.meta.baseUrl);
	expect((await receiver.inbox("durable", "worker")).map((message) => message.msgId)).toEqual([sent.msgId]);
	await receiver.ack("durable", "worker", [sent.msgId]);
	expect(await receiver.inbox("durable", "worker")).toEqual([]);
});

test("Inbox has no message-count cap", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "uncapped" });
	await client.register({ project: "uncapped", agentId: "worker", cwd: "/worker", pid: 1 });

	await Promise.all(
		Array.from({ length: 201 }, (_, index) =>
			client.send({ project: "uncapped", from: "controller", to: "worker", text: `message-${index}` }),
		),
	);

	expect(await client.inbox("uncapped", "worker")).toHaveLength(201);
});

test("large text is gzip-compressed on the custom Mesh wire and decoded by HubClient", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "compressed" });
	await client.register({ project: "compressed", agentId: "worker", cwd: "/worker", pid: 1 });
	const text = "compressible payload ".repeat(2_000);
	await client.send({ project: "compressed", from: "controller", to: "worker", text });

	const response = await fetch(`${hub.meta.baseUrl}/v1/inbox?project=compressed&agentId=worker`);
	const wire = (await response.json()) as {
		messages: Array<{ payload?: { encoding?: string; data?: string } }>;
	};
	expect(wire.messages[0]?.payload?.encoding).toBe("gzip+base64");
	expect(wire.messages[0]?.payload?.data?.length ?? Infinity).toBeLessThan(Buffer.byteLength(text));
	expect((await client.inbox("compressed", "worker"))[0]?.text).toBe(text);
});

test("small text stays uncompressed and decoded text is capped at 4 MiB", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "payload-limits" });
	await client.register({ project: "payload-limits", agentId: "worker", cwd: "/worker", pid: 1 });
	await client.send({ project: "payload-limits", from: "controller", to: "worker", text: "small" });

	const response = await fetch(`${hub.meta.baseUrl}/v1/inbox?project=payload-limits&agentId=worker`);
	const wire = (await response.json()) as {
		messages: Array<{ payload?: { encoding?: string } }>;
	};
	expect(wire.messages[0]?.payload?.encoding).toBe("identity");
	await expect(
		client.send({
			project: "payload-limits",
			from: "controller",
			to: "worker",
			text: "x".repeat(4 * 1024 * 1024 + 1),
		}),
	).rejects.toThrow("exceeds 4194304 bytes");
});
