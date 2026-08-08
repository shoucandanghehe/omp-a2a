import { HubClient } from "../src/hub/client";
import { A2aConnection } from "../src/hub/connection";
import { decodeTextPayload } from "../src/hub/payload";
import type { RealtimeMessage } from "../src/hub/realtime-types";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERT: ${message}`);
}

const client = await HubClient.connect();
const project = `docker-${Date.now()}`;
let api: A2aConnection | null = null;
let web: A2aConnection | null = null;
let resolveMessage!: (message: RealtimeMessage) => void;
const received = new Promise<RealtimeMessage>((resolve) => {
	resolveMessage = resolve;
});

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
		messageId: `${project}-message`,
	});
	assert(
		accepted.message.messageRef === `${project}:1`,
		"Docker Hub assigned Project sequence",
	);
	assert(
		decodeTextPayload((await received).payload) === "docker realtime",
		"Docker WebSocket delivered message",
	);
	await api.close();
	api = null;
	await web.close();
	web = null;
	const history = await client.history({ project, limit: 10 });
	assert(history.messages.length === 1, "Docker Hub persisted message history");
	assert(await client.deleteProject(project), "Docker smoke Project deleted");
	console.log("Docker Hub smoke OK");
} finally {
	await api?.close();
	await web?.close();
	await client.deleteProject(project).catch(() => false);
}
