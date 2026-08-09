import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../src/hub/client";
import { A2aConnection } from "../src/hub/connection";
import { type HubServerHandle, startHubServer } from "../src/hub/server";
import {
	hubMetaPath,
	hubPidPath,
	messageDatabasePath,
	projectDeletionMarkerPath,
	projectDir,
	projectMetaPath,
} from "../src/paths";

const roots: string[] = [];
const hubs: HubServerHandle[] = [];

function dataDir(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-control-"));
	roots.push(root);
	return root;
}

function writeDeletionMarker(project: string, root: string): string {
	const marker = projectDeletionMarkerPath(project, root);
	mkdirSync(join(root, "run", "project-deletions"), { recursive: true });
	writeFileSync(marker, JSON.stringify({ project, startedAt: Date.now() }));
	return marker;
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
	test("blank Hub data directories are rejected before startup", async () => {
		for (const value of ["", " \t"]) {
			await expect(
				startHubServer({ port: 0, dataDir: value }),
			).rejects.toThrow("Hub data directory cannot be empty");
		}
	});

	test("different Hub data directories own independent Projects", async () => {
		const first = await startHubServer({ port: 0, dataDir: dataDir() });
		const second = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(first, second);
		const firstClient = new HubClient(first.listenUrl);
		const secondClient = new HubClient(second.listenUrl);
		await firstClient.createProject({ name: "alpha" });

		expect(
			(await firstClient.listProjects()).map((project) => project.name),
		).toEqual(["alpha"]);
		expect(await secondClient.listProjects()).toEqual([]);
	});

	test("embedded startup ignores deployment environment variables", async () => {
		const keys = [
			"OMP_A2A_HUB_PORT",
			"OMP_A2A_HUB_HOST",
			"OMP_A2A_HUB_PUBLIC_URL",
			"OMP_A2A_HUB_DATA_DIR",
		] as const;
		const previous = Object.fromEntries(
			keys.map((key) => [key, process.env[key]]),
		) as Record<(typeof keys)[number], string | undefined>;
		const root = dataDir();
		const hostileRoot = dataDir();
		process.env.OMP_A2A_HUB_PORT = "not-a-port";
		process.env.OMP_A2A_HUB_HOST = "0.0.0.0";
		process.env.OMP_A2A_HUB_PUBLIC_URL = "http://127.0.0.1:1";
		process.env.OMP_A2A_HUB_DATA_DIR = hostileRoot;
		try {
			const hub = await startHubServer({ port: 0, dataDir: root });
			hubs.push(hub);
			expect(hub.meta.dataDir).toBe(root);
			expect(hub.meta.baseUrl).toBe(hub.listenUrl);
			expect(hub.listenUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
		} finally {
			for (const key of keys) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
		}
	});

	test("public and listener URLs remain independent and normalized", async () => {
		const hub = await startHubServer({
			port: 0,
			publicUrl: "https://mesh.example.internal/base///",
			dataDir: dataDir(),
		});
		hubs.push(hub);
		expect(hub.meta.baseUrl).toBe("https://mesh.example.internal/base");
		expect(hub.listenUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
		expect(hub.listenUrl).not.toBe(hub.meta.baseUrl);
		expect((await new HubClient(hub.listenUrl).meta()).baseUrl).toBe(
			"https://mesh.example.internal/base",
		);
	});

	test("wildcard binds require a public URL and expose a reachable listenUrl", async () => {
		for (const host of ["0.0.0.0", "0:0:0:0:0:0:0:0"]) {
			await expect(
				startHubServer({ port: 0, host, dataDir: dataDir() }),
			).rejects.toThrow("public URL is required");
		}
		const ipv4 = await startHubServer({
			port: 0,
			host: "0.0.0.0",
			publicUrl: "https://mesh.example.internal",
			dataDir: dataDir(),
		});
		hubs.push(ipv4);
		expect(ipv4.listenUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
		expect((await new HubClient(ipv4.listenUrl).meta()).baseUrl).toBe(
			"https://mesh.example.internal",
		);

		const ipv6 = await startHubServer({
			port: 0,
			host: "::",
			publicUrl: "https://mesh-v6.example.internal",
			dataDir: dataDir(),
		});
		hubs.push(ipv6);
		expect(ipv6.listenUrl).toMatch(/^http:\/\/\[::1\]:/);
	});

	test("concrete IPv6 listeners are advertised with brackets", async () => {
		const hub = await startHubServer({
			port: 0,
			host: "::1",
			dataDir: dataDir(),
		});
		hubs.push(hub);
		expect(hub.listenUrl).toMatch(/^http:\/\/\[::1\]:/);
		expect(hub.meta.baseUrl).toBe(hub.listenUrl);
	});

	test("invalid public URLs are rejected before acquiring Hub resources", async () => {
		const root = dataDir();
		for (const publicUrl of [
			"",
			"ftp://mesh.example.internal",
			"http://0.0.0.0:4173",
			"http://mesh.example.internal?",
			"http://mesh.example.internal#",
			"http://user:secret@mesh.example.internal",
		]) {
			await expect(
				startHubServer({ port: 0, publicUrl, dataDir: root }),
			).rejects.toThrow();
		}
		const recovered = await startHubServer({ port: 0, dataDir: root });
		hubs.push(recovered);
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
				baseUrl: hub.listenUrl,
				project: "missing",
				name: "api",
			}),
		).rejects.toThrow("claim_rejected");
	});

	test("Project deletion is idempotent and rejects active Presences", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "active" });
		const connection = await A2aConnection.connect({
			baseUrl: hub.listenUrl,
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

	test("deleting and recreating a Project does not reuse its history", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "reused" });
		const api = await A2aConnection.connect({
			baseUrl: hub.listenUrl,
			project: "reused",
			name: "api",
		});
		const web = await A2aConnection.connect({
			baseUrl: hub.listenUrl,
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
		expect(await client.history({ project: "reused" })).toEqual({
			messages: [],
		});
	});

	test("a failed cross-store deletion leaves a marker and restart converges", async () => {
		const root = dataDir();
		const first = await startHubServer({ port: 0, dataDir: root });
		hubs.push(first);
		const client = new HubClient(first.listenUrl);
		await client.createProject({ name: "interrupted" });
		const sender = await A2aConnection.connect({
			baseUrl: first.listenUrl,
			project: "interrupted",
			name: "sender",
		});
		const receiver = await A2aConnection.connect({
			baseUrl: first.listenUrl,
			project: "interrupted",
			name: "receiver",
		});
		await sender.send({
			target: { type: "agent", name: "receiver" },
			text: "must be purged",
			messageId: "interrupted-old",
		});
		await sender.close();
		await receiver.close();

		const database = new Database(messageDatabasePath(root));
		database.run(`
			CREATE TRIGGER reject_project_delete
			BEFORE DELETE ON messages
			BEGIN
				SELECT RAISE(FAIL, 'forced deletion failure');
			END
		`);
		database.close();
		await expect(client.deleteProject("interrupted")).rejects.toThrow(
			"forced deletion failure",
		);
		const marker = projectDeletionMarkerPath("interrupted", root);
		expect(existsSync(marker)).toBe(true);
		expect(existsSync(projectDir("interrupted", root))).toBe(false);
		await first.stop();

		const repair = new Database(messageDatabasePath(root));
		repair.run("DROP TRIGGER reject_project_delete");
		repair.close();
		const restarted = await startHubServer({ port: 0, dataDir: root });
		hubs.push(restarted);
		expect(existsSync(marker)).toBe(false);
		const restartedClient = new HubClient(restarted.listenUrl);
		await restartedClient.createProject({ name: "interrupted" });
		expect(
			await restartedClient.history({ project: "interrupted" }),
		).toEqual({ messages: [] });
	});

	test("startup reconciliation removes missing-metadata orphans and history", async () => {
		const root = dataDir();
		const first = await startHubServer({ port: 0, dataDir: root });
		hubs.push(first);
		const client = new HubClient(first.listenUrl);
		await client.createProject({ name: "orphaned" });
		const sender = await A2aConnection.connect({
			baseUrl: first.listenUrl,
			project: "orphaned",
			name: "sender",
		});
		const receiver = await A2aConnection.connect({
			baseUrl: first.listenUrl,
			project: "orphaned",
			name: "receiver",
		});
		await sender.send({
			target: { type: "agent", name: "receiver" },
			text: "orphan history",
		});
		await sender.close();
		await receiver.close();
		await first.stop();

		rmSync(projectMetaPath("orphaned", root));
		writeFileSync(join(projectDir("orphaned", root), "partial-state"), "partial");
		const marker = writeDeletionMarker("orphaned", root);
		const restarted = await startHubServer({ port: 0, dataDir: root });
		hubs.push(restarted);
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(projectDir("orphaned", root))).toBe(false);
		const restartedClient = new HubClient(restarted.listenUrl);
		await restartedClient.createProject({ name: "orphaned" });
		expect(await restartedClient.history({ project: "orphaned" })).toEqual({
			messages: [],
		});
	});

	test("deletion markers block name reuse until startup reconciliation", async () => {
		const root = dataDir();
		const first = await startHubServer({ port: 0, dataDir: root });
		hubs.push(first);
		const client = new HubClient(first.listenUrl);
		await client.createProject({ name: "blocked-name" });
		const marker = writeDeletionMarker("blocked-name", root);
		await expect(
			A2aConnection.connect({
				baseUrl: first.listenUrl,
				project: "blocked-name",
				name: "api",
			}),
		).rejects.toThrow("deletion pending");
		await expect(
			client.createProject({ name: "blocked-name" }),
		).rejects.toThrow("deletion pending");
		await first.stop();

		const restarted = await startHubServer({ port: 0, dataDir: root });
		hubs.push(restarted);
		expect(existsSync(marker)).toBe(false);
		await expect(
			new HubClient(restarted.listenUrl).createProject({
				name: "blocked-name",
			}),
		).resolves.toMatchObject({ name: "blocked-name" });
	});

	test("post-listen PID publication failure releases listener, store, lock, and runtime files", async () => {
		const root = dataDir();
		const reservation = await startHubServer({ port: 0, dataDir: root });
		const fixedPort = reservation.meta.port;
		await reservation.stop();
		mkdirSync(hubPidPath(root), { recursive: true });

		await expect(
			startHubServer({ port: fixedPort, dataDir: root }),
		).rejects.toThrow();
		expect(existsSync(hubMetaPath(root))).toBe(false);
		expect(existsSync(hubPidPath(root))).toBe(false);

		const recovered = await startHubServer({ port: fixedPort, dataDir: root });
		hubs.push(recovered);
		expect((await new HubClient(recovered.listenUrl).meta()).dataDir).toBe(root);
	});

	test("Project create bodies are strictly validated", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const invalidBodies: unknown[] = [
			null,
			[],
			{},
			{ name: 1 },
			{ name: "shape", displayName: 1 },
			{ name: "shape", description: [] },
			{ name: "shape", createdByCwd: false },
			{ name: "../escape" },
			{ name: "shape", dataDir: "/injected" },
			{ name: "shape", unknown: true },
		];
		for (const body of invalidBodies) {
			const response = await fetch(`${hub.listenUrl}/v1/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain("application/json");
		}
		expect(await new HubClient(hub.listenUrl).listProjects()).toEqual([]);
	});

	test("malformed JSON receives the final JSON error adapter", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		const response = await fetch(`${hub.listenUrl}/v1/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toHaveProperty("error");
	});

	test("history limits must be integers from 1 through 500", async () => {
		const hub = await startHubServer({ port: 0, dataDir: dataDir() });
		hubs.push(hub);
		await new HubClient(hub.listenUrl).createProject({ name: "limits" });
		for (const limit of ["0", "1.5", "501", "-1", "invalid", ""]) {
			const response = await fetch(
				`${hub.listenUrl}/v1/history?project=limits&limit=${encodeURIComponent(limit)}`,
			);
			expect(response.status).toBe(400);
		}
		const unknown = await fetch(
			`${hub.listenUrl}/v1/history?project=limits&limti=1`,
		);
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toEqual({
			error: "unknown history query parameter: limti",
		});
		for (const limit of ["1", "500"]) {
			const response = await fetch(
				`${hub.listenUrl}/v1/history?project=limits&limit=${limit}`,
			);
			expect(response.status).toBe(200);
		}
	});

	test("Registry corruption and filesystem persistence failures return JSON 500", async () => {
		const root = dataDir();
		const hub = await startHubServer({ port: 0, dataDir: root });
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "corrupt" });
		writeFileSync(projectMetaPath("corrupt", root), "{");
		for (const url of [
			`${hub.listenUrl}/v1/projects`,
			`${hub.listenUrl}/v1/history?project=corrupt`,
		]) {
			const response = await fetch(url);
			expect(response.status).toBe(500);
			expect(response.headers.get("content-type")).toContain("application/json");
			expect(await response.json()).toEqual({
				error: expect.stringContaining("invalid Registry JSON"),
			});
		}

		writeFileSync(projectDir("unwritable", root), "not a directory");
		const response = await fetch(`${hub.listenUrl}/v1/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "unwritable" }),
		});
		expect(response.status).toBe(500);
		expect(response.headers.get("content-type")).toContain("application/json");
	});

	test("unexpected SQLite history failures return JSON 500", async () => {
		const root = dataDir();
		const hub = await startHubServer({ port: 0, dataDir: root });
		hubs.push(hub);
		await new HubClient(hub.listenUrl).createProject({ name: "sqlite-failure" });
		const database = new Database(messageDatabasePath(root));
		database.run("DROP TABLE messages");
		database.close();

		const response = await fetch(
			`${hub.listenUrl}/v1/history?project=sqlite-failure`,
		);
		expect(response.status).toBe(500);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toHaveProperty("error");
	});
});
