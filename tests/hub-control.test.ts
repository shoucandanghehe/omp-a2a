import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	accessSync,
	constants,
	existsSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHubCliOptions } from "../src/hub/cli";
import { HubClient } from "../src/hub/client";
import { A2aConnection } from "../src/hub/connection";
import { A2A_PROTOCOL_VERSION } from "../src/hub/realtime-types";
import { type HubServerHandle, startHubServer } from "../src/hub/server";
import { MESSAGE_STORAGE_VERSION } from "../src/hub/store";

const roots: string[] = [];
const UNSUPPORTED_STORAGE_MESSAGE =
	"unsupported pre-release storage; start with an empty data directory";
const hubs: HubServerHandle[] = [];
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function dataDir(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-control-"));
	roots.push(root);
	return root;
}

async function readFirstLine(
	stream: ReadableStream<Uint8Array>,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) return output + decoder.decode();
			output += decoder.decode(value, { stream: true });
			const newline = output.indexOf("\n");
			if (newline >= 0) return output.slice(0, newline);
		}
	} finally {
		reader.releaseLock();
	}
}

async function withDeadline<T>(
	operation: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	// This bounds an external process pipe; fake timers cannot advance the child.
	const deadlineSignal = AbortSignal.timeout(timeoutMs);
	let rejectDeadline: (reason: Error) => void;
	const deadline = new Promise<never>((_, reject) => {
		rejectDeadline = reject;
	});
	const onDeadline = () => {
		rejectDeadline(
			new Error(`timed out waiting for CLI readiness after ${timeoutMs}ms`),
		);
	};
	deadlineSignal.addEventListener("abort", onDeadline, { once: true });
	try {
		return await Promise.race([operation, deadline]);
	} finally {
		deadlineSignal.removeEventListener("abort", onDeadline);
	}
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
		expect(Object.keys(hub).sort()).toEqual(["listenUrl", "stop"]);
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

test("CLI rejects present blank environment settings", () => {
	for (const name of [
		"OMP_A2A_HUB_PORT",
		"OMP_A2A_HUB_HOST",
		"OMP_A2A_HUB_DATA_DIR",
	]) {
		expect(() => parseHubCliOptions([], { [name]: " \t " })).toThrow(
			"empty value",
		);
	}
});

test("package Hub executable runs directly", async () => {
	const manifest = await Bun.file(join(repositoryRoot, "package.json")).json();
	const executable = join(repositoryRoot, manifest.bin["omp-a2a-hub"] ?? "");
	accessSync(executable, constants.X_OK);
	const result = Bun.spawnSync([executable, "--unknown"]);
	expect(result.exitCode).not.toBe(0);
	expect(new TextDecoder().decode(result.stderr)).toContain(
		"unknown Hub argument",
	);
});

test("CLI readiness is minimal and does not advertise a route", async () => {
	const manifest = await Bun.file(join(repositoryRoot, "package.json")).json();
	const executable = join(repositoryRoot, manifest.bin["omp-a2a-hub"] ?? "");
	const process = Bun.spawn({
		cmd: [
			executable,
			"--host",
			"127.0.0.1",
			"--port",
			"0",
			"--data-dir",
			dataDir(),
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const readiness = JSON.parse(
			await withDeadline(readFirstLine(process.stdout), 5_000),
		);
		expect(readiness).toEqual({
			ok: true,
			service: "omp-a2a-hub",
			protocolVersion: A2A_PROTOCOL_VERSION,
		});
	} finally {
		try {
			process.kill("SIGTERM");
		} finally {
			await process.exited;
		}
	}
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
	const service = JSON.parse(new TextDecoder().decode(result.stdout)).services
		.hub;
	expect(service.environment).toBeUndefined();
	expect(service.ports).toContainEqual(
		expect.objectContaining({ target: 4173, published: "5180" }),
	);
	expect(Number(service.mem_limit)).toBe(314_572_800);
	expect(Number(service.cpus)).toBe(1.25);
	expect(Number(service.pids_limit)).toBe(123);
	expect(service.restart).toBe("unless-stopped");
});

test("Hub rejects unsupported message storage before listening", async () => {
	const root = dataDir();
	const database = new Database(join(root, "messages.sqlite"), {
		create: true,
	});
	database.run("CREATE TABLE messages (id TEXT)");
	database.run(`PRAGMA user_version = ${MESSAGE_STORAGE_VERSION + 1}`);
	database.close();

	await expect(
		startHubServer({ host: "127.0.0.1", port: 0, dataDir: root }),
	).rejects.toThrow(UNSUPPORTED_STORAGE_MESSAGE);
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

	test("control requests have no application body cap", async () => {
		const hub = await startHubServer({
			host: "127.0.0.1",
			port: 0,
			dataDir: dataDir(),
		});
		hubs.push(hub);
		const description = "x".repeat(6 * 1024 * 1024 + 1);
		const project = await new HubClient(hub.listenUrl).createProject({
			name: "large-control-body",
			description,
		});
		expect(project.description).toBe(description);
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
		).rejects.toThrow("already in use");
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
		const hub = await startHubServer({
			host: "127.0.0.1",
			port: 0,
			dataDir: dataDir(),
		});
		hubs.push(hub);
		const client = new HubClient(hub.listenUrl);
		await client.createProject({ name: "deleted-first" });
		expect(await client.deleteProject("deleted-first")).toBe(true);

		await expect(
			A2aConnection.connect({
				baseUrl: hub.listenUrl,
				project: "deleted-first",
				name: "api",
			}),
		).rejects.toThrow("unknown project: deleted-first");
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

test("listener startup failure releases the SQLite store and data lock", async () => {
	const root = dataDir();
	const blocker = createServer();
	await new Promise<void>((resolve, reject) => {
		blocker.once("error", reject);
		blocker.listen(0, "127.0.0.1", resolve);
	});
	const address = blocker.address();
	if (!address || typeof address === "string")
		throw new Error("port blocker did not expose a TCP address");
	const port = address.port;

	try {
		await expect(
			startHubServer({
				host: "127.0.0.1",
				port,
				dataDir: root,
			}),
		).rejects.toThrow();
	} finally {
		await new Promise<void>((resolve, reject) =>
			blocker.close((error) => (error ? reject(error) : resolve())),
		);
	}
	const restarted = await startHubServer({
		host: "127.0.0.1",
		port,
		dataDir: root,
	});
	hubs.push(restarted);
	const client = new HubClient(restarted.listenUrl);
	expect((await client.listProjects()).length).toBe(0);
});

test("concurrent stops share and await one cleanup", async () => {
	const root = dataDir();
	const hub = await startHubServer({
		host: "127.0.0.1",
		port: 0,
		dataDir: root,
	});
	const port = Number(new URL(hub.listenUrl).port);
	const firstStop = hub.stop();
	const secondStop = hub.stop();

	expect(secondStop).toBe(firstStop);
	await Promise.all([firstStop, secondStop]);
	const restarted = await startHubServer({
		host: "127.0.0.1",
		port,
		dataDir: root,
	});
	hubs.push(restarted);
});
