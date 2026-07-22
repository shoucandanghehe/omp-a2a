import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
	const sender = new HubClient(first.listenUrl);
	await sender.createProject({ name: "durable" });
	const registration = await sender.register({ project: "durable", agentId: "worker", cwd: "/worker", pid: 1 });
	const sent = await sender.send({ project: "durable", from: "controller", to: "worker", text: "persist me" });
	await first.stop();

	const second = await startHubServer({ port: 0, dataDir });
	hubs.push(second);
	const receiver = new HubClient(second.listenUrl);
	expect((await receiver.inbox("durable", "worker", 500, registration.leaseId)).map((message) => message.msgId)).toEqual([
		sent.msgId,
	]);
	await receiver.ack("durable", "worker", [sent.msgId], registration.leaseId);
	expect(await receiver.inbox("durable", "worker", 500, registration.leaseId)).toEqual([]);
});

test("Inbox has no message-count cap", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "uncapped" });
	const registration = await client.register({ project: "uncapped", agentId: "worker", cwd: "/worker", pid: 1 });

	await Promise.all(
		Array.from({ length: 201 }, (_, index) =>
			client.send({ project: "uncapped", from: "controller", to: "worker", text: `message-${index}` }),
		),
	);

	expect(await client.inbox("uncapped", "worker", 500, registration.leaseId)).toHaveLength(201);
});

test("large text is gzip-compressed on the custom Mesh wire and decoded by HubClient", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "compressed" });
	const registration = await client.register({ project: "compressed", agentId: "worker", cwd: "/worker", pid: 1 });
	const text = "compressible payload ".repeat(2_000);
	await client.send({ project: "compressed", from: "controller", to: "worker", text });

	const response = await fetch(`${hub.listenUrl}/v1/inbox?project=compressed&agentId=worker`, {
		headers: { "x-a2a-lease": registration.leaseId },
	});
	const wire = (await response.json()) as {
		messages: Array<{ payload?: { encoding?: string; data?: string } }>;
	};
	expect(wire.messages[0]?.payload?.encoding).toBe("gzip+base64");
	expect(wire.messages[0]?.payload?.data?.length ?? Infinity).toBeLessThan(Buffer.byteLength(text));
	expect((await client.inbox("compressed", "worker", 500, registration.leaseId))[0]?.text).toBe(text);
});

test("small text stays uncompressed and decoded text is capped at 4 MiB", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "payload-limits" });
	const registration = await client.register({ project: "payload-limits", agentId: "worker", cwd: "/worker", pid: 1 });
	await client.send({ project: "payload-limits", from: "controller", to: "worker", text: "small" });

	const response = await fetch(`${hub.listenUrl}/v1/inbox?project=payload-limits&agentId=worker`, {
		headers: { "x-a2a-lease": registration.leaseId },
	});
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

test("ack creates a durable delivery receipt without receipt loops", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const first = await startHubServer({ port: 0, dataDir });
	hubs.push(first);
	const client = new HubClient(first.listenUrl);
	await client.createProject({ name: "receipts" });
	const controller = await client.register({ project: "receipts", agentId: "controller", cwd: "/controller", pid: 1 });
	const worker = await client.register({ project: "receipts", agentId: "worker", cwd: "/worker", pid: 2 });
	const sent = await client.send({ project: "receipts", from: "controller", to: "worker", text: "work" });
	expect((await client.inbox("receipts", "worker", 500, worker.leaseId))[0]?.kind).toBe("message");
	await client.ack("receipts", "worker", [sent.msgId], worker.leaseId);
	await first.stop();

	const second = await startHubServer({ port: 0, dataDir });
	hubs.push(second);
	const restarted = new HubClient(second.listenUrl);
	const receipts = await restarted.inbox("receipts", "controller", 500, controller.leaseId);
	expect(receipts).toHaveLength(1);
	const receipt = receipts[0];
	if (receipt?.kind !== "delivery_receipt") throw new Error("expected a delivery receipt");
	expect(receipts[0]).toMatchObject({
		kind: "delivery_receipt",
		project: "receipts",
		from: "worker",
		to: "controller",
		receiptFor: sent.msgId,
	});
	expect(Number.isFinite(receipt.deliveredAt)).toBe(true);

	await restarted.ack("receipts", "controller", [receipts[0]!.msgId], controller.leaseId);
	expect(await restarted.inbox("receipts", "controller", 500, controller.leaseId)).toEqual([]);
	expect(await restarted.inbox("receipts", "worker", 500, worker.leaseId)).toEqual([]);
});

test("trust-on-claim send does not grant anonymous Inbox ownership", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "claimed-sender" });
	const worker = await client.register({ project: "claimed-sender", agentId: "worker", cwd: "/worker", pid: 1 });
	const sent = await client.send({
		project: "claimed-sender",
		from: "controller",
		to: "worker",
		text: "work",
	});
	await client.ack("claimed-sender", "worker", [sent.msgId], worker.leaseId);

	await expect(client.inbox("claimed-sender", "controller")).rejects.toThrow(
		"not a member: controller@claimed-sender",
	);

	const controller = await client.register({
		project: "claimed-sender",
		agentId: "controller",
		cwd: "/controller",
		pid: 2,
	});
	expect(await client.inbox("claimed-sender", "controller", 500, controller.leaseId)).toEqual([
		expect.objectContaining({ kind: "delivery_receipt", receiptFor: sent.msgId }),
	]);
});

test("legacy Inbox schema migrates without losing queued messages", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const database = new Database(join(dataDir, "inbox.sqlite"), { create: true });
	database.run(`
		CREATE TABLE inbox_messages (
			msg_id TEXT PRIMARY KEY,
			project TEXT NOT NULL,
			sender TEXT NOT NULL,
			recipient TEXT NOT NULL,
			encoding TEXT NOT NULL,
			data TEXT NOT NULL,
			uncompressed_bytes INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		)
	`);
	const insertLegacy = database.query(
		"INSERT INTO inbox_messages(msg_id, project, sender, recipient, encoding, data, uncompressed_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	insertLegacy.run("z-legacy-message", "legacy", "controller", "worker", "identity", "old first", 9, 123);
	insertLegacy.run("a-legacy-message", "legacy", "controller", "worker", "identity", "old second", 10, 123);
	insertLegacy.run("other-stream", "legacy", "controller", "other", "identity", "other", 5, 123);
	database.close();

	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "legacy" });
	const registration = await client.register({ project: "legacy", agentId: "worker", cwd: "/worker", pid: 1 });
	const other = await client.register({ project: "legacy", agentId: "other", cwd: "/other", pid: 2 });
	const controller = await client.register({ project: "legacy", agentId: "controller", cwd: "/controller", pid: 3 });

	const workerMessages = await client.inbox("legacy", "worker", 500, registration.leaseId);
	expect(workerMessages.map((message) => [message.msgId, message.serverSequence])).toEqual([
		["z-legacy-message", 1],
		["a-legacy-message", 2],
	]);
	expect((await client.inbox("legacy", "other", 500, other.leaseId))[0]).toMatchObject({
		msgId: "other-stream",
		serverSequence: 1,
	});
	await client.ack("legacy", "worker", ["z-legacy-message"], registration.leaseId);
	expect((await client.inbox("legacy", "controller", 500, controller.leaseId))[0]).toMatchObject({
		kind: "delivery_receipt",
		receiptFor: "z-legacy-message",
	});
	await client.unregister("legacy", "worker", registration.leaseId);
	const retried = await client.send({
		project: "legacy",
		from: "controller",
		to: "worker",
		text: "old first",
		messageId: "z-legacy-message",
	});
	expect(retried.serverSequence).toBe(1);
});

test("global-sequence ledger migrates to project recipient sequence scopes", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const database = new Database(join(dataDir, "inbox.sqlite"), { create: true });
	database.run(`
		CREATE TABLE message_ledger (
			msg_id TEXT PRIMARY KEY,
			project TEXT NOT NULL,
			sender TEXT NOT NULL,
			recipient TEXT NOT NULL,
			encoding TEXT NOT NULL,
			data TEXT NOT NULL,
			uncompressed_bytes INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			reply_to TEXT,
			server_sequence INTEGER NOT NULL UNIQUE
		)
	`);
	database
		.query(
			"INSERT INTO message_ledger(msg_id, project, sender, recipient, encoding, data, uncompressed_bytes, created_at, reply_to, server_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run("old-message", "old-project", "sender", "worker", "identity", "old", 3, 1, null, 1);
	database.run(`
		CREATE TABLE inbox_messages (
			msg_id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			project TEXT NOT NULL,
			sender TEXT NOT NULL,
			recipient TEXT NOT NULL,
			encoding TEXT NOT NULL,
			data TEXT NOT NULL,
			uncompressed_bytes INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			server_sequence INTEGER NOT NULL,
			reply_to TEXT,
			receipt_for TEXT,
			delivered_at INTEGER
		)
	`);
	database
		.query(
			"INSERT INTO inbox_messages(msg_id, kind, project, sender, recipient, encoding, data, uncompressed_bytes, created_at, server_sequence, reply_to, receipt_for, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run("old-message", "message", "old-project", "sender", "worker", "identity", "old", 3, 1, 1, null, null, null);
	database.run("CREATE TABLE inbox_state(singleton INTEGER PRIMARY KEY, next_sequence INTEGER NOT NULL)");
	database.run("INSERT INTO inbox_state(singleton, next_sequence) VALUES (1, 1)");
	database.run(
		"CREATE TABLE inbox_cursors(project TEXT NOT NULL, recipient TEXT NOT NULL, last_sequence INTEGER NOT NULL, PRIMARY KEY(project, recipient))",
	);
	database.run("INSERT INTO inbox_cursors(project, recipient, last_sequence) VALUES ('old-project', 'worker', 1)");
	database.close();

	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "old-project" });
	const oldWorker = await client.register({ project: "old-project", agentId: "worker", cwd: "/worker", pid: 1 });
	expect(await client.readInbox("old-project", "worker", 500, oldWorker.leaseId)).toMatchObject({
		cursor: 0,
		messages: [{ msgId: "old-message", serverSequence: 1 }],
	});
	await client.createProject({ name: "new-project" });
	await client.register({ project: "new-project", agentId: "worker", cwd: "/worker", pid: 1 });

	const message = await client.send({
		project: "new-project",
		from: "sender",
		to: "worker",
		text: "new",
	});
	expect(message.serverSequence).toBe(1);
});

test("deleting a project removes messages before its name can be reused", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-inbox-"));
	roots.push(dataDir);
	const hub = await startHubServer({ port: 0, dataDir });
	hubs.push(hub);
	const client = new HubClient(hub.listenUrl);
	await client.createProject({ name: "reused" });
	const registration = await client.register({ project: "reused", agentId: "worker", cwd: "/worker", pid: 1 });
	await client.send({ project: "reused", from: "controller", to: "worker", text: "old work" });
	await client.unregister("reused", "worker", registration.leaseId);

	expect(await client.deleteProject("reused")).toBe(true);
	await client.createProject({ name: "reused" });
	const replacement = await client.register({ project: "reused", agentId: "worker", cwd: "/worker", pid: 2 });

	expect(await client.inbox("reused", "worker", 500, replacement.leaseId)).toEqual([]);
});
