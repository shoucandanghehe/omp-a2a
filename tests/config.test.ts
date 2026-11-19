import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadLocalConfig,
	saveLocalConnections,
	saveLocalDefaults,
} from "../src/config";

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
			room: "billing",
			name: "api",
			hubUrl: "http://hub:4173",
			autoConnect: false,
		}),
	);
	expect(loadLocalConfig(root)).toEqual({
		rooms: [{ room: "billing", name: "api" }],
		hubUrl: "http://hub:4173",
		autoConnect: false,
	});
});

test("local YAML preserves quoted URL punctuation", () => {
	const root = createRoot();
	writeConfig(
		root,
		"a2a.yml",
		'room: " billing "\nname: " api "\nhubUrl: " http://hub:4173/path#fragment "\n',
	);
	expect(loadLocalConfig(root)).toEqual({
		rooms: [{ room: "billing", name: "api" }],
		hubUrl: "http://hub:4173/path#fragment",
		autoConnect: true,
	});
});

test("local YAML accepts multiple Rooms with shared settings", () => {
	const root = createRoot();
	writeConfig(
		root,
		"a2a.yaml",
		'rooms:\n  - room: " billing "\n    name: " api "\n  - room: support\n    name: " 支援 "\nhubUrl: http://hub:4173\n',
	);
	expect(loadLocalConfig(root)).toEqual({
		rooms: [
			{ room: "billing", name: "api" },
			{ room: "support", name: "支援" },
		],
		hubUrl: "http://hub:4173",
		autoConnect: true,
	});
});

test("a Hub-only YAML config needs no startup Room", () => {
	const root = createRoot();
	writeConfig(root, "a2a.yml", "rooms: []\nhubUrl: http://hub:4173\n");
	expect(loadLocalConfig(root)).toEqual({
		rooms: [],
		hubUrl: "http://hub:4173",
		autoConnect: true,
	});
});

test.each([
	{ rooms: [], room: "billing" },
	{ rooms: null },
	{ rooms: [{ room: "billing", name: "api" }], room: "billing" },
	{ rooms: [{ room: "billing", name: "api" }], name: "api" },
	{ rooms: [{ room: "billing", name: "api", autoConnect: false }] },
	{ rooms: [{ room: "billing", name: "api" }], autoConect: false },
])("local config rejects invalid plural shape %j", (document) => {
	const root = createRoot();
	const file = writeConfig(root, "a2a.json", JSON.stringify(document));
	expect(() => loadLocalConfig(root)).toThrow(`invalid a2a config at ${file}`);
});

test("local config rejects Rooms that match after trimming", () => {
	const root = createRoot();
	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({
			rooms: [
				{ room: "billing", name: "api" },
				{ room: " billing ", name: "other" },
			],
		}),
	);
	expect(() => loadLocalConfig(root)).toThrow("unique Room names");
});

test("local config reports malformed YAML with its path", () => {
	const root = createRoot();
	const file = writeConfig(root, "a2a.yml", "room: [\nname: api\n");
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
				room: "billing",
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
			room: "billing",
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
		"room: billing\nname: api\nunexpected: true\n",
	);
	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ room: "fallback", name: "fallback" }),
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
			JSON.stringify({ room: "billing", name: "api", [field]: true }),
		);
		expect(() => loadLocalConfig(root)).toThrow(
			`field "${field}" was removed; rename agentId to name and autoJoin to autoConnect`,
		);
	}
});

test("renamed project field requires migration to room", () => {
	const root = createRoot();
	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ project: "billing", name: "api" }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		'field "project" was renamed to "room"',
	);
});

test("local config names invalid required and optional fields", () => {
	const root = createRoot();
	writeConfig(root, "a2a.json", JSON.stringify({ name: "api" }));
	expect(() => loadLocalConfig(root)).toThrow("room must be a string");

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ room: " ", name: "api", hubUrl: "" }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		"room must be a non-blank string",
	);

	writeConfig(root, "a2a.json", JSON.stringify({ room: "billing", name: 7 }));
	expect(() => loadLocalConfig(root)).toThrow("name must be a string");

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ room: "billing room", name: "api" }),
	);
	expect(() => loadLocalConfig(root)).toThrow("room must be a valid Room name");

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ room: "billing", name: "api worker" }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		"name must be a valid Agent name",
	);

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({ room: "billing", name: "api", hubUrl: " " }),
	);
	expect(() => loadLocalConfig(root)).toThrow(
		"hubUrl must be a non-blank string",
	);

	writeConfig(
		root,
		"a2a.json",
		JSON.stringify({
			room: "billing",
			name: "api",
			autoConnect: "false",
		}),
	);
	expect(() => loadLocalConfig(root)).toThrow("autoConnect must be boolean");
});

test("saving replaces the selected JSON config with all connections", () => {
	const root = createRoot();
	const file = writeConfig(
		root,
		"a2a.json",
		'{"room":"billing","name":"old","autoConnect":false}',
	);
	const target = {
		rooms: [
			{ room: "billing", name: "api" },
			{ room: "support", name: "triage" },
		],
		hubUrl: "http://hub:4173",
	};
	expect(saveLocalConnections(root, target)).toBe(file);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
		rooms: [
			{ room: "billing", name: "api" },
			{ room: "support", name: "triage" },
		],
		hubUrl: "http://hub:4173",
		autoConnect: true,
	});
	expect(readdirSync(join(root, ".omp"))).toEqual(["a2a.json"]);

	const singleton = { ...target, rooms: [target.rooms[1]] };
	expect(saveLocalConnections(root, singleton)).toBe(file);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
		room: "support",
		name: "triage",
		hubUrl: "http://hub:4173",
		autoConnect: true,
	});
});

test("saving unchanged connections leaves an existing YAML file untouched", () => {
	const root = createRoot();
	const content =
		"# Kept on no-op\nrooms:\n  - {room: billing, name: api}\n  - {room: support, name: triage}\nhubUrl: http://hub:4173\n";
	const file = writeConfig(root, "a2a.yml", content);
	expect(
		saveLocalConnections(root, {
			rooms: [
				{ room: "billing", name: "api" },
				{ room: "support", name: "triage" },
			],
			hubUrl: "http://hub:4173",
		}),
	).toBe(file);
	expect(readFileSync(file, "utf8")).toBe(content);
});

test("saving project defaults clears the Hub override and preserves disabled auto-connect", () => {
	const root = createRoot();
	const file = writeConfig(
		root,
		"a2a.json",
		'{"room":"billing","name":"old","hubUrl":"http://hub:4173"}',
	);
	const rooms = [{ room: "support", name: "triage" }];
	expect(saveLocalDefaults(root, { rooms, autoConnect: false })).toBe(file);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
		room: "support",
		name: "triage",
		autoConnect: false,
	});
	expect(loadLocalConfig(root)).toEqual({ rooms, autoConnect: false });
});

test("saving after removing the last startup Room keeps the project Hub", () => {
	const root = createRoot();
	const file = writeConfig(
		root,
		"a2a.json",
		'{"room":"billing","name":"api","hubUrl":"http://hub:4173"}',
	);
	const defaults = {
		rooms: [],
		hubUrl: "http://hub:4173",
		autoConnect: false,
	};
	expect(saveLocalDefaults(root, defaults)).toBe(file);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(defaults);
	expect(loadLocalConfig(root)).toEqual(defaults);
});
