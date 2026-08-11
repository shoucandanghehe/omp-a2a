import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HubStore } from "../src/hub/store";
import { hubStoreDatabasePath } from "../src/paths";

const dataDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "omp-a2a-store-smoke-"),
);
const databasePath = hubStoreDatabasePath(dataDir);
let store: HubStore | null = new HubStore(databasePath);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERT: ${message}`);
}

try {
	console.log("\n== persistent SQLite Projects ==");
	store.createProject({ name: "billing" });
	store.createProject({ name: "search" });
	assert(
		store
			.listProjects()
			.map((project) => project.name)
			.join(",") === "billing,search",
		"Projects persist in sorted order",
	);
	store.close();
	store = null;
	store = new HubStore(databasePath);
	assert(store.getProject("billing")?.name === "billing", "Project reopens");
	assert(store.deleteProject("billing"), "existing Project deletes");
	assert(!store.deleteProject("billing"), "Project deletion is idempotent");
	assert(
		store.listProjects()[0]?.name === "search",
		"unrelated Project remains",
	);
	console.log("\n== PASS ==");
	console.log("SQLite Project store smoke OK");
} finally {
	store?.close();
	fs.rmSync(dataDir, { recursive: true, force: true });
}
