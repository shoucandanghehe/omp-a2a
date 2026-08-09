import { afterEach, expect, test } from "bun:test";
import {
	DEFAULT_HUB_REQUEST_TIMEOUT_MS,
	HubClient,
	probeHub,
	type HubRequestOptions,
} from "../src/hub/client";
import { A2A_PROTOCOL_VERSION } from "../src/hub/realtime-types";
import type { HubMeta } from "../src/hub/types";

const servers: Bun.Server<undefined>[] = [];

function serve(
	handler: (request: Request) => Response | Promise<Response>,
): string {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

function metadata(baseUrl: string): HubMeta {
	return {
		pid: 1,
		port: Number(new URL(baseUrl).port),
		baseUrl,
		dataDir: "/tmp/a2a",
		startedAt: 1,
		protocolVersion: A2A_PROTOCOL_VERSION,
	};
}

type Operation = {
	name: string;
	run: (client: HubClient, options: HubRequestOptions) => Promise<unknown>;
};

const operations: Operation[] = [
	{ name: "GET meta", run: (client, options) => client.meta(options) },
	{
		name: "POST createProject",
		run: (client, options) => client.createProject({ name: "room" }, options),
	},
	{
		name: "DELETE deleteProject",
		run: (client, options) => client.deleteProject("room", options),
	},
	{
		name: "GET listProjects",
		run: (client, options) => client.listProjects(options),
	},
	{
		name: "GET history",
		run: (client, options) => client.history({ project: "room" }, options),
	},
];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

test("HubClient exposes a validated 15 second request timeout default", () => {
	expect(DEFAULT_HUB_REQUEST_TIMEOUT_MS).toBe(15_000);
	expect(() => new HubClient("http://127.0.0.1", { requestTimeoutMs: 0 })).toThrow(
		"positive finite number",
	);
	expect(() =>
		new HubClient("http://127.0.0.1", { requestTimeoutMs: Number.NaN }),
	).toThrow("positive finite number");
});

test.each(operations)("$name is bounded by the configured deadline", async ({ run }) => {
	const baseUrl = serve(() => new Promise<Response>(() => {}));
	const client = new HubClient(baseUrl, { requestTimeoutMs: 20 });
	await expect(run(client, {})).rejects.toMatchObject({ name: "TimeoutError" });
});

test.each(operations)("$name preserves the caller cancellation reason", async ({ run }) => {
	const baseUrl = serve(() => new Promise<Response>(() => {}));
	const client = new HubClient(baseUrl, { requestTimeoutMs: 5_000 });
	const controller = new AbortController();
	const reason = new Error("caller stopped this request");
	const pending = run(client, { signal: controller.signal });
	controller.abort(reason);
	try {
		await pending;
		throw new Error("request unexpectedly completed");
	} catch (error) {
		expect(error).toBe(reason);
	}
});

test("the deadline remains active while a successful response body stalls", async () => {
	const encoder = new TextEncoder();
	const baseUrl = serve(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode('{"projects":['));
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	const client = new HubClient(baseUrl, { requestTimeoutMs: 20 });
	await expect(client.listProjects()).rejects.toMatchObject({
		name: "TimeoutError",
	});
});

test("caller cancellation is preserved while a response body stalls", async () => {
	const encoder = new TextEncoder();
	const baseUrl = serve(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode("{"));
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	const client = new HubClient(baseUrl, { requestTimeoutMs: 5_000 });
	const controller = new AbortController();
	const reason = new Error("stop parsing the body");
	const pending = client.meta({ signal: controller.signal });
	controller.abort(reason);
	try {
		await pending;
		throw new Error("request unexpectedly completed");
	} catch (error) {
		expect(error).toBe(reason);
	}
});

test("successful invalid JSON is rejected instead of being cast", async () => {
	const baseUrl = serve(() =>
		new Response("not-json", {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);
	await expect(new HubClient(baseUrl).listProjects()).rejects.toThrow(
		"invalid JSON",
	);
});

test.each([
	["createProject", (client: HubClient) => client.createProject({ name: "room" })],
	["deleteProject", (client: HubClient) => client.deleteProject("room")],
	["listProjects", (client: HubClient) => client.listProjects()],
	["history", (client: HubClient) => client.history({ project: "room" })],
] as const)("%s rejects a successful JSON array/null response", async (_name, run) => {
	const baseUrl = serve((request) =>
		Response.json(request.method === "DELETE" ? [] : null),
	);
	await expect(run(new HubClient(baseUrl))).rejects.toThrow("invalid");
});

test.each([
	["null", null],
	["array", []],
	["string pid", { pid: "1" }],
	["invalid port", { port: 65_536 }],
	["blank dataDir", { dataDir: "   " }],
	["string protocol", { protocolVersion: "2" }],
	["credentials", { baseUrl: "http://user:secret@hub.example" }],
	["query", { baseUrl: "http://hub.example?mode=bad" }],
	["fragment", { baseUrl: "http://hub.example#bad" }],
	["empty query", { baseUrl: "http://hub.example?" }],
	["empty fragment", { baseUrl: "http://hub.example#" }],
	["unnormalized host", { baseUrl: "http://HUB.EXAMPLE" }],
	["non-http URL", { baseUrl: "ws://hub.example" }],
	["trailing slash", { baseUrl: "http://hub.example/" }],
] as const)("meta rejects malformed metadata: %s", async (_name, override) => {
	let baseUrl = "";
	baseUrl = serve(() => {
		const valid = metadata(baseUrl);
		return Response.json(
			override && typeof override === "object" && !Array.isArray(override)
				? { ...valid, ...override }
				: override,
		);
	});
	await expect(new HubClient(baseUrl).meta()).rejects.toThrow("invalid metadata");
});

test("probe returns null for invalid metadata and reachability failures", async () => {
	const baseUrl = serve(() => Response.json({ protocolVersion: A2A_PROTOCOL_VERSION }));
	expect(await probeHub(baseUrl)).toBeNull();
	expect(await probeHub("http://127.0.0.1:1")).toBeNull();
});

test("probe preserves caller cancellation", async () => {
	const baseUrl = serve(() => new Promise<Response>(() => {}));
	const controller = new AbortController();
	const reason = new Error("cancel probe");
	const pending = probeHub(baseUrl, { signal: controller.signal });
	controller.abort(reason);
	try {
		await pending;
		throw new Error("probe unexpectedly completed");
	} catch (error) {
		expect(error).toBe(reason);
	}
});

test("meta accepts a complete normalized protocol-v2 response", async () => {
	let baseUrl = "";
	baseUrl = serve(() => Response.json(metadata(baseUrl)));
	expect(await new HubClient(baseUrl).meta()).toEqual(metadata(baseUrl));
});
