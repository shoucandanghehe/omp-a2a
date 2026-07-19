import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../src/hub/client";
import { startHubServer, type HubServerHandle } from "../src/hub/server";
import { A2aOperations } from "../src/operations";

let hub: HubServerHandle | null = null;
let root: string | null = null;

afterEach(async () => {
	await hub?.stop();
	if (root) rmSync(root, { recursive: true, force: true });
	hub = null;
	root = null;
});

test("A2aOperations creates and lists projects through the connected Hub", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.meta.baseUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });

	await operations.execute({ action: "project_create", project: "shared" }, { cwd: "/repo" });
	const listed = await operations.execute({ action: "project_list" }, { cwd: "/repo" });

	expect((await client.listProjects()).map((project) => project.name)).toEqual(["shared"]);
	expect(listed.text).toContain("shared");
});

test("leave clears local membership and reports pending cleanup when Hub is unavailable", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.meta.baseUrl);
	let available = true;
	const operations = new A2aOperations({
		getClient: async () => {
			if (!available) throw new Error("Hub unavailable");
			return client;
		},
		pid: 123,
	});
	await operations.execute({ action: "project_create", project: "leave" }, { cwd: "/repo" });
	await operations.execute(
		{ action: "join", project: "leave", agentId: "worker" },
		{ cwd: "/repo", sessionId: "session" },
	);
	available = false;

	const result = await operations.execute({ action: "leave" }, { cwd: "/repo" });

	expect(result.cleanupPending).toBe(true);
	expect(result.membershipChanged).toBe("left");
	expect(operations.membership).toBeNull();
});

test("Inbox acknowledgment happens only after successful delivery", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.meta.baseUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "delivery" }, { cwd: "/repo" });
	await operations.execute(
		{ action: "join", project: "delivery", agentId: "worker" },
		{ cwd: "/repo", sessionId: "session" },
	);
	await client.send({ project: "delivery", from: "controller", to: "worker", text: "work" });

	await expect(
		operations.receive(() => {
			throw new Error("injection failed");
		}),
	).rejects.toThrow("injection failed");
	expect(await client.inbox("delivery", "worker")).toHaveLength(1);

	const delivered: string[] = [];
	expect(await operations.receive((message) => delivered.push(message.text))).toBe(1);
	expect(delivered).toEqual(["work"]);
	expect(await client.inbox("delivery", "worker")).toEqual([]);
});

test("send uses the joined membership as the claimed sender", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.meta.baseUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "send" }, { cwd: "/repo" });
	await client.register({ project: "send", agentId: "worker", cwd: "/worker", pid: 456 });
	await operations.execute({ action: "join", project: "send", agentId: "controller" }, { cwd: "/repo" });

	const result = await operations.execute({ action: "send", to: "worker", text: "hello" }, { cwd: "/repo" });

	expect(result.text).toContain("Sent to worker");
	expect((await client.inbox("send", "worker"))[0]?.text).toBe("hello");
});

test("read-only operations report the connected Hub and joined membership", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.meta.baseUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "status" }, { cwd: "/repo" });
	await operations.execute({ action: "join", project: "status", agentId: "controller" }, { cwd: "/repo" });

	const hubResult = await operations.execute({ action: "hub" }, { cwd: "/repo" });
	const status = await operations.execute({ action: "status" }, { cwd: "/repo" });
	const members = await operations.execute({ action: "list" }, { cwd: "/repo" });

	expect(hubResult.text).toContain(hub.meta.baseUrl);
	expect(status.text).toContain("controller");
	expect(members.text).toContain("controller");
});

test("manual inbox displays and acknowledges messages", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.meta.baseUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "inbox" }, { cwd: "/repo" });
	await operations.execute({ action: "join", project: "inbox", agentId: "worker" }, { cwd: "/repo" });
	await client.send({ project: "inbox", from: "controller", to: "worker", text: "manual" });

	const result = await operations.execute({ action: "inbox" }, { cwd: "/repo" });

	expect(result.text).toContain("manual");
	expect(await client.inbox("inbox", "worker")).toEqual([]);
});
