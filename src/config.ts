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
function parseSimpleYaml(text: string): Record<string, unknown> {
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
		const line = raw.replace(/#.*$/, "").trimEnd();
		if (!line.trim()) continue;

		const listItem = line.match(/^\s*-\s+(.+)$/);
		if (listItem && listKey) {
			list.push(stripQuotes(listItem[1].trim()));
			continue;
		}

		flushList();
		const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
		if (!m) continue;
		const key = m[1];
		const val = m[2].trim();
		if (val === "" || val === "|" || val === ">") {
			listKey = key;
			list = [];
			continue;
		}
		if (val.startsWith("[") && val.endsWith("]")) {
			const inner = val.slice(1, -1).trim();
			out[key] = inner
				? inner.split(",").map((s) => stripQuotes(s.trim())).filter(Boolean)
				: [];
			continue;
		}
		if (val === "true") {
			out[key] = true;
			continue;
		}
		if (val === "false") {
			out[key] = false;
			continue;
		}
		if (/^\d+$/.test(val)) {
			out[key] = Number(val);
			continue;
		}
		out[key] = stripQuotes(val);
	}
	flushList();
	return out;
}

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
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
		const text = fs.readFileSync(p, "utf8");
		const raw = p.endsWith(".json") ? (JSON.parse(text) as Record<string, unknown>) : parseSimpleYaml(text);
		return normalizeConfig(raw);
	}
	return null;
}
