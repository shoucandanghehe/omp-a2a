import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProject, deleteProject, listProjects } from "../src/registry";

const dataDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "omp-a2a-registry-smoke-"),
);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERT: ${message}`);
}

try {
	console.log("\n== persistent Project rooms ==");
	createProject({ name: "billing", dataDir });
	createProject({ name: "search", dataDir });
	assert(
		listProjects(dataDir)
			.map((project) => project.name)
			.join(",") === "billing,search",
		"Projects persist in sorted order",
	);
	assert(deleteProject("billing", dataDir), "existing Project deletes");
	assert(!deleteProject("billing", dataDir), "Project deletion is idempotent");
	assert(
		listProjects(dataDir)[0]?.name === "search",
		"unrelated Project remains",
	);
	console.log("\n== PASS ==");
	console.log("Project registry smoke OK");
} finally {
	fs.rmSync(dataDir, { recursive: true, force: true });
}
