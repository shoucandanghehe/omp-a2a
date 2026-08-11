import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import {
	HubClient,
	HubHttpError,
	probeHub,
} from "../src/hub/client";

const servers: Server[] = [];

async function serve(listener: RequestListener): Promise<string> {
	const server = createServer(listener);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("HTTP test server did not bind a TCP port");
	return `http://127.0.0.1:${address.port}`;
}

async function serveJson(value: unknown, status = 200): Promise<string> {
	return await serve((_request, response) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(value));
	});
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.closeAllConnections();
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
});

test("HubClient deadline covers a server that stalls before headers", async () => {
	const baseUrl = await serve(() => {});
	const client = new HubClient(baseUrl, { requestTimeoutMs: 40 });

	await expect(client.meta()).rejects.toThrow(
		"Hub metadata timed out after 40ms",
	);
});

test("HubClient deadline covers a response body that stalls", async () => {
	const baseUrl = await serve((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.write('{"pid":');
	});
	const client = new HubClient(baseUrl, { requestTimeoutMs: 40 });

	await expect(client.meta()).rejects.toThrow(
		"Hub metadata timed out after 40ms",
	);
});

test("a caller-aborted request never reaches the Hub", async () => {
	let requestCount = 0;
	const baseUrl = await serve((_request, response) => {
		requestCount += 1;
		response.end("unexpected");
	});
	const controller = new AbortController();
	const reason = new Error("turn cancelled before history");
	controller.abort(reason);

	await expect(
		new HubClient(baseUrl).history(
			{ project: "client-test" },
			{ signal: controller.signal },
		),
	).rejects.toBe(reason);
	expect(requestCount).toBe(0);
});

test("caller cancellation interrupts body reading with the caller reason", async () => {
	const bodyStarted = Promise.withResolvers<void>();
	const baseUrl = await serve((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.write('{"messages":[');
		bodyStarted.resolve();
	});
	const controller = new AbortController();
	const reason = new Error("model turn cancelled");
	const history = new HubClient(baseUrl).history(
		{ project: "client-test" },
		{ signal: controller.signal },
	);
	await bodyStarted.promise;
	controller.abort(reason);

	await expect(history).rejects.toBe(reason);
});

test("a successful response with invalid JSON fails at the HubClient seam", async () => {
	const baseUrl = await serve((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end("not-json");
	});

	await expect(new HubClient(baseUrl).meta()).rejects.toThrow(
		"Hub returned invalid metadata response: response body is not valid JSON",
	);
});

test("a successful response with the wrong shape fails at the HubClient seam", async () => {
	const baseUrl = await serveJson({ projects: "not-an-array" });

	await expect(new HubClient(baseUrl).listProjects()).rejects.toThrow(
		"Hub returned invalid Project list response",
	);
});

test("a JSON Hub error preserves its status and request URL", async () => {
	const baseUrl = await serveJson({ error: "project already exists" }, 409);
	const error = await new HubClient(baseUrl)
		.createProject({ name: "client-test" })
		.catch((caught: unknown) => caught);
	if (!(error instanceof HubHttpError))
		throw new Error("expected HubHttpError for a non-2xx response");

	expect(error.status).toBe(409);
	expect(error.url).toBe(`${baseUrl}/v1/projects`);
	expect(error.hubError).toBe("project already exists");
	expect(error.message).toContain("HTTP 409");
	expect(error.message).toContain(baseUrl);
	expect(error.message).toContain("project already exists");
});

test("an HTML Hub error still preserves its status and request URL", async () => {
	const baseUrl = await serve((_request, response) => {
		response.writeHead(503, { "content-type": "text/html" });
		response.end("<h1>unavailable</h1>");
	});
	const error = await new HubClient(baseUrl)
		.meta()
		.catch((caught: unknown) => caught);
	if (!(error instanceof HubHttpError))
		throw new Error("expected HubHttpError for a non-2xx response");

	expect(error.status).toBe(503);
	expect(error.url).toBe(`${baseUrl}/v1/meta`);
	expect(error.hubError).toBeUndefined();
	expect(error.message).toContain(`HTTP 503 ${baseUrl}/v1/meta`);
});

test("probeHub does not disguise malformed metadata as an unavailable Hub", async () => {
	const baseUrl = await serveJson({
		pid: 1,
		port: 4173,
		baseUrl: "http://127.0.0.1:4173",
		dataDir: "/tmp/hub",
		startedAt: 1,
	});

	await expect(probeHub(baseUrl)).rejects.toThrow(
		"Hub returned invalid metadata response",
	);
});

test("history rejects invalid sequences, references, and attachments", async () => {
	const validMessage = {
		messageId: "client-message",
		messageRef: "client-test:1",
		project: "client-test",
		sequence: 1,
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "project" },
		payload: { encoding: "identity", data: "hello", uncompressedBytes: 5 },
		attachments: [],
		createdAt: 1,
	};
	const invalidMessages = [
		{ ...validMessage, sequence: 0 },
		{ ...validMessage, messageRef: "client-test:2" },
		{
			messageId: validMessage.messageId,
			messageRef: validMessage.messageRef,
			project: validMessage.project,
			sequence: validMessage.sequence,
			from: validMessage.from,
			target: validMessage.target,
			payload: validMessage.payload,
			createdAt: validMessage.createdAt,
		},
		{
			...validMessage,
			attachments: [
				{
					name: "evidence.txt",
					payload: {
						encoding: "base64",
						data: "not canonical base64",
						uncompressedBytes: 1,
					},
				},
			],
		},
	];
	let responseIndex = 0;
	const baseUrl = await serve((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({ messages: [invalidMessages[responseIndex++]] }),
		);
	});
	const client = new HubClient(baseUrl);

	await expect(client.history({ project: "client-test" })).rejects.toThrow(
		"message.sequence must be a safe integer >= 1",
	);
	await expect(client.history({ project: "client-test" })).rejects.toThrow(
		"message.messageRef is not canonical",
	);
	await expect(client.history({ project: "client-test" })).rejects.toThrow(
		"attachments must be an array",
	);
	await expect(client.history({ project: "client-test" })).rejects.toThrow(
		"attachment data is not canonical base64",
	);
});
