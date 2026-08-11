import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHubUrl } from "../src/hub/client";

const homes: string[] = [];
const originalEnvironmentUrl = process.env.OMP_A2A_HUB_URL;

function createHome(): string {
	const home = mkdtempSync(join(tmpdir(), "omp-a2a-global-config-"));
	homes.push(home);
	mkdirSync(join(home, ".omp", "a2a"), { recursive: true });
	delete process.env.OMP_A2A_HUB_URL;
	return home;
}

function writeConfig(home: string, name: string, contents: string): string {
	const file = join(home, ".omp", "a2a", name);
	writeFileSync(file, contents);
	return file;
}

afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
	if (originalEnvironmentUrl === undefined) {
		delete process.env.OMP_A2A_HUB_URL;
	} else {
		process.env.OMP_A2A_HUB_URL = originalEnvironmentUrl;
	}
});

test("global YAML preserves a quoted Hub URL", () => {
	const home = createHome();
	writeConfig(
		home,
		"config.yml",
		'hubUrl: "http://hub:4173/path#fragment"\n',
	);
	expect(resolveHubUrl({ home })).toBe("http://hub:4173/path#fragment");
});

test("global config rejects non-object roots and unknown aliases", () => {
	const home = createHome();
	const file = writeConfig(home, "config.json", "[]");
	expect(() => resolveHubUrl({ home })).toThrow(
		`invalid Hub config at ${file}: Hub config root must be an object`,
	);

	for (const field of ["hub_url", "url"]) {
		writeConfig(
			home,
			"config.json",
			JSON.stringify({ [field]: "http://hub:4173" }),
		);
		expect(() => resolveHubUrl({ home })).toThrow(
			`unknown field "${field}"`,
		);
	}
});

test("global JSON parsing rejects trailing syntax", () => {
	const home = createHome();
	const file = writeConfig(
		home,
		"config.json",
		'{"hubUrl":"http://hub:4173",}',
	);
	expect(() => resolveHubUrl({ home })).toThrow(file);
});

test("first existing global config remains authoritative when invalid", () => {
	const home = createHome();
	const first = writeConfig(
		home,
		"config.yml",
		"hubUrl: http://first:4173\nunexpected: true\n",
	);
	writeConfig(
		home,
		"config.json",
		JSON.stringify({ hubUrl: "http://fallback:4173" }),
	);
	expect(() => resolveHubUrl({ home })).toThrow(
		`invalid Hub config at ${first}: Hub config has unknown field "unexpected"`,
	);
});

test("global config names missing, blank, and mistyped hubUrl", () => {
	const home = createHome();
	writeConfig(home, "config.yml", "{}\n");
	expect(() => resolveHubUrl({ home })).toThrow(
		'missing required field "hubUrl"',
	);

	writeConfig(home, "config.yml", "hubUrl: \" \"\n");
	expect(() => resolveHubUrl({ home })).toThrow(
		'field "hubUrl" must not be blank',
	);

	writeConfig(home, "config.yml", "hubUrl: 4173\n");
	expect(() => resolveHubUrl({ home })).toThrow(
		'field "hubUrl" must be a string',
	);
});
