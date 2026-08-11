import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalConfig } from "../src/config";

const roots: string[] = [];

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-config-"));
	roots.push(root);
	mkdirSync(join(root, ".omp"));
	return root;
}

function writeConfig(root: string, name: string, contents: string): string {
	const file = join(root, ".omp", name);
	writeFileSync(file, contents);
	return file;
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("local JSON config uses only connection-scoped fields", () => {
	const root = createRoot();
	writeConfig(
		root,
		"a2a.json",
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

test("local YAML preserves quoted URL punctuation", () => {
	const root = createRoot();
	writeConfig(
		root,
		"a2a.yml",
		'project: " billing "\nname: " api "\nhubUrl: " http://hub:4173/path#fragment "\n',
	);
	expect(loadLocalConfig(root)).toEqual({
		project: "billing",
		name: "api",
		hubUrl: "http://hub:4173/path#fragment",
		autoConnect: true,
	});
});

test("local config reports malformed YAML with its path", () => {
	const root = createRoot();
	const file = writeConfig(root, "a2a.yml", "project: [\nname: api\n");
	expect(() => loadLocalConfig(root)).toThrow(file);
});

test("local config rejects a non-object document root", () => {
	const root = createRoot();
	const file = writeConfig(root, "a2a.json", "[]");
	expect(() => loadLocalConfig(root)).toThrow(`invalid a2a config at ${file}`);
});

test("local config rejects unknown fields instead of accepting aliases", () => {
	for (const [field, value] of [
		["hub_url", "http://hub:4173"],
		["auto_connect", false],
		["url", "http://hub:4173"],
	] as const) {
		const root = createRoot();
		writeConfig(
			root,
			"a2a.json",
			JSON.stringify({
				project: "billing",
				name: "api",
				[field]: value,
			}),
		);
		expect(() => loadLocalConfig(root)).toThrow(`${field} must be removed`);
	}
});

test("misspelled autoConnect cannot silently enable connection", () => {
	const root = createRoot();
	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({
			project: "billing",
			name: "api",
			autoConect: false,
		}),
	);
	expect(() => loadLocalConfig(root)).toThrow("autoConect must be removed");
});

test("first existing local config remains authoritative when invalid", () => {
	const root = createRoot();
	const first = writeConfig(
		root,
		"a2a.yml",
		"project: billing\nname: api\nunexpected: true\n",
	);
	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ project: "fallback", name: "fallback" }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		`invalid a2a config at ${first}: unexpected must be removed`,
	);
});

test("removed persistent-member fields retain migration errors", () => {
	for (const field of ["agentId", "agent_id", "autoJoin", "auto_join"]) {
		const root = createRoot();
		writeConfig(
			root,
			"a2a.json",
			JSON.stringify({ project: "billing", name: "api", [field]: true }),
		);
		expect(() => loadLocalConfig(root)).toThrow(
			`field "${field}" was removed; rename agentId to name and autoJoin to autoConnect`,
		);
	}
});

test("local config names invalid required and optional fields", () => {
	const root = createRoot();
	writeConfig(root, "a2a.json", JSON.stringify({ name: "api" }));
	expect(() => loadLocalConfig(root)).toThrow("project must be a string");

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ project: " ", name: "api", hubUrl: "" }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		"project must be a non-blank string",
	);

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ project: "billing", name: 7 }),
	);
	expect(() => loadLocalConfig(root)).toThrow("name must be a string");

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ project: "billing project", name: "api" }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		"project must be a valid Project name",
	);

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ project: "billing", name: "api worker" }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		"name must be a valid Agent name",
	);

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ project: "billing", name: "api", hubUrl: " " }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		"hubUrl must be a non-blank string",
	);

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({
			project: "billing",
			name: "api",
			autoConnect: "false",
		}),
	);
	expect(() => loadLocalConfig(root)).toThrow("autoConnect must be boolean");
});
