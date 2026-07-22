import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HubClient } from "../src/hub/client";
import { startHubServer, type HubServerHandle } from "../src/hub/server";

const firstDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-a2a-hub-a-"));
const secondDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-a2a-hub-b-"));
const handles: HubServerHandle[] = [];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERT: ${message}`);
}

async function main() {
	console.log("\n== independent Hubs ==");
	const first = await startHubServer({ dataDir: firstDataDir, port: 0 });
	const second = await startHubServer({ dataDir: secondDataDir, port: 0 });
	handles.push(first, second);
	const client = new HubClient(first.meta.baseUrl);
	const otherClient = new HubClient(second.meta.baseUrl);
	await client.createProject({ name: "mesh-demo" });
	assert((await otherClient.listProjects()).length === 0, "Hub registries are isolated");

	console.log("\n== register and reject duplicate ==");
	const api = await client.register({ project: "mesh-demo", agentId: "api", cwd: "/code/api", pid: 999_999_998 });
	const web = await client.register({ project: "mesh-demo", agentId: "web", cwd: "/code/web", pid: 999_999_999 });
	let duplicateRejected = false;
	try {
		await client.register({ project: "mesh-demo", agentId: "api", cwd: "/replacement", pid: 1 });
	} catch {
		duplicateRejected = true;
	}
	assert(duplicateRejected, "online duplicate rejected");
	assert((await client.listMembers("mesh-demo")).length === 2, "heartbeat presence ignores diagnostic PID");

	console.log("\n== trust-on-claim send and durable delivery receipt ==");
	const message = await client.send({ project: "mesh-demo", from: "controller", to: "web", text: "hello" });
	assert((await client.inbox("mesh-demo", "web", 500, web.leaseId))[0]?.text === "hello", "unregistered sender claim accepted");
	await client.ack("mesh-demo", "web", [message.msgId], web.leaseId);
	assert((await client.inbox("mesh-demo", "web", 500, web.leaseId)).length === 0, "ack removes message");
	let anonymousReceiptRejected = false;
	try {
		await client.inbox("mesh-demo", "controller");
	} catch {
		anonymousReceiptRejected = true;
	}
	assert(anonymousReceiptRejected, "unregistered sender cannot consume Inbox");
	const controller = await client.register({
		project: "mesh-demo",
		agentId: "controller",
		cwd: "/code/controller",
		pid: 999_999_997,
	});
	const receipt = (await client.inbox("mesh-demo", "controller", 500, controller.leaseId))[0];
	assert(
		receipt?.kind === "delivery_receipt" && receipt.receiptFor === message.msgId,
		"ack creates delivery receipt",
	);
	await client.ack("mesh-demo", "controller", [receipt.msgId], controller.leaseId);
	assert((await client.inbox("mesh-demo", "web", 500, web.leaseId)).length === 0, "receipt ack does not loop");

	console.log("\n== gzip large payload ==");
	const largeText = "compressible diff line\n".repeat(2_000);
	const large = await client.send({ project: "mesh-demo", from: "controller", to: "web", text: largeText });
	assert((await client.inbox("mesh-demo", "web", 500, web.leaseId))[0]?.text === largeText, "large payload round trip");
	await client.ack("mesh-demo", "web", [large.msgId], web.leaseId);

	console.log("\n== persistent Inbox across restart ==");
	const durable = await client.send({ project: "mesh-demo", from: "controller", to: "web", text: "survive restart" });
	await first.stop();
	const restarted = await startHubServer({ dataDir: firstDataDir, port: 0 });
	handles.push(restarted);
	const restartedClient = new HubClient(restarted.meta.baseUrl);
	assert(
		(await restartedClient.inbox("mesh-demo", "web", 500, web.leaseId))[0]?.msgId === durable.msgId,
		"message survives restart",
	);
	await restartedClient.ack("mesh-demo", "web", [durable.msgId], web.leaseId);

	console.log("\n== fail closed unknown recipient ==");
	let unknownRejected = false;
	try {
		await restartedClient.send({ project: "mesh-demo", from: "controller", to: "missing", text: "nope" });
	} catch {
		unknownRejected = true;
	}
	assert(unknownRejected, "unknown recipient rejected");

	console.log("\n== safe project deletion ==");
	let activeDeleteRejected = false;
	try {
		await restartedClient.deleteProject("mesh-demo");
	} catch {
		activeDeleteRejected = true;
	}
	assert(activeDeleteRejected, "project with online members cannot be deleted");
	await restartedClient.unregister("mesh-demo", "api", api.leaseId);
	await restartedClient.unregister("mesh-demo", "web", web.leaseId);
	await restartedClient.unregister("mesh-demo", "controller", controller.leaseId);
	assert(await restartedClient.deleteProject("mesh-demo"), "inactive project deleted");
	assert((await restartedClient.listProjects()).length === 0, "deleted project absent");
	assert(!(await restartedClient.deleteProject("mesh-demo")), "project deletion is idempotent");

	console.log("\n== PASS ==");
	console.log("Custom Mesh Hub smoke OK");
}

main()
	.catch((error) => {
		console.error("\nHUB SMOKE FAILED:", error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await Promise.all(handles.splice(0).map((handle) => handle.stop()));
		if (process.exitCode) {
			console.error(`left smoke data at ${firstDataDir} and ${secondDataDir}`);
		} else {
			fs.rmSync(firstDataDir, { recursive: true, force: true });
			fs.rmSync(secondDataDir, { recursive: true, force: true });
		}
	});
