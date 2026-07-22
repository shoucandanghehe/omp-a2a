import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../src/hub/client";
import { startHubServer, type HubServerHandle } from "../src/hub/server";
import { A2aOperations } from "../src/operations";

let hub: HubServerHandle | null = null;
let dataDir: string | null = null;

afterEach(async () => {
	await hub?.stop();
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	hub = null;
	dataDir = null;
});

test("same-stream messages follow server acceptance order when timestamps collide", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "ordering" });
	await client.register({ project: "ordering", agentId: "receiver", cwd: "/receiver", pid: 1 });

	const now = spyOn(Date, "now").mockReturnValue(1_000);
	const messageIds = [
		"ffffffff-ffff-4fff-8fff-ffffffffffff",
		"00000000-0000-4000-8000-000000000000",
		"88888888-8888-4888-8888-888888888888",
	];
	const randomUUID = spyOn(crypto, "randomUUID").mockImplementation(() => messageIds.shift()!);
	try {
		await client.send({ project: "ordering", from: "sender", to: "receiver", text: "first" });
		await client.send({ project: "ordering", from: "sender", to: "receiver", text: "second" });
		await client.send({ project: "ordering", from: "sender", to: "receiver", text: "third" });
	} finally {
		randomUUID.mockRestore();
		now.mockRestore();
	}

	const messages = await client.inbox("ordering", "receiver");
	expect(messages.map((message) => message.text)).toEqual(["first", "second", "third"]);
	expect(messages.map((message) => message.serverSequence)).toEqual([1, 2, 3]);
});

test("sequence is monotonic within each project recipient stream", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "stream-a" });
	await client.createProject({ name: "stream-b" });
	await client.register({ project: "stream-a", agentId: "receiver", cwd: "/receiver", pid: 1 });
	await client.register({ project: "stream-a", agentId: "other", cwd: "/other", pid: 2 });
	await client.register({ project: "stream-b", agentId: "receiver", cwd: "/receiver", pid: 3 });

	const a1 = await client.send({ project: "stream-a", from: "sender", to: "receiver", text: "a1" });
	const other1 = await client.send({ project: "stream-a", from: "sender", to: "other", text: "other1" });
	const b1 = await client.send({ project: "stream-b", from: "sender", to: "receiver", text: "b1" });
	const a2 = await client.send({ project: "stream-a", from: "sender", to: "receiver", text: "a2" });

	expect([a1.serverSequence, other1.serverSequence, b1.serverSequence, a2.serverSequence]).toEqual([1, 1, 1, 2]);
});

test("messageId makes retries idempotent even after delivery", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "dedup" });
	const registration = await client.register({ project: "dedup", agentId: "receiver", cwd: "/receiver", pid: 1 });
	const input = {
		project: "dedup",
		from: "sender",
		to: "receiver",
		text: "do this once",
		messageId: "retry-1",
	};

	const first = await client.send(input);
	const retried = await client.send(input);
	expect(retried).toEqual(first);
	expect(await client.inbox("dedup", "receiver")).toHaveLength(1);

	await client.ack("dedup", "receiver", [first.msgId]);
	await client.unregister("dedup", "receiver", registration.leaseId);
	await hub.stop();
	hub = await startHubServer({ port: 0, dataDir });
	const restarted = new HubClient(hub.meta.baseUrl);
	expect(await restarted.send(input)).toEqual(first);
	await expect(restarted.inbox("dedup", "receiver", 500, registration.leaseId)).rejects.toThrow("member is offline");
	await expect(restarted.send({ ...input, text: "different work" })).rejects.toThrow("messageId already used");
});

test("cursor advances only after ordered acknowledgment", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "cursor" });
	await client.register({ project: "cursor", agentId: "receiver", cwd: "/receiver", pid: 1 });
	const first = await client.send({ project: "cursor", from: "sender", to: "receiver", text: "first" });
	const second = await client.send({ project: "cursor", from: "sender", to: "receiver", text: "second" });

	const firstRead = await client.readInbox("cursor", "receiver", 1);
	expect(firstRead.messages.map((message) => message.msgId)).toEqual([first.msgId]);
	expect(firstRead.cursor).toBe(0);
	expect(await client.readInbox("cursor", "receiver", 1)).toEqual(firstRead);

	await client.ack("cursor", "receiver", [first.msgId]);
	const secondRead = await client.readInbox("cursor", "receiver", 1);
	expect(secondRead.messages.map((message) => message.msgId)).toEqual([second.msgId]);
	expect(secondRead.cursor).toBe(first.serverSequence);

	await client.ack("cursor", "receiver", [second.msgId]);
	expect(await client.readInbox("cursor", "receiver", 10)).toEqual({
		messages: [],
		cursor: second.serverSequence,
	});
});

test("acknowledgment state is ordered, idempotent, and observable", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "ack-state" });
	await client.register({ project: "ack-state", agentId: "receiver", cwd: "/receiver", pid: 1 });
	const first = await client.send({ project: "ack-state", from: "sender", to: "receiver", text: "first" });
	const second = await client.send({ project: "ack-state", from: "sender", to: "receiver", text: "second" });

	await expect(client.ack("ack-state", "receiver", [second.msgId])).rejects.toThrow("out-of-order acknowledgment");
	await expect(client.ack("ack-state", "receiver", ["missing-message"])).rejects.toThrow("unknown message");
	expect(await client.ack("ack-state", "receiver", [first.msgId])).toEqual({
		acknowledgments: [
			{ messageId: first.msgId, serverSequence: first.serverSequence, status: "acknowledged" },
		],
		cursor: first.serverSequence,
	});
	expect(await client.ack("ack-state", "receiver", [first.msgId])).toEqual({
		acknowledgments: [
			{ messageId: first.msgId, serverSequence: first.serverSequence, status: "already_acknowledged" },
		],
		cursor: first.serverSequence,
	});
	expect((await client.readInbox("ack-state", "receiver")).messages.map((message) => message.msgId)).toEqual([
		second.msgId,
	]);
});

test("replyTo preserves and validates the causal parent", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "causal" });
	await client.register({ project: "causal", agentId: "controller", cwd: "/controller", pid: 1 });
	await client.register({ project: "causal", agentId: "worker", cwd: "/worker", pid: 2 });
	const instruction = await client.send({
		project: "causal",
		from: "controller",
		to: "worker",
		text: "latest requirement",
		messageId: "instruction-1",
	});
	const correction = await client.send({
		project: "causal",
		from: "controller",
		to: "worker",
		text: "corrected requirement",
		messageId: "instruction-2",
		replyTo: instruction.msgId,
	});
	expect(correction.replyTo).toBe(instruction.msgId);

	const reply = await client.send({
		project: "causal",
		from: "worker",
		to: "controller",
		text: "done",
		messageId: "reply-1",
		replyTo: instruction.msgId,
	});
	expect(reply.replyTo).toBe(instruction.msgId);
	expect((await client.inbox("causal", "controller"))[0]?.replyTo).toBe(instruction.msgId);

	await expect(
		client.send({
			project: "causal",
			from: "worker",
			to: "controller",
			text: "unrelated",
			messageId: "reply-unknown",
			replyTo: "missing-parent",
		}),
	).rejects.toThrow("unknown replyTo");
	await client.register({ project: "causal", agentId: "observer", cwd: "/observer", pid: 3 });
	await expect(
		client.send({
			project: "causal",
			from: "observer",
			to: "worker",
			text: "unrelated participant",
			messageId: "wrong-conversation",
			replyTo: instruction.msgId,
		}),
	).rejects.toThrow("does not match project conversation");

});

test("friendly message references resolve causal parents", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "friendly-ref" });
	await client.register({ project: "friendly-ref", agentId: "controller", cwd: "/controller", pid: 1 });
	await client.register({ project: "friendly-ref", agentId: "worker", cwd: "/worker", pid: 2 });

	const parent = await client.send({
		project: "friendly-ref",
		from: "controller",
		to: "worker",
		text: "first instruction",
		messageId: "friendly-parent",
	});
	expect(parent.messageRef).toBe("worker:1");

	const correction = await client.send({
		project: "friendly-ref",
		from: "controller",
		to: "worker",
		text: "corrected instruction",
		messageId: "friendly-correction",
		replyToRef: parent.messageRef,
	});
	expect(correction).toMatchObject({
		messageRef: "worker:2",
		replyTo: parent.msgId,
		replyToRef: "worker:1",
	});
	expect((await client.readInbox("friendly-ref", "worker")).messages.at(-1)).toMatchObject({
		messageRef: "worker:2",
		replyTo: parent.msgId,
		replyToRef: "worker:1",
	});
	const reply = await client.send({
		project: "friendly-ref",
		from: "worker",
		to: "controller",
		text: "done",
		messageId: "friendly-reply",
		replyToRef: parent.messageRef,
	});
	expect(reply).toMatchObject({
		messageRef: "controller:1",
		replyTo: parent.msgId,
		replyToRef: "worker:1",
	});
	await expect(
		client.send({
			project: "friendly-ref",
			from: "controller",
			to: "worker",
			text: "bad reference",
			messageId: "friendly-invalid",
			replyToRef: "worker:01",
		}),
	).rejects.toThrow("invalid messageRef");
	await expect(
		client.send({
			project: "friendly-ref",
			from: "controller",
			to: "worker",
			text: "missing reference",
			messageId: "friendly-missing",
			replyToRef: "worker:99",
		}),
	).rejects.toThrow("unknown replyToRef");
	await expect(
		client.send({
			project: "friendly-ref",
			from: "controller",
			to: "worker",
			text: "mismatched references",
			messageId: "friendly-mismatch",
			replyTo: parent.msgId,
			replyToRef: correction.messageRef,
		}),
	).rejects.toThrow("identify different messages");
});

test("concurrent sends are returned in authoritative server sequence", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "concurrent" });
	await client.register({ project: "concurrent", agentId: "receiver", cwd: "/receiver", pid: 1 });

	const accepted = await Promise.all(
		Array.from({ length: 50 }, (_, index) =>
			client.send({
				project: "concurrent",
				from: "sender",
				to: "receiver",
				text: `message-${index}`,
				messageId: `concurrent-${index}`,
			}),
		),
	);
	const serverOrder = [...accepted].sort((left, right) => left.serverSequence - right.serverSequence);
	const inbox = await client.inbox("concurrent", "receiver");

	expect(inbox.map((message) => message.msgId)).toEqual(serverOrder.map((message) => message.msgId));
	expect(new Set(inbox.map((message) => message.serverSequence)).size).toBe(50);
});

test("a delayed stale reply remains distinguishable by its causal parent", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "delayed-reply" });
	await client.register({ project: "delayed-reply", agentId: "controller", cwd: "/controller", pid: 1 });
	await client.register({ project: "delayed-reply", agentId: "worker", cwd: "/worker", pid: 2 });
	const oldInstruction = await client.send({
		project: "delayed-reply",
		from: "controller",
		to: "worker",
		text: "old requirement",
		messageId: "instruction-old",
	});
	const latestInstruction = await client.send({
		project: "delayed-reply",
		from: "controller",
		to: "worker",
		text: "corrected requirement",
		messageId: "instruction-latest",
	});
	await client.send({
		project: "delayed-reply",
		from: "worker",
		to: "controller",
		text: "latest result",
		messageId: "reply-latest",
		replyTo: latestInstruction.msgId,
	});
	await client.send({
		project: "delayed-reply",
		from: "worker",
		to: "controller",
		text: "stale result",
		messageId: "reply-stale",
		replyTo: oldInstruction.msgId,
	});

	const batch = await client.readInbox("delayed-reply", "controller");
	expect(batch.messages.map((message) => message.text)).toEqual(["latest result", "stale result"]);
	expect(batch.messages.map((message) => message.replyTo)).toEqual([
		latestInstruction.msgId,
		oldInstruction.msgId,
	]);
	expect(batch.messages[0]!.serverSequence).toBeLessThan(batch.messages[1]!.serverSequence);
});

test("concurrent reads expose at-least-once duplicates until acknowledgment", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "consume-concurrent" });
	await client.register({ project: "consume-concurrent", agentId: "receiver", cwd: "/receiver", pid: 1 });
	await Promise.all(
		Array.from({ length: 100 }, (_, index) =>
			client.send({
				project: "consume-concurrent",
				from: "sender",
				to: "receiver",
				text: `message-${index}`,
				messageId: `consume-${index}`,
			}),
		),
	);

	const batches = await Promise.all(
		Array.from({ length: 10 }, () => client.readInbox("consume-concurrent", "receiver", 10)),
	);
	const firstIds = batches[0]!.messages.map((message) => message.msgId);
	expect(new Set(batches.map((batch) => batch.messages.map((message) => message.msgId).join(","))).size).toBe(1);
	expect(batches.map((batch) => batch.cursor)).toEqual(Array.from({ length: 10 }, () => 0));

	await client.ack("consume-concurrent", "receiver", firstIds);
	const next = await client.readInbox("consume-concurrent", "receiver", 10);
	expect(next.cursor).toBe(10);
	expect(next.messages.map((message) => message.serverSequence)).toEqual([
		11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
	]);
});

test("acknowledged cursor survives Hub reconnect", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const firstClient = new HubClient(hub.meta.baseUrl);
	await firstClient.createProject({ name: "reconnect" });
	const registration = await firstClient.register({
		project: "reconnect",
		agentId: "receiver",
		cwd: "/receiver",
		pid: 1,
	});
	const first = await firstClient.send({
		project: "reconnect",
		from: "sender",
		to: "receiver",
		text: "first",
		messageId: "reconnect-first",
	});
	const second = await firstClient.send({
		project: "reconnect",
		from: "sender",
		to: "receiver",
		text: "second",
		messageId: "reconnect-second",
	});
	expect((await firstClient.readInbox("reconnect", "receiver", 1)).messages[0]?.msgId).toBe(first.msgId);
	await firstClient.ack("reconnect", "receiver", [first.msgId]);
	await hub.stop();

	hub = await startHubServer({ port: 0, dataDir });
	const reconnected = new HubClient(hub.meta.baseUrl);
	const remaining = await reconnected.readInbox("reconnect", "receiver", 500, registration.leaseId);
	expect(remaining.messages.map((message) => message.msgId)).toEqual([second.msgId]);
	expect(remaining.cursor).toBe(first.serverSequence);
});

test("failed delivery remains pending after Agent restart", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const firstAgent = new A2aOperations({ getClient: async () => client, pid: 1 });
	await firstAgent.execute({ action: "project_create", project: "agent-restart" }, { cwd: "/receiver" });
	await firstAgent.execute(
		{ action: "join", project: "agent-restart", agentId: "receiver" },
		{ cwd: "/receiver", sessionId: "first" },
	);
	const message = await client.send({
		project: "agent-restart",
		from: "sender",
		to: "receiver",
		text: "consume once",
		messageId: "agent-restart-message",
	});
	await expect(
		firstAgent.receive(() => {
			throw new Error("delivery failed");
		}),
	).rejects.toThrow("delivery failed");
	await firstAgent.execute({ action: "leave" }, { cwd: "/receiver" });

	const restartedAgent = new A2aOperations({ getClient: async () => client, pid: 2 });
	await restartedAgent.execute(
		{ action: "join", project: "agent-restart", agentId: "receiver" },
		{ cwd: "/receiver", sessionId: "second" },
	);
	const repeated: string[] = [];
	expect(await restartedAgent.receive((envelope) => repeated.push(envelope.msgId))).toBe(1);
	expect(repeated).toEqual([message.msgId]);
});

test("successful delivery is retried when acknowledgment fails before restart", async () => {
	dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-ordering-"));
	hub = await startHubServer({ port: 0, dataDir });
	const client = new HubClient(hub.meta.baseUrl);
	const firstAgent = new A2aOperations({ getClient: async () => client, pid: 1 });
	await firstAgent.execute({ action: "project_create", project: "ack-crash" }, { cwd: "/receiver" });
	await firstAgent.execute(
		{ action: "join", project: "ack-crash", agentId: "receiver" },
		{ cwd: "/receiver", sessionId: "first" },
	);
	const message = await client.send({
		project: "ack-crash",
		from: "sender",
		to: "receiver",
		text: "deliver before ack",
		messageId: "ack-crash-message",
	});
	const ack = spyOn(client, "ack").mockRejectedValueOnce(new Error("process stopped before ack"));
	const delivered: string[] = [];
	await expect(firstAgent.receive((envelope) => delivered.push(envelope.msgId))).rejects.toThrow(
		"process stopped before ack",
	);
	expect(delivered).toEqual([message.msgId]);
	ack.mockRestore();
	await firstAgent.execute({ action: "leave" }, { cwd: "/receiver" });

	const restartedAgent = new A2aOperations({ getClient: async () => client, pid: 2 });
	await restartedAgent.execute(
		{ action: "join", project: "ack-crash", agentId: "receiver" },
		{ cwd: "/receiver", sessionId: "second" },
	);
	const retried: string[] = [];
	expect(await restartedAgent.receive((envelope) => retried.push(envelope.msgId))).toBe(1);
	expect(retried).toEqual([message.msgId]);
});

test("new clients fall back to a legacy non-consuming Inbox", async () => {
	const legacyHub = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/v1/inbox/read") {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			if (url.pathname === "/v1/inbox") {
				return Response.json({
					messages: [
						{
							msgId: "legacy-wire-message",
							project: "legacy-wire",
							from: "sender",
							to: "receiver",
							payload: { encoding: "identity", data: "legacy", uncompressedBytes: 6 },
							createdAt: 1,
						},
					],
				});
			}
			if (url.pathname === "/v1/inbox/ack") {
				return Response.json({ ok: true });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	try {
		const client = new HubClient(`http://127.0.0.1:${legacyHub.port}`);
		const batch = await client.readInbox("legacy-wire", "receiver");
		expect(batch.messages).toEqual([
			{
				kind: "message",
				msgId: "legacy-wire-message",
				project: "legacy-wire",
				from: "sender",
				to: "receiver",
				text: "legacy",
				createdAt: 1,
				serverSequence: 0,
			},
		]);
		expect(batch.cursor).toBe(0);
		expect(await client.ack("legacy-wire", "receiver", ["legacy-wire-message"])).toBeNull();
	} finally {
		legacyHub.stop(true);
	}
});
