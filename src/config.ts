import * as fs from "node:fs";
import { parseConfigDocument } from "./config-document";
import { localConfigCandidates } from "./paths";
import type { A2aLocalConfig } from "./types";
import { AGENT_NAME_RE, PROJECT_NAME_RE } from "./types";

const LOCAL_FIELDS: Record<string, true> = {
	project: true,
	name: true,
	hubUrl: true,
	autoConnect: true,
};
const REMOVED_FIELDS: Record<string, true> = {
	agentId: true,
	agent_id: true,
	autoJoin: true,
	auto_join: true,
};

function requireObject(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("a2a config root must be an object");
	}
	return raw as Record<string, unknown>;
}

function requireString(
	raw: Record<string, unknown>,
	field: "project" | "name",
): string {
	if (!(field in raw)) {
		throw new Error(`a2a config missing required field: ${field}`);
	}
	const value = raw[field];
	if (typeof value !== "string") {
		throw new Error(`a2a config field "${field}" must be a string`);
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`a2a config field "${field}" must not be blank`);
	}
	return trimmed;
}

function validateLocalConfig(document: unknown): A2aLocalConfig {
	const raw = requireObject(document);
	for (const field of Object.keys(raw)) {
		if (Object.hasOwn(REMOVED_FIELDS, field)) {
			throw new Error(
				`a2a config field "${field}" was removed; rename agentId to name and autoJoin to autoConnect`,
			);
		}
		if (!Object.hasOwn(LOCAL_FIELDS, field)) {
			throw new Error(`a2a config has unknown field "${field}"`);
		}
	}

	const project = requireString(raw, "project");
	const name = requireString(raw, "name");
	if (!PROJECT_NAME_RE.test(project)) {
		throw new Error(
			`a2a config field "project" has invalid value "${project}" (use [a-zA-Z0-9._-], max 64)`,
		);
	}
	if (!AGENT_NAME_RE.test(name)) {
		throw new Error(
			`a2a config field "name" has invalid value "${name}" (use [a-zA-Z0-9._-], max 32)`,
		);
	}

	let hubUrl: string | undefined;
	if ("hubUrl" in raw) {
		if (typeof raw.hubUrl !== "string") {
			throw new Error('a2a config field "hubUrl" must be a string');
		}
		hubUrl = raw.hubUrl.trim();
		if (!hubUrl) {
			throw new Error('a2a config field "hubUrl" must not be blank');
		}
	}

	let autoConnect = true;
	if ("autoConnect" in raw) {
		if (typeof raw.autoConnect !== "boolean") {
			throw new Error('a2a config field "autoConnect" must be a boolean');
		}
		autoConnect = raw.autoConnect;
	}

	return { project, name, hubUrl, autoConnect };
}

/** Load first existing local a2a config under cwd, or null if absent. */
export function loadLocalConfig(cwd: string): A2aLocalConfig | null {
	for (const file of localConfigCandidates(cwd)) {
		if (!fs.existsSync(file)) continue;
		try {
			const text = fs.readFileSync(file, "utf8");
			return validateLocalConfig(parseConfigDocument(text, file));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`invalid a2a config at ${file}: ${message}`, {
				cause: error,
			});
		}
	}
	return null;
}
