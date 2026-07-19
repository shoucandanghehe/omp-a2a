import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadLocalConfig } from "../src/config";
import {
	createProject,
	formatMembersTable,
	heartbeat,
	joinProject,
	leaveProject,
	listMembers,
	listProjects,
	RegistryConflictError,
} from "../src/registry";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-a2a-registry-smoke-"));

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERT: ${message}`);
}

try {
	console.log("\n== create isolated projects ==");
	createProject({ name: "billing-rewrite", displayName: "Billing", dataDir });
	createProject({ name: "other-mesh", dataDir });
	assert(listProjects(dataDir).length === 2, "two projects");

	console.log("\n== heartbeat-owned presence ==");
	joinProject({ project: "billing-rewrite", agentId: "api", cwd: "/code/api", pid: 2_147_483_647, dataDir });
	joinProject({ project: "billing-rewrite", agentId: "web", cwd: "/code/web", pid: 2_147_483_646, dataDir });
	heartbeat("billing-rewrite", "api", dataDir);
	const online = listMembers({ project: "billing-rewrite", dataDir });
	console.log(formatMembersTable(online));
	assert(online.length === 2, "diagnostic PIDs do not control presence");
	assert(listMembers({ project: "other-mesh", dataDir }).length === 0, "project isolation");

	console.log("\n== reject online duplicate ==");
	let duplicateRejected = false;
	try {
		joinProject({ project: "billing-rewrite", agentId: "api", cwd: "/replacement", pid: 1, dataDir });
	} catch (error) {
		duplicateRejected = error instanceof RegistryConflictError;
	}
	assert(duplicateRejected, "online duplicate rejected");

	console.log("\n== idempotent leave ==");
	leaveProject("billing-rewrite", "api", dataDir);
	leaveProject("billing-rewrite", "api", dataDir);
	assert(
		listMembers({ project: "billing-rewrite", dataDir }).every((member) => member.agentId !== "api"),
		"left member is not online",
	);

	console.log("\n== local config ==");
	const repo = path.join(dataDir, "repo");
	fs.mkdirSync(path.join(repo, ".omp"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, ".omp", "a2a.yml"),
		"hubUrl: http://127.0.0.1:4199\nproject: billing-rewrite\nagentId: api\ncaps: [api, db]\n",
	);
	const config = loadLocalConfig(repo);
	assert(config?.hubUrl === "http://127.0.0.1:4199", "Hub URL parsed");
	assert(config?.caps?.join(",") === "api,db", "capabilities parsed");

	console.log("\n== PASS ==");
	console.log("Registry smoke OK");
} catch (error) {
	console.error("\nSMOKE FAILED:", error);
	process.exitCode = 1;
} finally {
	if (process.exitCode) console.error(`left smoke data at ${dataDir}`);
	else fs.rmSync(dataDir, { recursive: true, force: true });
}
