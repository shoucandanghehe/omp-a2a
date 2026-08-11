import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../src/hub/client";
import { A2aConnection } from "../src/hub/connection";
import { MESSAGE_STORAGE_VERSION } from "../src/hub/store";
import { type HubServerHandle, startHubServer } from "../src/hub/server";

const roots: string[] = [];
const UNSUPPORTED_STORAGE_MESSAGE =
	"unsupported pre-release storage; start with an empty data directory";
const hubs: HubServerHandle[] = [];

function dataDir(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-control-"));
	roots.push(root);
	return root;
}

async function availablePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", resolve);
	});
	const address = probe.address() as AddressInfo;
	await new Promise<void>((resolve, reject) =>
		probe.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("configured Hub URL remains authoritative over advertised metadata", async () => {
	const hub = await startHubServer({
		port: 0,
		dataDir: dataDir(),
		publicUrl: "http://127.0.0.1:1",
	});
	hubs.push(hub);
	const configuredUrl = `http://127.0.0.1:${hub.meta.port}`;
	await new HubClient(configuredUrl).createProject({
		name: "configured-route",
	});

	const client = await HubClient.connect({ hubUrl: configuredUrl });
	const connection = await A2aConnection.connect({
		baseUrl: client.baseUrl,
		project: "configured-route",
		name: "remote",
	});
	expect(connection.self.name).toBe("remote");
	await connection.close();
});


test("Hub rejects unsupported message storage before listening", async () => {
	const root = dataDir();
	const database = new Database(join(root, "messages.sqlite"), { create: true });
	database.run("CREATE TABLE messages (id TEXT)");
	database.run(`PRAGMA user_version = ${MESSAGE_STORAGE_VERSION + 1}`);
	database.close();

	await expect(startHubServer({ port: 0, dataDir: root })).rejects.toThrow(
		UNSUPPORTED_STORAGE_MESSAGE,
	);
});

describe("Hub Project control plane", () => {
	test("different Hub data directories own independent Projects", async () => {
		const first = await startHubServer({ port: 0, dataDir: dataDir() });
		const second = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(first, second);
		const firstClient = new HubClient(first.meta.baseUrl);
		const secondClient = new HubClient(second.meta.baseUrl);
		await firstClient.createProject({ name: "alpha" });

		expect(
			(await firstClient.listProjects()).map((project) => project.name),
		).toEqual(["alpha"]);
		expect(await secondClient.listProjects()).toEqual([]);
	});

	test("control requests have no application body cap", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const description = "x".repeat(6 * 1024 * 1024 + 1);
		const project = await new HubClient(hub.meta.baseUrl).createProject({
			name: "large-control-body",
			description,
		});
		expect(project.description).toBe(description);
	});

	test("the same Hub data directory cannot be opened twice", async () => {
		const root = dataDir();
		const hub = await startHubServer({ port: 0, dataDir: root });
		hubs.push(hub);
		await expect(startHubServer({ port: 0, dataDir: root })).rejects.toThrow(
			"already in use",
		);
	});

	test("connecting to an unknown Project fails at the claim boundary", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		await expect(
			A2aConnection.connect({
				baseUrl: hub.meta.baseUrl,
				project: "missing",
				name: "api",
			}),
		).rejects.toThrow("claim_rejected");
	});

	test("Project deletion is idempotent and rejects active Presences", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.meta.baseUrl);
		await client.createProject({ name: "active" });
		const connection = await A2aConnection.connect({
			baseUrl: hub.meta.baseUrl,
			project: "active",
			name: "api",
		});
		const accepted = await connection.send({
			target: { type: "project" },
			text: "must survive rejected deletion",
			messageId: "active-history",
		});
		const beforeDelete = await client.history({ project: "active" });
		expect(beforeDelete.messages).toHaveLength(1);
		expect(beforeDelete.messages[0]?.messageRef).toBe(
			accepted.message.messageRef,
		);

		await expect(client.deleteProject("active")).rejects.toThrow(
			"active Presences",
		);
		expect(await client.history({ project: "active" })).toEqual(beforeDelete);
		await connection.close();
		expect(await client.deleteProject("active")).toBe(true);
		expect(await client.deleteProject("active")).toBe(false);
	});

	test("deletion that wins before a claim makes the Project unknown", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.meta.baseUrl);
		await client.createProject({ name: "deleted-first" });
		expect(await client.deleteProject("deleted-first")).toBe(true);

		await expect(
			A2aConnection.connect({
				baseUrl: hub.meta.baseUrl,
				project: "deleted-first",
				name: "api",
			}),
		).rejects.toThrow("unknown project: deleted-first");
	});
});

test("deleting and recreating a Project does not reuse its history", async () => {
	const hub = await startHubServer({ port: 0, dataDir: dataDir() });
	hubs.push(hub);
	const client = new HubClient(hub.meta.baseUrl);
	await client.createProject({ name: "reused" });
	const api = await A2aConnection.connect({
		baseUrl: hub.meta.baseUrl,
		project: "reused",
		name: "api",
	});
	const web = await A2aConnection.connect({
		baseUrl: hub.meta.baseUrl,
		project: "reused",
		name: "web",
	});
	await api.send({
		target: { type: "agent", name: "web" },
		text: "old history",
		messageId: "old-history",
	});
	await api.close();
	await web.close();
	expect(await client.deleteProject("reused")).toBe(true);
	await client.createProject({ name: "reused" });
	expect(await client.history({ project: "reused" })).toEqual({ messages: [] });
});

test("startup failure releases its port, SQLite store, and data lock", async () => {
	const root = dataDir();
	const port = await availablePort();
	mkdirSync(join(root, "run", "hub.json"), { recursive: true });

	await expect(startHubServer({ port, dataDir: root })).rejects.toThrow();
	rmSync(join(root, "run", "hub.json"), { recursive: true, force: true });
	const restarted = await startHubServer({ port, dataDir: root });
	hubs.push(restarted);
	const client = new HubClient(restarted.meta.baseUrl);
	expect((await client.listProjects()).length).toBe(0);
});

test("concurrent stops share and await one cleanup", async () => {
	const root = dataDir();
	const hub = await startHubServer({ port: 0, dataDir: root });
	const port = hub.meta.port;
	const firstStop = hub.stop();
	const secondStop = hub.stop();

	expect(secondStop).toBe(firstStop);
	await Promise.all([firstStop, secondStop]);
	const restarted = await startHubServer({ port, dataDir: root });
	hubs.push(restarted);
});
