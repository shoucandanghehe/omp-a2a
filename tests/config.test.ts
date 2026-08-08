import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalConfig } from "../src/config";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("local config uses connection-scoped name and autoConnect", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-config-"));
	roots.push(root);
	mkdirSync(join(root, ".omp"));
	writeFileSync(
		join(root, ".omp", "a2a.json"),
		JSON.stringify({
			project: "billing",
			name: "api",
			hubUrl: "http://hub:4173",
			autoConnect: false,
		}),
	);
	expect(loadLocalConfig(root)).toEqual({
		project: "billing",
		name: "api",
		hubUrl: "http://hub:4173",
		autoConnect: false,
	});
});

test("legacy persistent-member config fails with an explicit migration error", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-config-"));
	roots.push(root);
	mkdirSync(join(root, ".omp"));
	writeFileSync(
		join(root, ".omp", "a2a.json"),
		JSON.stringify({ project: "billing", agentId: "api", autoJoin: true }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		"rename agentId to name and autoJoin to autoConnect",
	);
});
