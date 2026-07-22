import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { MAX_ACK_BATCH_MESSAGES, MAX_INBOX_BATCH_MESSAGES } from "../src/hub/inbox";
import { MAX_TEXT_BYTES } from "../src/hub/payload";
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

		const firstClient = new HubClient(first.listenUrl);
		const secondClient = new HubClient(second.listenUrl);
		await firstClient.createProject({ name: "alpha" });

		expect((await firstClient.listProjects()).map((project) => project.name)).toEqual(["alpha"]);
		expect(await secondClient.listProjects()).toEqual([]);
	});

	test("deployment public URL does not redirect programmatic project control", async () => {
		const previousPublicUrl = process.env.OMP_A2A_HUB_PUBLIC_URL;
		const publicUrl = "http://127.0.0.1:1";
		process.env.OMP_A2A_HUB_PUBLIC_URL = publicUrl;
		try {
			const hub = await startHubServer({ port: 0, dataDir: dataDir() });
			hubs.push(hub);
			expect(hub.meta.baseUrl).toBe(hub.listenUrl);
			expect(hub.listenUrl).not.toBe(publicUrl);

			const client = new HubClient(hub.listenUrl);
			await client.createProject({ name: "local-control" });
			expect((await client.listProjects()).map((project) => project.name)).toEqual(["local-control"]);
			expect(await client.deleteProject("local-control")).toBe(true);
			expect(await client.listProjects()).toEqual([]);
		} finally {
			if (previousPublicUrl === undefined) delete process.env.OMP_A2A_HUB_PUBLIC_URL;
			else process.env.OMP_A2A_HUB_PUBLIC_URL = previousPublicUrl;
		}
	});

	test("wildcard binds require an explicit validated public URL", async () => {
		const previousPublicUrl = process.env.OMP_A2A_HUB_PUBLIC_URL;
		delete process.env.OMP_A2A_HUB_PUBLIC_URL;
		try {
			const root = dataDir();
			await expect(startHubServer({ port: 0, host: "0.0.0.0", dataDir: root })).rejects.toThrow(
				"public URL is required",
			);
			await expect(
				startHubServer({ port: 0, host: "0:0:0:0:0:0:0:0", dataDir: root }),
			).rejects.toThrow("public URL is required");

			const hub = await startHubServer({
				port: 0,
				host: "0.0.0.0",
				publicUrl: "https://mesh.example.internal/base/",
				dataDir: root,
			});
			hubs.push(hub);
			expect(hub.meta.baseUrl).toBe("https://mesh.example.internal/base");
			expect(hub.listenUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);

			const invalidRoot = dataDir();
			await expect(
				startHubServer({ port: 0, publicUrl: "ftp://mesh.example.internal", dataDir: invalidRoot }),
			).rejects.toThrow("invalid Hub public URL");
			await expect(
				startHubServer({ port: 0, publicUrl: "http://0.0.0.0:4173", dataDir: invalidRoot }),
			).rejects.toThrow("invalid Hub public URL");
			for (const publicUrl of ["http://mesh.example.internal?", "http://mesh.example.internal#"]) {
				await expect(startHubServer({ port: 0, publicUrl, dataDir: invalidRoot })).rejects.toThrow(
					"query, or fragment",
				);
			}
			const recovered = await startHubServer({ port: 0, dataDir: invalidRoot });
			hubs.push(recovered);
		} finally {
			if (previousPublicUrl === undefined) delete process.env.OMP_A2A_HUB_PUBLIC_URL;
			else process.env.OMP_A2A_HUB_PUBLIC_URL = previousPublicUrl;
		}
	});
	test("presence is derived from heartbeat even when the diagnostic PID is not visible", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
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
			const client = new HubClient(hub.listenUrl);
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
		const client = new HubClient(hub.listenUrl);
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
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "retired" });

		expect(await client.deleteProject("retired")).toBe(true);
		expect(await client.listProjects()).toEqual([]);
		expect(await client.deleteProject("retired")).toBe(false);
	});

	test("startup reconciles an interrupted cross-store project deletion", async () => {
		const root = dataDir();
		const first = await startHubServer({ port: 0, dataDir: root });
		hubs.push(first);
		const firstClient = new HubClient(first.listenUrl);
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
		const client = new HubClient(restarted.listenUrl);
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
		expect((await new HubClient(recovered.listenUrl).meta()).dataDir).toBe(root);
	});

	test("HTTP acknowledgment rejects batches above the storage cap", async () => {
		const root = dataDir();
		const hub = await startHubServer({ port: 0, dataDir: root });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "ack-cap" });
		const worker = await client.register({ project: "ack-cap", agentId: "worker", cwd: "/worker", pid: 1 });

		const response = await fetch(`${hub.listenUrl}/v1/inbox/ack`, {
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

	test("registration validates every persisted member field", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "register-shape" });
		const invalidBodies = [
			null,
			{ project: "register-shape", agentId: "worker", cwd: "   " },
			{ project: "register-shape", agentId: "worker", cwd: "/worker", pid: 1.5 },
			{ project: "register-shape", agentId: "worker", cwd: "/worker", caps: ["tools", 1] },
			{ project: "register-shape", agentId: "worker", cwd: "/worker", displayName: 1 },
			{ project: "register-shape", agentId: "worker", cwd: "/worker", sessionId: [] },
		];

		for (const body of invalidBodies) {
			const response = await fetch(`${hub.listenUrl}/v1/register`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
		}
		expect(await client.listMembers("register-shape", true)).toEqual([]);
	});

	test("send rejects invalid claimed sender identities", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "sender-shape" });
		const worker = await client.register({ project: "sender-shape", agentId: "worker", cwd: "/worker", pid: 1 });

		const response = await fetch(`${hub.listenUrl}/v1/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: "sender-shape",
				from: "../controller",
				to: "worker",
				payload: { encoding: "identity", data: "work", uncompressedBytes: 4 },
			}),
		});

		expect(response.status).toBe(400);
		expect(await client.inbox("sender-shape", "worker", 500, worker.leaseId)).toEqual([]);
	});

	test("send maps malformed nonblank causal references to HTTP 400", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "causal-shape" });
		await client.register({ project: "causal-shape", agentId: "worker", cwd: "/worker", pid: 1 });

		const response = await fetch(`${hub.listenUrl}/v1/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: "causal-shape",
				from: "controller",
				to: "worker",
				payload: { encoding: "identity", data: "work", uncompressedBytes: 4 },
				replyToRef: "not-a-ref",
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid messageRef: not-a-ref" });
	});

	test("Inbox limits must be integers within the storage bound", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "limit-shape" });
		const worker = await client.register({ project: "limit-shape", agentId: "worker", cwd: "/worker", pid: 1 });
		const headers = { "x-a2a-lease": worker.leaseId };

		for (const limit of ["0", "1.5", String(MAX_INBOX_BATCH_MESSAGES + 1), "invalid"]) {
			const response = await fetch(
				`${hub.listenUrl}/v1/inbox?project=limit-shape&agentId=worker&limit=${limit}`,
				{ headers },
			);
			expect(response.status).toBe(400);
		}
		for (const limit of [0, 1.5, MAX_INBOX_BATCH_MESSAGES + 1, "1"]) {
			const response = await fetch(`${hub.listenUrl}/v1/inbox/read`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					project: "limit-shape",
					agentId: "worker",
					leaseId: worker.leaseId,
					limit,
				}),
			});
			expect(response.status).toBe(400);
		}
		expect(
			(
				await fetch(`${hub.listenUrl}/v1/inbox?project=limit-shape&agentId=worker&limit=1`, {
					headers,
				})
			).status,
		).toBe(200);
	});

	test("gzip expansion past the decoded limit maps to HTTP 413", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "inflate-limit" });
		await client.register({ project: "inflate-limit", agentId: "worker", cwd: "/worker", pid: 1 });
		const compressed = gzipSync(Buffer.from("x".repeat(MAX_TEXT_BYTES + 2))).toString("base64");

		const response = await fetch(`${hub.listenUrl}/v1/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: "inflate-limit",
				from: "controller",
				to: "worker",
				payload: {
					encoding: "gzip+base64",
					data: compressed,
					uncompressedBytes: MAX_TEXT_BYTES,
				},
			}),
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			error: `message text exceeds ${MAX_TEXT_BYTES} bytes after decoding`,
		});
	});

	test("unexpected Inbox storage failures map to HTTP 500", async () => {
		const root = dataDir();
		const hub = await startHubServer({ port: 0, dataDir: root });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "storage-failure" });
		await client.register({ project: "storage-failure", agentId: "worker", cwd: "/worker", pid: 1 });
		const database = new Database(join(root, "inbox.sqlite"));
		database.run(`
			CREATE TRIGGER reject_inbox_insert
			BEFORE INSERT ON inbox_messages
			BEGIN
				SELECT RAISE(FAIL, 'forced storage failure');
			END
		`);
		database.close();

		const response = await fetch(`${hub.listenUrl}/v1/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: "storage-failure",
				from: "controller",
				to: "worker",
				payload: { encoding: "identity", data: "work", uncompressedBytes: 4 },
			}),
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "forced storage failure" });
	});

	test("corrupt Registry JSON maps to HTTP 500 instead of a domain miss", async () => {
		const root = dataDir();
		const hub = await startHubServer({ port: 0, dataDir: root });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "corrupt-registry" });
		writeFileSync(projectMetaPath("corrupt-registry", root), "{");

		const response = await fetch(`${hub.listenUrl}/v1/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: "corrupt-registry",
				agentId: "worker",
				cwd: "/worker",
				pid: 1,
			}),
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: expect.stringContaining("invalid Registry JSON") });
	});

	test("Hub shutdown force-closes connections after its grace period", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir(), shutdownGraceMs: 20 });
		hubs.push(hub);
		const target = new URL(hub.listenUrl);
		const socket = createConnection(Number(target.port), target.hostname);
		await once(socket, "connect");
		socket.write(`GET /healthz HTTP/1.1\r\nHost: ${target.host}\r\n`);
		const closed = once(socket, "close");

		await Promise.race([
			hub.stop(),
			Bun.sleep(500).then(() => {
				throw new Error("Hub shutdown exceeded its bounded grace period");
			}),
		]);
		await closed;
		expect(socket.destroyed).toBe(true);
	});

	test("a project cannot be deleted while a member is active", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
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
			const prior = new HubClient(hub.listenUrl);
			const replacement = new HubClient(hub.listenUrl);
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
