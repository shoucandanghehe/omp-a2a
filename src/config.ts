import * as fs from "node:fs";
import { localConfigCandidates } from "./paths";
import type { A2aLocalConfig } from "./types";
import { AGENT_NAME_RE, PROJECT_NAME_RE } from "./types";
import { parseSimpleYaml } from "./simple-yaml";

function readAlias(
	raw: Record<string, unknown>,
	keys: readonly string[],
): { key: string; value: unknown } | undefined {
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(raw, key)) {
			return { key, value: raw[key] };
		}
	}
	return undefined;
}

function requiredString(
	raw: Record<string, unknown>,
	key: "project" | "name",
): string {
	const value = raw[key];
	if (value === undefined)
		throw new Error(`a2a config missing required field: ${key}`);
	if (typeof value !== "string")
		throw new Error(`a2a config field "${key}" must be a string`);
	const normalized = value.trim();
	if (!normalized)
		throw new Error(`a2a config field "${key}" must not be blank`);
	return normalized;
}

function normalizeConfig(raw: Record<string, unknown>): A2aLocalConfig {
	if (
		"agentId" in raw ||
		"agent_id" in raw ||
		"autoJoin" in raw ||
		"auto_join" in raw
	) {
		throw new Error(
			"legacy a2a config detected; rename agentId to name and autoJoin to autoConnect",
		);
	}
	const project = requiredString(raw, "project");
	const name = requiredString(raw, "name");
	if (!PROJECT_NAME_RE.test(project)) {
		throw new Error(
			`invalid project name "${project}" (use [a-zA-Z0-9._-], max 64)`,
		);
	}
	if (!AGENT_NAME_RE.test(name)) {
		throw new Error(
			`invalid connection name "${name}" (use [a-zA-Z0-9._-], max 32)`,
		);
	}

	const hubUrl = readAlias(raw, ["hubUrl", "hub_url"]);
	if (hubUrl && typeof hubUrl.value !== "string") {
		throw new Error(`a2a config field "${hubUrl.key}" must be a string`);
	}
	const normalizedHubUrl =
		typeof hubUrl?.value === "string" ? hubUrl.value.trim() : undefined;
	if (hubUrl && !normalizedHubUrl) {
		throw new Error(`a2a config field "${hubUrl.key}" must not be blank`);
	}

	const autoConnect = readAlias(raw, ["autoConnect", "auto_connect"]);
	if (autoConnect && typeof autoConnect.value !== "boolean") {
		throw new Error(`a2a config field "${autoConnect.key}" must be a boolean`);
	}

	return {
		project,
		name,
		hubUrl: normalizedHubUrl,
		autoConnect:
			typeof autoConnect?.value === "boolean" ? autoConnect.value : true,
	};
}

/** Load first existing local a2a config under cwd, or null if absent. */
export function loadLocalConfig(cwd: string): A2aLocalConfig | null {
	for (const configPath of localConfigCandidates(cwd)) {
		if (!fs.existsSync(configPath)) continue;
		try {
			const text = fs.readFileSync(configPath, "utf8");
			const parsed: unknown = configPath.endsWith(".json")
				? JSON.parse(text)
				: parseSimpleYaml(text);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				throw new Error("config must be an object");
			}
			return normalizeConfig(parsed as Record<string, unknown>);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to load a2a config ${configPath}: ${message}`,
				{ cause: error },
			);
		}
	}
	return null;
}
