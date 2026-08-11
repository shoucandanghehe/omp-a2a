import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfigDocument } from "../config-document";
import { a2aRoot } from "../paths";
import type { A2aProject } from "../types";
import {
	A2A_PROTOCOL_VERSION,
	type HistoryPage,
	type HistoryQuery,
} from "./realtime-types";
import type { HubMeta } from "./types";

const DEFAULT_HUB_URL = "http://127.0.0.1:4173";

class HubHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const body = (await response.json().catch(() => ({}))) as T & {
		error?: string;
	};
	if (!response.ok) {
		throw new HubHttpError(
			response.status,
			body.error ? String(body.error) : `HTTP ${response.status} ${url}`,
		);
	}
	return body;
}

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function validateGlobalHubConfig(document: unknown): string {
	if (
		typeof document !== "object" ||
		document === null ||
		Array.isArray(document)
	) {
		throw new Error("Hub config root must be an object");
	}
	const raw = document as Record<string, unknown>;
	for (const field of Object.keys(raw)) {
		if (field !== "hubUrl") {
			throw new Error(`Hub config has unknown field "${field}"`);
		}
	}
	if (!Object.hasOwn(raw, "hubUrl")) {
		throw new Error('Hub config missing required field "hubUrl"');
	}
	if (typeof raw.hubUrl !== "string") {
		throw new Error('Hub config field "hubUrl" must be a string');
	}
	const hubUrl = raw.hubUrl.trim();
	if (!hubUrl) {
		throw new Error('Hub config field "hubUrl" must not be blank');
	}
	return hubUrl;
}

/** Resolve Hub URL without starting a process. */
export function resolveHubUrl(options?: {
	hubUrl?: string;
	home?: string;
}): string {
	if (options?.hubUrl?.trim()) return stripTrailingSlash(options.hubUrl.trim());
	const environmentUrl = process.env.OMP_A2A_HUB_URL?.trim();
	if (environmentUrl) return stripTrailingSlash(environmentUrl);
	const home = options?.home ?? os.homedir();
	for (const name of ["config.yml", "config.yaml", "config.json"]) {
		const file = path.join(a2aRoot(home), name);
		if (!fs.existsSync(file)) continue;
		try {
			const text = fs.readFileSync(file, "utf8");
			const hubUrl = validateGlobalHubConfig(
				parseConfigDocument(text, file),
			);
			return stripTrailingSlash(hubUrl);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`invalid Hub config at ${file}: ${message}`, {
				cause: error,
			});
		}
	}
	return DEFAULT_HUB_URL;
}

export async function probeHub(baseUrl: string): Promise<HubMeta | null> {
	try {
		return await fetchJson<HubMeta>(`${stripTrailingSlash(baseUrl)}/v1/meta`, {
			signal: AbortSignal.timeout(1_500),
		});
	} catch {
		return null;
	}
}

export async function connectHub(options?: {
	hubUrl?: string;
	home?: string;
}): Promise<HubMeta> {
	const baseUrl = resolveHubUrl(options);
	const meta = await probeHub(baseUrl);
	if (!meta) {
		throw new Error(
			`A2A Hub not reachable at ${baseUrl}. Start it separately with Docker Compose or set OMP_A2A_HUB_URL / hubUrl.`,
		);
	}
	if (meta.protocolVersion !== A2A_PROTOCOL_VERSION) {
		throw new Error(
			`A2A protocol mismatch: extension=${A2A_PROTOCOL_VERSION}, Hub=${meta.protocolVersion ?? "legacy"}`,
		);
	}
	return { ...meta, baseUrl };
}

export class HubClient {
	#baseUrl: string;

	constructor(baseUrl: string) {
		this.#baseUrl = stripTrailingSlash(baseUrl);
	}

	static async connect(options?: {
		hubUrl?: string;
		home?: string;
	}): Promise<HubClient> {
		const meta = await connectHub(options);
		return new HubClient(meta.baseUrl);
	}

	get baseUrl(): string {
		return this.#baseUrl;
	}

	async meta(): Promise<HubMeta> {
		return await fetchJson<HubMeta>(`${this.#baseUrl}/v1/meta`);
	}

	async createProject(body: {
		name: string;
		displayName?: string;
		description?: string;
		createdByCwd?: string;
	}): Promise<A2aProject> {
		const response = await fetchJson<{ project: A2aProject }>(
			`${this.#baseUrl}/v1/projects`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		return response.project;
	}

	async deleteProject(name: string): Promise<boolean> {
		const response = await fetchJson<{ ok: true; deleted: boolean }>(
			`${this.#baseUrl}/v1/projects/${encodeURIComponent(name)}`,
			{ method: "DELETE" },
		);
		return response.deleted;
	}

	async listProjects(): Promise<A2aProject[]> {
		return (
			await fetchJson<{ projects: A2aProject[] }>(
				`${this.#baseUrl}/v1/projects`,
			)
		).projects;
	}

	async history(query: HistoryQuery): Promise<HistoryPage> {
		const parameters = new URLSearchParams({ project: query.project });
		if (query.before) parameters.set("before", query.before);
		if (query.after) parameters.set("after", query.after);
		if (query.from) parameters.set("from", query.from);
		if (query.limit !== undefined) parameters.set("limit", String(query.limit));
		return await fetchJson<HistoryPage>(
			`${this.#baseUrl}/v1/history?${parameters}`,
		);
	}
}
