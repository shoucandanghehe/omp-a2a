import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ACK_BATCH_MESSAGES } from "../src/hub/inbox";
import {
	hubMetaPath,
	hubPidPath,
	projectDeletionMarkerPath,
	projectMetaPath,
} from "../src/paths";
import { HubClient } from "../src/hub/client";
import { startHubServer, type HubServerHandle } from "../src/hub/server";
import { OFFLINE_MS, STALE_MS } from "../src/types";

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
		const registration = await client.register({
			project: "presence",
			agentId: "worker",
			cwd: "/work",
			pid: 2_147_483_647,
		});

		expect((await client.listMembers("presence")).map((member) => member.agentId)).toEqual(["worker"]);
		expect((await client.heartbeat("presence", "worker", registration.leaseId)).status).toBe("online");
	});

	test("heartbeat reconnects a lease-expired member but not one that explicitly left", async () => {
		const now = spyOn(Date, "now").mockReturnValue(1_000);
		try {
			const hub = await startHubServer({ port: 0, dataDir: dataDir() });
			hubs.push(hub);
			const client = new HubClient(hub.meta.baseUrl);
			await client.createProject({ name: "reconnect" });
			const registration = await client.register({ project: "reconnect", agentId: "worker", cwd: "/work", pid: 1 });

			now.mockReturnValue(1_000 + OFFLINE_MS + 1);
			expect(await client.listMembers("reconnect")).toEqual([]);
			expect((await client.heartbeat("reconnect", "worker", registration.leaseId)).status).toBe("online");

			await client.unregister("reconnect", "worker", registration.leaseId);
			await expect(client.heartbeat("reconnect", "worker", registration.leaseId)).rejects.toThrow("member is offline");
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

	test("startup reconciles an interrupted cross-store project deletion", async () => {
		const root = dataDir();
		const first = await startHubServer({ port: 0, dataDir: root });
		hubs.push(first);
		const firstClient = new HubClient(first.meta.baseUrl);
		await firstClient.createProject({ name: "reused" });
		const worker = await firstClient.register({ project: "reused", agentId: "worker", cwd: "/worker", pid: 1 });
		await firstClient.send({
			project: "reused",
			from: "controller",
			to: "worker",
			text: "old work",
			messageId: "reused-id",
		});
		await firstClient.unregister("reused", "worker", worker.leaseId);
		await first.stop();

		rmSync(projectMetaPath("reused", root));
		const markerPath = projectDeletionMarkerPath("reused", root);
		mkdirSync(join(root, "run", "project-deletions"), { recursive: true });
		writeFileSync(markerPath, JSON.stringify({ project: "reused", startedAt: Date.now() }));

		const restarted = await startHubServer({ port: 0, dataDir: root });
		hubs.push(restarted);
		const client = new HubClient(restarted.meta.baseUrl);
		expect(existsSync(markerPath)).toBe(false);
		await client.createProject({ name: "reused" });
		expect(await client.listMembers("reused", true)).toEqual([]);
		const replacement = await client.register({
			project: "reused",
			agentId: "worker",
			cwd: "/replacement",
			pid: 2,
		});
		expect(await client.inbox("reused", "worker", 500, replacement.leaseId)).toEqual([]);
		await expect(
			client.send({
				project: "reused",
				from: "controller",
				to: "worker",
				text: "new work",
				messageId: "reused-id",
			}),
		).resolves.toMatchObject({ msgId: "reused-id", serverSequence: 1 });
	});

	test("post-listen metadata failures release all Hub resources", async () => {
		const root = dataDir();
		const reservation = await startHubServer({ port: 0, dataDir: root });
		const fixedPort = reservation.meta.port;
		await reservation.stop();
		mkdirSync(hubPidPath(root), { recursive: true });

		await expect(startHubServer({ port: fixedPort, dataDir: root })).rejects.toThrow();
		expect(existsSync(hubMetaPath(root))).toBe(false);

		rmSync(hubPidPath(root), { recursive: true });
		const recovered = await startHubServer({ port: fixedPort, dataDir: root });
		hubs.push(recovered);
		expect((await new HubClient(recovered.meta.baseUrl).meta()).dataDir).toBe(root);
	});

	test("HTTP acknowledgment rejects batches above the storage cap", async () => {
		const root = dataDir();
		const hub = await startHubServer({ port: 0, dataDir: root });
		hubs.push(hub);
		const client = new HubClient(hub.meta.baseUrl);
		await client.createProject({ name: "ack-cap" });
		const worker = await client.register({ project: "ack-cap", agentId: "worker", cwd: "/worker", pid: 1 });

		const response = await fetch(`${hub.meta.baseUrl}/v1/inbox/ack`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: "ack-cap",
				agentId: "worker",
				leaseId: worker.leaseId,
				messageIds: Array.from({ length: MAX_ACK_BATCH_MESSAGES + 1 }, () => "duplicate"),
			}),
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			error: `acknowledgment batch exceeds ${MAX_ACK_BATCH_MESSAGES} messages`,
		});
	});

	test("a project cannot be deleted while a member is active", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.meta.baseUrl);
		await client.createProject({ name: "active" });
		const registration = await client.register({ project: "active", agentId: "worker", cwd: "/worker", pid: 1 });

		await expect(client.deleteProject("active")).rejects.toThrow("active members: worker");
		expect((await client.listProjects()).map((project) => project.name)).toEqual(["active"]);

		await client.unregister("active", "worker", registration.leaseId);
		expect(await client.deleteProject("active")).toBe(true);
	});

	test("stale takeover fences the prior owner and public members omit the lease", async () => {
		const now = spyOn(Date, "now").mockReturnValue(1_000);
		try {
			const hub = await startHubServer({ port: 0, dataDir: dataDir() });
			hubs.push(hub);
			const prior = new HubClient(hub.meta.baseUrl);
			const replacement = new HubClient(hub.meta.baseUrl);
			await prior.createProject({ name: "takeover" });
			const first = await prior.register({
				project: "takeover",
				agentId: "worker",
				cwd: "/first",
				pid: 1,
			});
			const sent = await prior.send({
				project: "takeover",
				from: "controller",
				to: "worker",
				text: "owned work",
			});

			expect(first.member).not.toHaveProperty("leaseId");
			expect((await prior.listMembers("takeover", true))[0]).not.toHaveProperty("leaseId");
			now.mockReturnValue(1_000 + STALE_MS + 1);
			const second = await replacement.register({
				project: "takeover",
				agentId: "worker",
				cwd: "/second",
				pid: 2,
			});
			expect(second.leaseId).not.toBe(first.leaseId);

			await expect(prior.heartbeat("takeover", "worker", first.leaseId)).rejects.toThrow("lease ownership mismatch");
			await expect(prior.unregister("takeover", "worker", first.leaseId)).rejects.toThrow("lease ownership mismatch");
			await expect(prior.readInbox("takeover", "worker", 500, first.leaseId)).rejects.toThrow(
				"lease ownership mismatch",
			);
			await expect(prior.ack("takeover", "worker", [sent.msgId], first.leaseId)).rejects.toThrow(
				"lease ownership mismatch",
			);

			expect((await replacement.readInbox("takeover", "worker", 500, second.leaseId)).messages).toHaveLength(1);
			await replacement.ack("takeover", "worker", [sent.msgId], second.leaseId);
			await replacement.unregister("takeover", "worker", second.leaseId);
			await replacement.unregister("takeover", "worker", second.leaseId);
		} finally {
			now.mockRestore();
		}
	});

});
