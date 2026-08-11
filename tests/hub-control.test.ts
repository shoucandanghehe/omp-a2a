import { afterEach, describe, expect, test } from "bun:test";
import {
	accessSync,
	constants,
	existsSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HubClient } from "../src/hub/client";
import { parseHubCliOptions } from "../src/hub/cli";
import { A2aConnection } from "../src/hub/connection";
import { A2A_PROTOCOL_VERSION } from "../src/hub/realtime-types";
import { type HubServerHandle, startHubServer } from "../src/hub/server";

const roots: string[] = [];
const hubs: HubServerHandle[] = [];
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

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

test("listener metadata stays minimal and configured client URL remains authoritative", async () => {
	const root = dataDir();
	const previousPort = process.env.OMP_A2A_HUB_PORT;
	const previousHost = process.env.OMP_A2A_HUB_HOST;
	const previousDataDir = process.env.OMP_A2A_HUB_DATA_DIR;
	process.env.OMP_A2A_HUB_PORT = "not-a-port";
	process.env.OMP_A2A_HUB_HOST = "ignored.invalid";
	process.env.OMP_A2A_HUB_DATA_DIR = join(root, "ignored");
	try {
		const hub = await startHubServer({
			host: "0.0.0.0",
			port: 0,
			dataDir: root,
		});
		hubs.push(hub);
		expect(hub.listenUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(await (await fetch(`${hub.listenUrl}/v1/meta`)).json()).toEqual({
			protocolVersion: A2A_PROTOCOL_VERSION,
		});
		expect(await (await fetch(`${hub.listenUrl}/healthz`)).json()).toEqual({
			ok: true,
			service: "omp-a2a-hub",
		});
		expect(existsSync(join(root, "run", "hub.json"))).toBe(false);
		expect(existsSync(join(root, "run", "hub.pid"))).toBe(false);

		const client = await HubClient.connect({ hubUrl: `${hub.listenUrl}/` });
		expect(client.baseUrl).toBe(hub.listenUrl);
		await client.createProject({ name: "configured-route" });
		const connection = await A2aConnection.connect({
			baseUrl: client.baseUrl,
			project: "configured-route",
			name: "remote",
		});
		expect(connection.self.name).toBe("remote");
		await connection.close();
		await hub.stop();
		expect(existsSync(join(root, "run", "hub.json"))).toBe(false);
		expect(existsSync(join(root, "run", "hub.pid"))).toBe(false);
	} finally {
		if (previousPort === undefined) delete process.env.OMP_A2A_HUB_PORT;
		else process.env.OMP_A2A_HUB_PORT = previousPort;
		if (previousHost === undefined) delete process.env.OMP_A2A_HUB_HOST;
		else process.env.OMP_A2A_HUB_HOST = previousHost;
		if (previousDataDir === undefined) delete process.env.OMP_A2A_HUB_DATA_DIR;
		else process.env.OMP_A2A_HUB_DATA_DIR = previousDataDir;
	}
});

test("CLI options use flag then environment then default precedence", () => {
	const environment = {
		OMP_A2A_HUB_HOST: "environment-host",
		OMP_A2A_HUB_PORT: "5000",
		OMP_A2A_HUB_DATA_DIR: "/environment-data",
	};
	expect(parseHubCliOptions([], environment)).toEqual({
		host: "environment-host",
		port: 5000,
		dataDir: "/environment-data",
	});
	expect(
		parseHubCliOptions(
			["--host=flag-host", "--port", "6000", "--data-dir=/flag-data"],
			environment,
		),
	).toEqual({
		host: "flag-host",
		port: 6000,
		dataDir: "/flag-data",
	});
	expect(parseHubCliOptions([], {})).toMatchObject({
		host: "127.0.0.1",
		port: 4173,
	});
});

test("CLI rejects empty and unknown flags", () => {
	for (const argument of ["--port=", "--host=", "--data-dir="]) {
		expect(() => parseHubCliOptions([argument], {})).toThrow("empty value");
	}
	expect(() => parseHubCliOptions(["--unknown"], {})).toThrow(
		"unknown Hub argument",
	);
});

test("package Hub executable runs directly", async () => {
	const manifest = await Bun.file(
		join(repositoryRoot, "package.json"),
	).json();
	const executable = join(repositoryRoot, manifest.bin["omp-a2a-hub"] ?? "");
	accessSync(executable, constants.X_OK);
	const result = Bun.spawnSync([executable, "--unknown"]);
	expect(result.exitCode).not.toBe(0);
	expect(new TextDecoder().decode(result.stderr)).toContain(
		"unknown Hub argument",
	);
});

test("Compose resolves non-default published port and resource limits", () => {
	const result = Bun.spawnSync({
		cmd: ["docker", "compose", "config", "--format", "json"],
		cwd: repositoryRoot,
		env: {
			...process.env,
			OMP_A2A_HUB_PORT: "5180",
			OMP_A2A_HUB_MEM_LIMIT: "314572800",
			OMP_A2A_HUB_CPUS: "1.25",
			OMP_A2A_HUB_PIDS_LIMIT: "123",
		},
	});
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
	const service = JSON.parse(
		new TextDecoder().decode(result.stdout),
	).services.hub;
	expect(service.ports).toContainEqual(
		expect.objectContaining({ target: 4173, published: "5180" }),
	);
	expect(Number(service.mem_limit)).toBe(314_572_800);
	expect(Number(service.cpus)).toBe(1.25);
	expect(Number(service.pids_limit)).toBe(123);
	expect(service.restart).toBe("unless-stopped");
});

describe("Hub Project control plane", () => {
	test("different Hub data directories own independent Projects", async () => {
		const first = await startHubServer({
			host: "127.0.0.1",
			port: 0,
			dataDir: dataDir(),
		});
		const second = await startHubServer({
			host: "127.0.0.1",
			port: 0,
			dataDir: dataDir(),
		});
		hubs.push(first, second);
		const firstClient = new HubClient(first.listenUrl);
		const secondClient = new HubClient(second.listenUrl);
		await firstClient.createProject({ name: "alpha" });

		expect(
			(await firstClient.listProjects()).map((project) => project.name),
		).toEqual(["alpha"]);
		expect(await secondClient.listProjects()).toEqual([]);
	});

	test("the same Hub data directory cannot be opened twice", async () => {
		const root = dataDir();
		const hub = await startHubServer({
			host: "127.0.0.1",
			port: 0,
			dataDir: root,
		});
		hubs.push(hub);
		await expect(
			startHubServer({ host: "127.0.0.1", port: 0, dataDir: root }),
		).rejects.toThrow(
			"already in use",
		);
	});

	test("connecting to an unknown Project fails at the claim boundary", async () => {
		const hub = await startHubServer({
			host: "127.0.0.1",
			port: 0,
			dataDir: dataDir(),
		});
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
		const hub = await startHubServer({
			host: "127.0.0.1",
			port: 0,
			dataDir: dataDir(),
		});
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
});

test("deleting and recreating a Project does not reuse its history", async () => {
	const hub = await startHubServer({
		host: "127.0.0.1",
		port: 0,
		dataDir: dataDir(),
	});
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
	expect(await client.history({ project: "reused" })).toEqual({ messages: [] });
});
