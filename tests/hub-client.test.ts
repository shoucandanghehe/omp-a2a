import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HubClient,
	HubDeadlineError,
	HubHttpError,
	HubTransportError,
	probeHub,
	resolveHubUrl,
} from "../src/hub/client";

const homes: string[] = [];
const originalEnvironmentUrl = process.env.OMP_A2A_HUB_URL;

function createHome(): string {
	const home = mkdtempSync(join(tmpdir(), "omp-a2a-global-config-"));
	homes.push(home);
	mkdirSync(join(home, ".omp", "a2a"), { recursive: true });
	delete process.env.OMP_A2A_HUB_URL;
	return home;
}

function writeConfig(home: string, name: string, contents: string): string {
	const file = join(home, ".omp", "a2a", name);
	writeFileSync(file, contents);
	return file;
}

afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
	if (originalEnvironmentUrl === undefined) {
		delete process.env.OMP_A2A_HUB_URL;
	} else {
		process.env.OMP_A2A_HUB_URL = originalEnvironmentUrl;
	}
});

test("global YAML preserves a quoted Hub URL", () => {
	const home = createHome();
	writeConfig(
		home,
		"config.yml",
		'hubUrl: " http://hub:4173/path#fragment "\n',
	);
	expect(resolveHubUrl({ home })).toBe("http://hub:4173/path#fragment");
});

test("global config rejects non-object roots and unknown aliases", () => {
	const home = createHome();
	const file = writeConfig(home, "config.json", "[]");
	expect(() => resolveHubUrl({ home })).toThrow(
		`invalid Hub config at ${file}`,
	);

	for (const field of ["hub_url", "url"]) {
		writeConfig(
			home,
			"config.json",
			JSON.stringify({ [field]: "http://hub:4173" }),
		);
		expect(() => resolveHubUrl({ home })).toThrow(
			`${field} must be removed`,
		);
	}
});

test("global JSON parsing rejects trailing syntax", () => {
	const home = createHome();
	const file = writeConfig(
		home,
		"config.json",
		'{"hubUrl":"http://hub:4173",}',
	);
	expect(() => resolveHubUrl({ home })).toThrow(file);
});

test("first existing global config remains authoritative when invalid", () => {
	const home = createHome();
	const first = writeConfig(
		home,
		"config.yml",
		"hubUrl: http://first:4173\nunexpected: true\n",
	);
	writeConfig(
		home,
		"config.json",
		JSON.stringify({ hubUrl: "http://fallback:4173" }),
	);
	expect(() => resolveHubUrl({ home })).toThrow(
		`invalid Hub config at ${first}: unexpected must be removed`,
	);
});

test("global config names missing, blank, and mistyped hubUrl", () => {
	const home = createHome();
	writeConfig(home, "config.yml", "{}\n");
	expect(() => resolveHubUrl({ home })).toThrow(
		"hubUrl must be a string",
	);

	writeConfig(home, "config.yml", "hubUrl: \" \"\n");
	expect(() => resolveHubUrl({ home })).toThrow(
		"hubUrl must be a non-blank string",
	);

	writeConfig(home, "config.yml", "hubUrl: 4173\n");
	expect(() => resolveHubUrl({ home })).toThrow(
		"hubUrl must be a string",
	);
});

type HttpTestServer = {
	baseUrl: string;
	server: Server;
};

const servers = new Set<Server>();

function errorCode(error: Error): string | undefined {
	if (!("code" in error) || typeof error.code !== "string") return undefined;
	return error.code;
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error && errorCode(error) !== "ERR_SERVER_NOT_RUNNING") {
				reject(error);
				return;
			}
			resolve();
		});
		server.closeAllConnections();
	});
}

async function serve(listener: RequestListener): Promise<HttpTestServer> {
	const server = createServer(listener);
	servers.add(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("HTTP test server did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		server,
	};
}

async function serveJson(
	value: unknown,
	status = 200,
): Promise<HttpTestServer> {
	return await serve((_request, response) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(value));
	});
}

afterEach(async () => {
	const ownedServers = [...servers];
	servers.clear();
	await Promise.all(ownedServers.map(closeServer));
});

test("HubClient deadline covers a server that stalls before headers", async () => {
	const { baseUrl } = await serve(() => {});
	const client = new HubClient(baseUrl, { requestTimeoutMs: 40 });

	await expect(client.meta()).rejects.toThrow(
		"Hub metadata timed out after 40ms",
	);
});

test("HubClient deadline covers a response body that stalls", async () => {
	const { baseUrl } = await serve((_request, response) => {
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
	const { baseUrl } = await serve((_request, response) => {
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
	const { baseUrl } = await serve((_request, response) => {
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
	const { baseUrl } = await serve((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end("not-json");
	});

	await expect(new HubClient(baseUrl).meta()).rejects.toThrow(
		"Hub returned invalid metadata response: response body is not valid JSON",
	);
});

test("a successful response with the wrong shape fails at the HubClient seam", async () => {
	const { baseUrl } = await serveJson({ projects: "not-an-array" });

	await expect(new HubClient(baseUrl).listProjects()).rejects.toThrow(
		"Hub returned invalid Project list response",
	);
});

test("a JSON Hub error preserves its status and request URL", async () => {
	const { baseUrl } = await serveJson(
		{ error: "project already exists" },
		409,
	);
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
	const { baseUrl } = await serve((_request, response) => {
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
	const { baseUrl } = await serveJson({
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
		payload: { encoding: "identity", data: "hello" },
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
					},
				},
			],
		},
	];
	let responseIndex = 0;
	const { baseUrl } = await serve((_request, response) => {
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

const validMetadata = {
	pid: 1,
	port: 4173,
	baseUrl: "http://127.0.0.1:4173",
	dataDir: "/tmp/hub",
	startedAt: 1,
	protocolVersion: 3,
};

const validProject = {
	name: "alpha",
	createdAt: 1,
};

const validAttachment = {
	name: "evidence.txt",
	payload: {
		encoding: "base64",
		data: "ZQ==",
	},
};

function historyMessage(
	sequence: number,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		messageId: `client-message-${sequence}`,
		messageRef: `alpha:${sequence}`,
		project: "alpha",
		sequence,
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "project" },
		payload: { encoding: "identity", data: "hello" },
		attachments: [],
		createdAt: sequence,
		...overrides,
	};
}

type ExactKeyScenario = {
	name: string;
	response: unknown;
	request: (client: HubClient) => Promise<unknown>;
};

const exactKeyScenarios: ExactKeyScenario[] = [
	{
		name: "metadata",
		response: { ...validMetadata, unexpected: true },
		request: (client) => client.meta(),
	},
	{
		name: "Project creation wrapper",
		response: { project: validProject, unexpected: true },
		request: (client) => client.createProject({ name: "alpha" }),
	},
	{
		name: "Project list wrapper",
		response: { projects: [validProject], unexpected: true },
		request: (client) => client.listProjects(),
	},
	{
		name: "Project deletion wrapper",
		response: { ok: true, deleted: true, unexpected: true },
		request: (client) => client.deleteProject("alpha"),
	},
	{
		name: "history wrapper",
		response: { messages: [], unexpected: true },
		request: (client) => client.history({ project: "alpha" }),
	},
	{
		name: "Project",
		response: { projects: [{ ...validProject, unexpected: true }] },
		request: (client) => client.listProjects(),
	},
	{
		name: "history message",
		response: {
			messages: [historyMessage(1, { unexpected: true })],
		},
		request: (client) => client.history({ project: "alpha" }),
	},
	{
		name: "history message sender",
		response: {
			messages: [
				historyMessage(1, {
					from: {
						name: "api",
						presenceId: "presence-api",
						unexpected: true,
					},
				}),
			],
		},
		request: (client) => client.history({ project: "alpha" }),
	},
	{
		name: "Project message target",
		response: {
			messages: [
				historyMessage(1, {
					target: { type: "project", name: "api" },
				}),
			],
		},
		request: (client) => client.history({ project: "alpha" }),
	},
	{
		name: "agent message target",
		response: {
			messages: [
				historyMessage(1, {
					target: { type: "agent", name: "api", unexpected: true },
				}),
			],
		},
		request: (client) => client.history({ project: "alpha" }),
	},
	{
		name: "message text payload",
		response: {
			messages: [
				historyMessage(1, {
					payload: {
						encoding: "identity",
						data: "hello",
						unexpected: true,
					},
				}),
			],
		},
		request: (client) => client.history({ project: "alpha" }),
	},
	{
		name: "message attachment",
		response: {
			messages: [
				historyMessage(1, {
					attachments: [{ ...validAttachment, unexpected: true }],
				}),
			],
		},
		request: (client) => client.history({ project: "alpha" }),
	},
	{
		name: "attachment payload",
		response: {
			messages: [
				historyMessage(1, {
					attachments: [
						{
							...validAttachment,
							payload: { ...validAttachment.payload, unexpected: true },
						},
					],
				}),
			],
		},
		request: (client) => client.history({ project: "alpha" }),
	},
];

for (const scenario of exactKeyScenarios) {
	test(`${scenario.name} rejects unknown successful-response fields`, async () => {
		const { baseUrl } = await serveJson(scenario.response);

		await expect(scenario.request(new HubClient(baseUrl))).rejects.toThrow();
	});
}

const invalidHistoryRelationships = [
	{
		name: "a row from another Project",
		messages: [
			historyMessage(1, {
				messageRef: "beta:1",
				project: "beta",
			}),
		],
	},
	{
		name: "non-monotonic Project sequences",
		messages: [historyMessage(2), historyMessage(1)],
	},
	{
		name: "a self reply",
		messages: [historyMessage(2, { replyTo: "alpha:2" })],
	},
	{
		name: "a reply to a future message",
		messages: [historyMessage(2, { replyTo: "alpha:3" })],
	},
];

for (const scenario of invalidHistoryRelationships) {
	test(`history rejects ${scenario.name}`, async () => {
		const { baseUrl } = await serveJson({ messages: scenario.messages });

		await expect(
			new HubClient(baseUrl).history({ project: "alpha" }),
		).rejects.toThrow();
	});
}

test("history snapshots its mutable query before dispatch", async () => {
	const requestArrived = Promise.withResolvers<string>();
	const releaseResponse = Promise.withResolvers<void>();
	const { baseUrl } = await serve(async (request, response) => {
		requestArrived.resolve(request.url ?? "");
		await releaseResponse.promise;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ messages: [historyMessage(1)] }));
	});
	const query = {
		project: "alpha",
		before: "alpha:3",
		from: "api",
		limit: 2,
	};

	const history = new HubClient(baseUrl).history(query);
	const requestedUrl = await requestArrived.promise;
	Object.assign(query, {
		project: "beta",
		before: "beta:9",
		from: "other",
		limit: 99,
	});
	releaseResponse.resolve();

	await expect(history).resolves.toMatchObject({
		messages: [{ project: "alpha", messageRef: "alpha:1" }],
	});
	expect(requestedUrl).toBe(
		"/v1/history?project=alpha&before=alpha%3A3&from=api&limit=2",
	);
});

test("probeHub catches only transport failures and preserves its metadata deadline", async () => {
	const {
		baseUrl: unreachableUrl,
		server: unreachableServer,
	} = await serve((_request, response) => {
		response.end("unexpected");
	});
	await closeServer(unreachableServer);
	const transportError = await new HubClient(unreachableUrl)
		.meta()
		.catch((error: unknown) => error);
	if (!(transportError instanceof HubTransportError))
		throw new Error("expected an unreachable Hub to be a transport failure");
	expect(transportError.operation).toBe("Hub metadata");
	expect(transportError.url).toBe(`${unreachableUrl}/v1/meta`);
	await expect(probeHub(unreachableUrl)).resolves.toBeNull();

	let requestCount = 0;
	const { baseUrl: stalledUrl } = await serve(() => {
		requestCount += 1;
	});

	const deadlineError = await probeHub(stalledUrl).catch(
		(error: unknown) => error,
	);
	if (!(deadlineError instanceof HubDeadlineError))
		throw new Error("expected the probe metadata deadline to remain distinct");
	expect(deadlineError.operation).toBe("Hub metadata");
	expect(deadlineError.timeoutMs).toBe(1_500);
	expect(deadlineError.message).toBe("Hub metadata timed out after 1500ms");
	expect(requestCount).toBe(1);
});
