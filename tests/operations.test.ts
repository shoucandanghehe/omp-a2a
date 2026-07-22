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
	const client = new HubClient(hub.listenUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });

	await operations.execute({ action: "project_create", project: "shared" }, { cwd: "/repo" });
	const listed = await operations.execute({ action: "project_list" }, { cwd: "/repo" });

	expect((await client.listProjects()).map((project) => project.name)).toEqual(["shared"]);
	expect(listed.text).toContain("shared");
});

test("A2aOperations deletes an inactive project through the connected Hub", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.listenUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "retired" }, { cwd: "/repo" });

	const deleted = await operations.execute({ action: "project_delete", project: "retired" }, { cwd: "/repo" });

	expect(deleted.text).toBe("Deleted A2A project retired");
	expect(await client.listProjects()).toEqual([]);
});

test("leave uses the Hub that accepted the membership", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.listenUrl);
	let selectedClientAvailable = true;
	const operations = new A2aOperations({
		getClient: async () => {
			if (!selectedClientAvailable) throw new Error("selected Hub unavailable");
			return client;
		},
		pid: 123,
	});
	await operations.execute({ action: "project_create", project: "leave" }, { cwd: "/repo" });
	await operations.execute(
		{ action: "join", project: "leave", agentId: "worker" },
		{ cwd: "/repo", sessionId: "session" },
	);
	selectedClientAvailable = false;

	const result = await operations.execute({ action: "leave" }, { cwd: "/repo" });

	expect(result.cleanupPending).toBe(false);
	expect(result.membershipChanged).toBe("left");
	expect(operations.membership).toBeNull();
});

test("leave reports pending cleanup when the bound Hub is unavailable", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.listenUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "leave" }, { cwd: "/repo" });
	await operations.execute(
		{ action: "join", project: "leave", agentId: "worker" },
		{ cwd: "/repo", sessionId: "session" },
	);
	await hub.stop();
	hub = null;

	const result = await operations.execute({ action: "leave" }, { cwd: "/repo" });

	expect(result.cleanupPending).toBe(true);
	expect(result.membershipChanged).toBe("left");
	expect(operations.membership).toBeNull();
});

test("failed delivery remains pending until a successful delivery is acknowledged", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.listenUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "delivery" }, { cwd: "/repo" });
	await operations.execute(
		{ action: "join", project: "delivery", agentId: "worker" },
		{ cwd: "/repo", sessionId: "session" },
	);
	await client.register({ project: "delivery", agentId: "controller", cwd: "/controller", pid: 456 });
	await client.send({ project: "delivery", from: "controller", to: "worker", text: "work" });

	await expect(
		operations.receive(() => {
			throw new Error("injection failed");
		}),
	).rejects.toThrow("injection failed");
	expect(await client.inbox("delivery", "worker")).toHaveLength(1);
	expect(await client.inbox("delivery", "controller")).toEqual([]);

	const repeated: string[] = [];
	expect(
		await operations.receive((message) => {
			repeated.push(message.text);
		}),
	).toBe(1);
	expect(repeated).toEqual(["work"]);
	expect(await client.inbox("delivery", "controller")).toHaveLength(1);
});

test("aborting delivery before acknowledgment leaves the message pending", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.listenUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "abort-delivery" }, { cwd: "/repo" });
	await operations.execute(
		{ action: "join", project: "abort-delivery", agentId: "worker" },
		{ cwd: "/repo", sessionId: "session" },
	);
	await client.send({ project: "abort-delivery", from: "controller", to: "worker", text: "work" });
	const controller = new AbortController();

	await expect(
		operations.receive(() => controller.abort(new Error("membership changed")), controller.signal),
	).rejects.toThrow("membership changed");

	expect(await client.inbox("abort-delivery", "worker")).toHaveLength(1);
});

test("aborting a stalled Inbox read terminates receive promptly", async () => {
	let receivedSignal: AbortSignal | undefined;
	const fakeClient = {
		baseUrl: "http://hub.example",
		async register() {
			return {
				member: {
					project: "stalled",
					agentId: "worker",
					cwd: "/repo",
					pid: 123,
					caps: [],
					joinedAt: 1,
					lastSeenAt: 1,
					status: "online" as const,
				},
				hub: {
					pid: 1,
					port: 4173,
					baseUrl: "http://hub.example",
					dataDir: "/data",
					startedAt: 1,
				},
				leaseId: "lease",
			};
		},
		async listMembers() {
			return [];
		},
		readInbox(
			_project: string,
			_agentId: string,
			_limit: number,
			_leaseId: string,
			signal?: AbortSignal,
		) {
			receivedSignal = signal;
			return new Promise<never>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		},
	} as unknown as HubClient;
	const operations = new A2aOperations({ getClient: async () => fakeClient, pid: 123 });
	await operations.execute({ action: "join", project: "stalled", agentId: "worker" }, { cwd: "/repo" });
	const controller = new AbortController();

	const receiving = operations.receive(() => undefined, controller.signal);
	controller.abort(new Error("membership changed"));

	await expect(receiving).rejects.toThrow("membership changed");
	expect(receivedSignal).toBe(controller.signal);
	expect(operations.membership).toEqual({
		project: "stalled",
		agentId: "worker",
		hubBaseUrl: "http://hub.example",
	});
});

test("send uses the joined membership as the claimed sender", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.listenUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "send" }, { cwd: "/repo" });
	await client.register({ project: "send", agentId: "worker", cwd: "/worker", pid: 456 });
	await operations.execute({ action: "join", project: "send", agentId: "controller" }, { cwd: "/repo" });

	const result = await operations.execute({ action: "send", to: "worker", text: "hello" }, { cwd: "/repo" });

	expect(result.text).toContain("Queued for worker");
	expect(result.text).toContain("ref=worker:1");
	expect(result.text).toContain("Never wait, sleep, or poll inbox for a reply after send");
	expect((await client.inbox("send", "worker"))[0]?.text).toBe("hello");
	const correction = await operations.execute(
		{ action: "send", to: "worker", text: "corrected", replyToRef: "worker:1" },
		{ cwd: "/repo" },
	);
	expect(correction.text).toContain("ref=worker:2");
	expect(correction.text).toContain("replyTo=worker:1");
	expect((await client.inbox("send", "worker"))[1]).toMatchObject({
		messageRef: "worker:2",
		replyToRef: "worker:1",
	});
});

test("read-only operations report the connected Hub and joined membership", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.listenUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "status" }, { cwd: "/repo" });
	await operations.execute({ action: "join", project: "status", agentId: "controller" }, { cwd: "/repo" });

	const hubResult = await operations.execute({ action: "hub" }, { cwd: "/repo" });
	const status = await operations.execute({ action: "status" }, { cwd: "/repo" });
	const members = await operations.execute({ action: "list" }, { cwd: "/repo" });

	expect(hubResult.text).toContain(hub.listenUrl);
	expect(status.text).toContain("controller");
	expect(members.text).toContain("controller");
});

test("membership operations stay bound when the selected Hub changes", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	const otherRoot = mkdtempSync(join(tmpdir(), "omp-a2a-operations-other-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const otherHub = await startHubServer({ port: 0, dataDir: otherRoot });
	const firstClient = new HubClient(hub.listenUrl);
	const otherClient = new HubClient(otherHub.listenUrl);
	let selectedClient = firstClient;
	const operations = new A2aOperations({ getClient: async () => selectedClient, pid: 123 });
	try {
		await firstClient.createProject({ name: "bound" });
		await otherClient.createProject({ name: "bound" });
		await operations.execute({ action: "join", project: "bound", agentId: "worker" }, { cwd: "/repo" });
		selectedClient = otherClient;

		const status = await operations.execute({ action: "status" }, { cwd: "/repo" });
		expect(status.text).toContain(firstClient.baseUrl);
		expect(status.text).not.toContain(otherClient.baseUrl);

		await operations.execute({ action: "leave" }, { cwd: "/repo" });
		expect(await firstClient.listMembers("bound")).toEqual([]);
		expect(await otherClient.listMembers("bound")).toEqual([]);
	} finally {
		await otherHub.stop();
		rmSync(otherRoot, { recursive: true, force: true });
	}
});

test("a failed membership switch keeps the previous membership", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.listenUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await client.createProject({ name: "stable" });
	await operations.execute({ action: "join", project: "stable", agentId: "worker" }, { cwd: "/repo" });

	await expect(
		operations.execute({ action: "join", project: "missing", agentId: "worker" }, { cwd: "/repo" }),
	).rejects.toThrow("unknown project");

	expect(operations.membership).toMatchObject({ project: "stable", agentId: "worker" });
	expect((await client.listMembers("stable")).map((member) => member.agentId)).toEqual(["worker"]);
});

test("manual inbox displays and acknowledges messages", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.listenUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "inbox" }, { cwd: "/repo" });
	await operations.execute({ action: "join", project: "inbox", agentId: "worker" }, { cwd: "/repo" });
	await client.send({ project: "inbox", from: "controller", to: "worker", text: "manual" });

	const result = await operations.execute({ action: "inbox" }, { cwd: "/repo" });

	expect(result.text).toContain("manual");
	expect(await client.inbox("inbox", "worker")).toEqual([]);
});

test("manual inbox identifies and acknowledges delivery receipts", async () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-operations-"));
	hub = await startHubServer({ port: 0, dataDir: root });
	const client = new HubClient(hub.listenUrl);
	const operations = new A2aOperations({ getClient: async () => client, pid: 123 });
	await operations.execute({ action: "project_create", project: "receipts" }, { cwd: "/repo" });
	await client.register({ project: "receipts", agentId: "worker", cwd: "/worker", pid: 456 });
	await operations.execute({ action: "join", project: "receipts", agentId: "controller" }, { cwd: "/repo" });
	await operations.execute({ action: "send", to: "worker", text: "work" }, { cwd: "/repo" });
	const message = (await client.inbox("receipts", "worker"))[0]!;
	await client.ack("receipts", "worker", [message.msgId]);

	const result = await operations.execute({ action: "inbox" }, { cwd: "/repo" });

	expect(result.text).toContain("Inbox cursor=");
	expect(result.text).toContain(`msg=${message.msgId} to=worker`);
	expect(await client.inbox("receipts", "controller")).toEqual([]);
});

test("HubClient times out an ordinary stalled request", async () => {
	// Native AbortSignal.timeout is the behavior under test; a fake clock cannot drive this fetch signal.
	const originalFetch = globalThis.fetch;
	let requestCount = 0;
	globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
		requestCount += 1;
		return new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("request signal was not provided");
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	}) as typeof fetch;

	try {
		const client = new HubClient("http://hub.invalid", { requestTimeoutMs: 1 });
		await expect(client.meta()).rejects.toMatchObject({ name: "TimeoutError" });
		expect(requestCount).toBe(1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("HubClient preserves caller cancellation ahead of its request timeout", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
		return new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("request signal was not provided");
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	}) as typeof fetch;

	try {
		const client = new HubClient("http://hub.invalid", { requestTimeoutMs: 1_000 });
		const controller = new AbortController();
		const reason = new Error("caller stopped request");
		const request = client.heartbeat("project", "agent", "lease", controller.signal);
		controller.abort(reason);
		await expect(request).rejects.toBe(reason);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("HubClient propagates cancellation during response body parsing", async () => {
	const originalFetch = globalThis.fetch;
	let bodyStartedResolve: (() => void) | undefined;
	const bodyStarted = new Promise<void>((resolve) => {
		bodyStartedResolve = resolve;
	});
	const mockedFetch = Object.assign(
		async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const response = new Response(null, { status: 200 });
			response.json = () => {
				bodyStartedResolve?.();
				return new Promise<never>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) throw new Error("request signal was not provided");
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			};
			return response;
		},
		{ preconnect: originalFetch.preconnect },
	);
	globalThis.fetch = mockedFetch;

	try {
		const client = new HubClient("http://hub.invalid", { requestTimeoutMs: 1_000 });
		const controller = new AbortController();
		const reason = new Error("caller stopped body");
		const request = client.heartbeat("project", "agent", "lease", controller.signal);
		await bodyStarted;
		controller.abort(reason);
		await expect(request).rejects.toBe(reason);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("HubClient rejects malformed JSON from successful responses", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (): Promise<Response> => new Response("not-json", { status: 200 }),
		{ preconnect: originalFetch.preconnect },
	);

	try {
		const client = new HubClient("http://hub.invalid");
		await expect(client.meta()).rejects.toThrow("Hub returned invalid JSON for http://hub.invalid/v1/meta");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("HubClient rejects invalid request timeouts", () => {
	for (const requestTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() => new HubClient("http://hub.invalid", { requestTimeoutMs })).toThrow(
			"requestTimeoutMs must be a positive finite number",
		);
	}
});
