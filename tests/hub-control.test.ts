import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../src/hub/client";
import { A2aConnection } from "../src/hub/connection";
import { type HubServerHandle, startHubServer } from "../src/hub/server";

const roots: string[] = [];
const hubs: HubServerHandle[] = [];

function dataDir(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-control-"));
	roots.push(root);
	return root;
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

		await expect(client.deleteProject("active")).rejects.toThrow(
			"active Presences",
		);
		await connection.close();
		expect(await client.deleteProject("active")).toBe(true);
		expect(await client.deleteProject("active")).toBe(false);
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
