import { HubClient } from "../src/hub/client";
import { A2aConnection } from "../src/hub/connection";
import {
	decodeBinaryPayload,
	decodeTextPayload,
	encodeBinaryPayload,
} from "../src/hub/payload";
import {
	A2A_PROTOCOL_VERSION,
	type RealtimeMessage,
} from "../src/hub/realtime-types";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERT: ${message}`);
}

const client = await HubClient.connect({
	hubUrl: process.env.OMP_A2A_SMOKE_HUB_URL,
});
const metaResponse = await fetch(`${client.baseUrl}/v1/meta`);
assert(
	metaResponse.ok,
	`Docker Hub metadata returned HTTP ${metaResponse.status}`,
);
const meta = await metaResponse.json();
assert(
	JSON.stringify(meta) ===
		JSON.stringify({ protocolVersion: A2A_PROTOCOL_VERSION }),
	"Docker Hub metadata contains only the protocol version",
);
const healthResponse = await fetch(`${client.baseUrl}/healthz`);
assert(
	healthResponse.ok,
	`Docker Hub health returned HTTP ${healthResponse.status}`,
);
const health = await healthResponse.json();
assert(
	JSON.stringify(health) ===
		JSON.stringify({ ok: true, service: "omp-a2a-hub" }),
	"Docker Hub health response stays minimal",
);
const project = `docker-${Date.now()}`;
let api: A2aConnection | null = null;
let web: A2aConnection | null = null;
let resolveMessage!: (message: RealtimeMessage) => void;
const received = new Promise<RealtimeMessage>((resolve) => {
	resolveMessage = resolve;
});
const attachmentBytes = Buffer.from("# Docker handoff\nprotocol=3\n", "utf8");

try {
	console.log(`\n== Docker Hub ${client.baseUrl} ==`);
	await client.createProject({ name: project });
	api = await A2aConnection.connect({
		baseUrl: client.baseUrl,
		project,
		name: "api",
	});
	web = await A2aConnection.connect({
		baseUrl: client.baseUrl,
		project,
		name: "web",
		events: { onMessage: resolveMessage },
	});
	const accepted = await api.send({
		target: { type: "agent", name: "web" },
		text: "docker realtime",
		attachments: [
			{
				name: "docker-handoff.md",
				payload: encodeBinaryPayload(attachmentBytes),
			},
		],
		messageId: `${project}-message`,
	});
	assert(
		accepted.message.messageRef === `${project}:1`,
		"Docker Hub assigned Project sequence",
	);
	const receivedMessage = await received;
	assert(
		decodeTextPayload(receivedMessage.payload) === "docker realtime",
		"Docker WebSocket delivered message",
	);
	const receivedAttachment = receivedMessage.attachments[0];
	assert(
		receivedAttachment?.name === "docker-handoff.md" &&
			decodeBinaryPayload(receivedAttachment.payload).equals(attachmentBytes),
		"Docker WebSocket delivered attachment bytes",
	);
	await api.close();
	api = null;
	await web.close();
	web = null;
	const history = await client.history({ project, limit: 10 });
	assert(history.messages.length === 1, "Docker Hub persisted message history");
	const persistedAttachment = history.messages[0]?.attachments[0];
	assert(
		persistedAttachment?.name === "docker-handoff.md" &&
			decodeBinaryPayload(persistedAttachment.payload).equals(attachmentBytes),
		"Docker Hub persisted attachment history",
	);
	assert(await client.deleteProject(project), "Docker smoke Project deleted");
	console.log("Docker Hub smoke OK");
} finally {
	await api?.close();
	await web?.close();
	await client.deleteProject(project).catch(() => false);
}
