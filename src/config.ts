import * as fs from "node:fs";
import type { A2aLocalConfig } from "./types";
import { AGENT_ID_RE, PROJECT_NAME_RE } from "./types";
import { localConfigCandidates } from "./paths";

/**
 * Minimal YAML subset for .omp/a2a.yml:
 *   key: value
 *   key: [a, b]
 *   key:
 *     - a
 *     - b
 * No nested maps beyond one-level lists.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const lines = text.split(/\r?\n/);
	let listKey: string | null = null;
	let list: string[] = [];

	const flushList = () => {
		if (listKey) {
			out[listKey] = list;
			listKey = null;
			list = [];
		}
	};

	for (const raw of lines) {
		const line = stripYamlComment(raw).trimEnd();
		if (!line.trim()) continue;

		const listItem = line.match(/^\s*-\s+(.+)$/);
		if (listItem) {
			if (!listKey) throw new Error("list item has no preceding key");
			list.push(parseYamlString(listItem[1]!.trim()));
			continue;
		}

		flushList();
		const match = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
		if (!match) throw new Error(`unsupported YAML line: ${line.trim()}`);
		const key = match[1]!;
		const value = match[2]!.trim();
		if (value === "" || value === "|" || value === ">") {
			listKey = key;
			list = [];
			continue;
		}
		if (value.startsWith("[")) {
			if (!value.endsWith("]")) throw new Error(`invalid inline list for ${key}`);
			const inner = value.slice(1, -1).trim();
			out[key] = inner ? splitYamlList(inner).map(parseYamlString).filter(Boolean) : [];
			continue;
		}
		if (value === "true") {
			out[key] = true;
			continue;
		}
		if (value === "false") {
			out[key] = false;
			continue;
		}
		if (/^\d+$/.test(value)) {
			out[key] = Number(value);
			continue;
		}
		out[key] = parseYamlString(value);
	}
	flushList();
	return out;
}

function stripYamlComment(line: string): string {
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i]!;
		if (quote === '"' && escaped) {
			escaped = false;
			continue;
		}
		if (quote === '"' && char === "\\") {
			escaped = true;
			continue;
		}
		if (quote === "'" && char === "'" && line[i + 1] === "'") {
			i += 1;
			continue;
		}
		if (char === quote) {
			quote = null;
			continue;
		}
		if (
			!quote &&
			(char === "'" || char === '"') &&
			[":", "-", "[", ","].includes(line.slice(0, i).trimEnd().at(-1) ?? "")
		) {
			quote = char;
			continue;
		}
		if (!quote && char === "#") return line.slice(0, i);
	}
	if (quote) throw new Error("unterminated quoted scalar");
	return line;
}

function splitYamlList(value: string): string[] {
	const values: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i]!;
		if (quote === '"' && escaped) {
			escaped = false;
			continue;
		}
		if (quote === '"' && char === "\\") {
			escaped = true;
			continue;
		}
		if (quote === "'" && char === "'" && value[i + 1] === "'") {
			i += 1;
			continue;
		}
		if (char === quote) {
			quote = null;
			continue;
		}
		if (!quote && (char === "'" || char === '"') && value.slice(start, i).trim().length === 0) {
			quote = char;
			continue;
		}
		if (!quote && char === ",") {
			values.push(value.slice(start, i).trim());
			start = i + 1;
		}
	}
	if (quote) throw new Error("unterminated quoted list value");
	values.push(value.slice(start).trim());
	return values;
}

function parseYamlString(value: string): string {
	if (value.startsWith('"')) {
		if (!value.endsWith('"')) throw new Error("unterminated double-quoted scalar");
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "string") throw new Error("invalid double-quoted scalar");
		return parsed;
	}
	if (value.startsWith("'")) {
		if (!value.endsWith("'")) throw new Error("unterminated single-quoted scalar");
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeConfig(raw: Record<string, unknown>): A2aLocalConfig {
	const project = String(raw.project ?? "").trim();
	const agentId = String(raw.agentId ?? raw.agent_id ?? raw.id ?? "").trim();
	if (!project) throw new Error("a2a config missing required field: project");
	if (!agentId) throw new Error("a2a config missing required field: agentId");
	if (!PROJECT_NAME_RE.test(project)) {
		throw new Error(`invalid project name "${project}" (use [a-zA-Z0-9._-], max 64)`);
	}
	if (!AGENT_ID_RE.test(agentId)) {
		throw new Error(`invalid agentId "${agentId}" (use [a-zA-Z0-9._-], max 32)`);
	}

	const capsRaw = raw.caps ?? raw.capabilities;
	const caps = Array.isArray(capsRaw)
		? capsRaw.map(String)
		: typeof capsRaw === "string"
			? capsRaw.split(",").map((s) => s.trim()).filter(Boolean)
			: undefined;


	return {
		project,
		agentId,
		hubUrl:
			raw.hubUrl != null
				? String(raw.hubUrl)
				: raw.hub_url != null
					? String(raw.hub_url)
					: undefined,
		caps,
		displayName:
			raw.displayName != null
				? String(raw.displayName)
				: raw.display_name != null
					? String(raw.display_name)
					: undefined,
		autoJoin: raw.autoJoin === false || raw.auto_join === false ? false : true,
	};
}

/** Load first existing local a2a config under cwd, or null if absent. */
export function loadLocalConfig(cwd: string): A2aLocalConfig | null {
	for (const p of localConfigCandidates(cwd)) {
		if (!fs.existsSync(p)) continue;
		try {
			const text = fs.readFileSync(p, "utf8");
			const parsed: unknown = p.endsWith(".json") ? JSON.parse(text) : parseSimpleYaml(text);
			if (!isRecord(parsed)) throw new Error("config must be an object");
			return normalizeConfig(parsed);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to load a2a config ${p}: ${message}`, { cause: error });
		}
	}
	return null;
}
