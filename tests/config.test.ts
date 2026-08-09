import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalConfig } from "../src/config";
import { resolveHubUrl } from "../src/hub/client";
import { parseSimpleYaml } from "../src/simple-yaml";

const roots: string[] = [];
const originalHubUrl = process.env.OMP_A2A_HUB_URL;

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-config-"));
	roots.push(root);
	return root;
}

function writeLocal(root: string, name: string, contents: string): string {
	const directory = join(root, ".omp");
	mkdirSync(directory, { recursive: true });
	const file = join(directory, name);
	writeFileSync(file, contents);
	return file;
}

function writeGlobal(home: string, name: string, contents: string): string {
	const directory = join(home, ".omp", "a2a");
	mkdirSync(directory, { recursive: true });
	const file = join(directory, name);
	writeFileSync(file, contents);
	return file;
}

afterEach(() => {
	if (originalHubUrl === undefined) delete process.env.OMP_A2A_HUB_URL;
	else process.env.OMP_A2A_HUB_URL = originalHubUrl;
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("local config uses connection-scoped name and autoConnect", () => {
	const root = tempRoot();
	writeLocal(
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

test("legacy persistent-member config fails with an explicit migration error", () => {
	const root = tempRoot();
	writeLocal(
		root,
		"a2a.json",
		JSON.stringify({ project: "billing", agentId: "api", autoJoin: true }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		"rename agentId to name and autoJoin to autoConnect",
	);
});

test("minimal YAML preserves quoted hashes, commas, and escapes", () => {
	expect(
		parseSimpleYaml(
			[
				"project: shared # comment",
				"name: Bob's-worker",
				'url: "http://hub.example/a,#b" # comment',
				`values: ["read,#one", 'write,''two', "line\\nnext"]`,
			].join("\n"),
		),
	).toEqual({
		project: "shared",
		name: "Bob's-worker",
		url: "http://hub.example/a,#b",
		values: ["read,#one", "write,'two", "line\nnext"],
	});
});

test("minimal YAML preserves plain URL punctuation and bracket endings", () => {
	expect(parseSimpleYaml("hubUrl: http://[::1]\nname: worker's-[one]"))
		.toEqual({ hubUrl: "http://[::1]", name: "worker's-[one]" });
});

test.each([
	["unterminated quote", 'hubUrl: "unterminated'],
	["unterminated list", "values: [one, two"],
	["orphan list item", "- orphan"],
	["nested map", "root:\n  child: value"],
	["block scalar", "value: |"],
	["unsupported mapping", "not yaml"],
])("minimal YAML rejects %s", (_label, yaml) => {
	expect(() => parseSimpleYaml(yaml)).toThrow();
});

test.each(["null", "[]"])(
	"selected local JSON rejects the non-object value %s with path context",
	(contents) => {
		const root = tempRoot();
		const selected = writeLocal(root, "a2a.json", contents);
		expect(() => loadLocalConfig(root)).toThrow(selected);
		expect(() => loadLocalConfig(root)).toThrow("config must be an object");
	},
);

test("the first existing local config remains authoritative after failure", () => {
	const root = tempRoot();
	const selected = writeLocal(root, "a2a.yml", 'hubUrl: "unterminated');
	writeLocal(root, "a2a.json", '{"project":"fallback","name":"worker"}');
	expect(() => loadLocalConfig(root)).toThrow(selected);
});

test.each([
	[{ project: "room", name: "worker", hubUrl: "   " }, '"hubUrl" must not be blank'],
	[{ project: "room", name: "worker", hub_url: 42 }, '"hub_url" must be a string'],
	[
		{ project: "room", name: "worker", hubUrl: 42, hub_url: "http://fallback" },
		'"hubUrl" must be a string',
	],
	[
		{ project: "room", name: "worker", autoConnect: "false", auto_connect: false },
		'"autoConnect" must be a boolean',
	],
])("selected local config rejects malformed fields without alias fallback", (config, message) => {
	const root = tempRoot();
	const selected = writeLocal(root, "a2a.json", JSON.stringify(config));
	expect(() => loadLocalConfig(root)).toThrow(selected);
	expect(() => loadLocalConfig(root)).toThrow(message);
});

test.each(["null", "[]"])(
	"selected global JSON rejects the non-object value %s with path context",
	(contents) => {
		delete process.env.OMP_A2A_HUB_URL;
		const home = tempRoot();
		const selected = writeGlobal(home, "config.json", contents);
		expect(() => resolveHubUrl({ home })).toThrow(selected);
		expect(() => resolveHubUrl({ home })).toThrow("config must be an object");
	},
);

test("the first existing global config remains authoritative after failure", () => {
	delete process.env.OMP_A2A_HUB_URL;
	const home = tempRoot();
	const selected = writeGlobal(home, "config.yml", "other: value");
	writeGlobal(home, "config.json", '{"hubUrl":"http://fallback.example"}');
	expect(() => resolveHubUrl({ home })).toThrow(selected);
});

test("global config preserves quoted URL punctuation", () => {
	delete process.env.OMP_A2A_HUB_URL;
	const home = tempRoot();
	writeGlobal(
		home,
		"config.yml",
		'hubUrl: "http://hub.example/path/#fragment/" # comment',
	);
	expect(resolveHubUrl({ home })).toBe("http://hub.example/path/#fragment");
});

test("malformed canonical global URL does not fall through to an alias", () => {
	delete process.env.OMP_A2A_HUB_URL;
	const home = tempRoot();
	const selected = writeGlobal(
		home,
		"config.json",
		'{"hubUrl":null,"hub_url":"http://fallback.example"}',
	);
	expect(() => resolveHubUrl({ home })).toThrow(selected);
	expect(() => resolveHubUrl({ home })).toThrow("Hub URL must be a string");
});
