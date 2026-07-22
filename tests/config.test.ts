import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalConfig } from "../src/config";
import { resolveHubUrl } from "../src/hub/client";

const roots: string[] = [];
const originalHubUrl = process.env.OMP_A2A_HUB_URL;

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-config-"));
	roots.push(root);
	return root;
}

function writeGlobalConfig(home: string, name: string, contents: string): string {
	const root = join(home, ".omp", "a2a");
	mkdirSync(root, { recursive: true });
	const file = join(root, name);
	writeFileSync(file, contents);
	return file;
}

afterEach(() => {
	if (originalHubUrl === undefined) delete process.env.OMP_A2A_HUB_URL;
	else process.env.OMP_A2A_HUB_URL = originalHubUrl;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("local YAML preserves quoted hashes in scalar and list values while removing comments", () => {
	const cwd = tempRoot();
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	writeFileSync(
		join(cwd, ".omp", "a2a.yml"),
		[
			"project: shared # outside comment",
			"agentId: worker # outside comment",
			' hubUrl: "http://hub.example/path/#fragment" # outside comment'.trimStart(),
			'caps: ["read#one", "write\\\"#two"] # outside comment',
		].join("\n"),
	);

	expect(loadLocalConfig(cwd)).toMatchObject({
		project: "shared",
		agentId: "worker",
		hubUrl: "http://hub.example/path/#fragment",
		caps: ["read#one", 'write"#two'],
	});
});

test("plain YAML scalars preserve embedded quotes and trailing brackets", () => {
	const cwd = tempRoot();
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	writeFileSync(
		join(cwd, ".omp", "a2a.yml"),
		[
			"project: shared",
			"agentId: worker",
			"displayName: Bob's Worker",
			"hubUrl: http://[::1]",
			"caps: [reader's, writer]",
		].join("\n"),
	);

	expect(loadLocalConfig(cwd)).toMatchObject({
		displayName: "Bob's Worker",
		hubUrl: "http://[::1]",
		caps: ["reader's", "writer"],
	});
});

test("global YAML preserves a quoted hash and removes an outside comment", () => {
	delete process.env.OMP_A2A_HUB_URL;
	const home = tempRoot();
	writeGlobalConfig(home, "config.yml", 'hubUrl: "http://hub.example/path/#fragment/" # ignored\n');

	expect(resolveHubUrl({ home })).toBe("http://hub.example/path/#fragment");
});

test("global YAML accepts an unquoted IPv6 URL ending in a bracket", () => {
	delete process.env.OMP_A2A_HUB_URL;
	const home = tempRoot();
	writeGlobalConfig(home, "config.yml", "hubUrl: http://[::1]\n");

	expect(resolveHubUrl({ home })).toBe("http://[::1]");
});

test("malformed selected global JSON throws with its path", () => {
	delete process.env.OMP_A2A_HUB_URL;
	const home = tempRoot();
	const file = writeGlobalConfig(home, "config.json", "{");

	expect(() => resolveHubUrl({ home })).toThrow(file);
});

test.each([
	["non-object", "[]", "config must be an object"],
	["missing URL", '{"other":"value"}', "missing required Hub URL"],
	["non-string URL", '{"hubUrl":42}', "Hub URL must be a string"],
	["blank URL", '{"hubUrl":"   "}', "Hub URL must not be blank"],
])("selected global JSON rejects %s", (_label, contents, message) => {
	delete process.env.OMP_A2A_HUB_URL;
	const home = tempRoot();
	const file = writeGlobalConfig(home, "config.json", contents);

	expect(() => resolveHubUrl({ home })).toThrow(file);
	expect(() => resolveHubUrl({ home })).toThrow(message);
});

test("invalid first global YAML candidate does not fall through to a lower candidate", () => {
	delete process.env.OMP_A2A_HUB_URL;
	const home = tempRoot();
	const selected = writeGlobalConfig(home, "config.yml", 'hubUrl: "unterminated\n');
	writeGlobalConfig(home, "config.json", '{"hubUrl":"http://lower.example"}');

	expect(() => resolveHubUrl({ home })).toThrow(selected);
});

test("invalid first local YAML candidate does not fall through to local JSON", () => {
	const cwd = tempRoot();
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	const selected = join(cwd, ".omp", "a2a.yml");
	writeFileSync(selected, "not valid yaml\n");
	writeFileSync(join(cwd, ".omp", "a2a.json"), '{"project":"shared","agentId":"worker"}');

	expect(() => loadLocalConfig(cwd)).toThrow(selected);
});

test("selected local non-object JSON throws with its path", () => {
	const cwd = tempRoot();
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	const selected = join(cwd, ".omp", "a2a.json");
	writeFileSync(selected, "[]");

	expect(() => loadLocalConfig(cwd)).toThrow(selected);
	expect(() => loadLocalConfig(cwd)).toThrow("config must be an object");
});

test("explicit option bypasses corrupt global configuration", () => {
	delete process.env.OMP_A2A_HUB_URL;
	const home = tempRoot();
	writeGlobalConfig(home, "config.json", "{");

	expect(resolveHubUrl({ home, hubUrl: " http://explicit.example/// " })).toBe("http://explicit.example");
});

test("environment URL bypasses corrupt global configuration", () => {
	const home = tempRoot();
	writeGlobalConfig(home, "config.json", "{");
	process.env.OMP_A2A_HUB_URL = " http://environment.example// ";

	expect(resolveHubUrl({ home })).toBe("http://environment.example");
});

test.each(["hubUrl", "hub_url", "url"])("global JSON accepts the %s alias", (key) => {
	delete process.env.OMP_A2A_HUB_URL;
	const home = tempRoot();
	writeGlobalConfig(home, "config.json", JSON.stringify({ [key]: "http://hub.example///" }));

	expect(resolveHubUrl({ home })).toBe("http://hub.example");
});
