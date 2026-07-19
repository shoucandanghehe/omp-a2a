import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../src/hub/client";
import { startHubServer, type HubServerHandle } from "../src/hub/server";
import { OFFLINE_MS } from "../src/types";

const roots: string[] = [];
const hubs: HubServerHandle[] = [];

afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-test-"));
	roots.push(root);
	return root;
}

describe("Hub project control plane", () => {
	test("different Hub data directories own independent project registries", async () => {
		const first = await startHubServer({ port: 0, dataDir: dataDir() });
		const second = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(first, second);

		const firstClient = new HubClient(first.meta.baseUrl);
		const secondClient = new HubClient(second.meta.baseUrl);
		await firstClient.createProject({ name: "alpha" });

		expect((await firstClient.listProjects()).map((project) => project.name)).toEqual(["alpha"]);
		expect(await secondClient.listProjects()).toEqual([]);
	});
	test("presence is derived from heartbeat even when the diagnostic PID is not visible", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.meta.baseUrl);
		await client.createProject({ name: "presence" });
		await client.register({
			project: "presence",
			agentId: "worker",
			cwd: "/work",
			pid: 2_147_483_647,
		});

		expect((await client.listMembers("presence")).map((member) => member.agentId)).toEqual(["worker"]);
		expect((await client.heartbeat("presence", "worker")).status).toBe("online");
	});

	test("heartbeat reconnects a lease-expired member but not one that explicitly left", async () => {
		const now = spyOn(Date, "now").mockReturnValue(1_000);
		try {
			const hub = await startHubServer({ port: 0, dataDir: dataDir() });
			hubs.push(hub);
			const client = new HubClient(hub.meta.baseUrl);
			await client.createProject({ name: "reconnect" });
			await client.register({ project: "reconnect", agentId: "worker", cwd: "/work", pid: 1 });

			now.mockReturnValue(1_000 + OFFLINE_MS + 1);
			expect(await client.listMembers("reconnect")).toEqual([]);
			expect((await client.heartbeat("reconnect", "worker")).status).toBe("online");

			await client.unregister("reconnect", "worker");
			await expect(client.heartbeat("reconnect", "worker")).rejects.toThrow("member is offline");
		} finally {
			now.mockRestore();
		}
	});

	test("an online agent ID cannot be replaced implicitly", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.meta.baseUrl);
		await client.createProject({ name: "conflicts" });
		await client.register({ project: "conflicts", agentId: "api", cwd: "/first", pid: 1 });

		await expect(
			client.register({ project: "conflicts", agentId: "api", cwd: "/second", pid: 2 }),
		).rejects.toThrow("already online");
		expect((await client.listMembers("conflicts"))[0]?.cwd).toBe("/first");
	});

	test("the same Hub data directory cannot be opened by two processes", async () => {
		const root = dataDir();
		const hub = await startHubServer({ port: 0, dataDir: root });
		hubs.push(hub);

		await expect(startHubServer({ port: 0, dataDir: root })).rejects.toThrow("already in use");
	});

	test("deleting an empty project is idempotent", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.meta.baseUrl);
		await client.createProject({ name: "retired" });

		expect(await client.deleteProject("retired")).toBe(true);
		expect(await client.listProjects()).toEqual([]);
		expect(await client.deleteProject("retired")).toBe(false);
	});

	test("a project cannot be deleted while a member is active", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.meta.baseUrl);
		await client.createProject({ name: "active" });
		await client.register({ project: "active", agentId: "worker", cwd: "/worker", pid: 1 });

		await expect(client.deleteProject("active")).rejects.toThrow("active members: worker");
		expect((await client.listProjects()).map((project) => project.name)).toEqual(["active"]);

		await client.unregister("active", "worker");
		expect(await client.deleteProject("active")).toBe(true);
	});

});
