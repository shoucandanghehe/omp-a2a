import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { a2aRoot } from "../paths";
import type { A2aMember, A2aProject } from "../types";
import { decodeWireEnvelope, encodeTextPayload } from "./payload";
import type {
	HubAckBatch,
	HubEnvelope,
	HubInboxBatch,
	HubMeta,
	HubRegisterBody,
	HubSendInput,
	HubWireEnvelope,
	HubWireInboxBatch,
} from "./types";

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
	const body = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) {
		throw new HubHttpError(response.status, body.error ? String(body.error) : `HTTP ${response.status} ${url}`);
	}
	return body;
}

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/** Resolve Hub URL without starting a process. */
export function resolveHubUrl(opts?: { hubUrl?: string; home?: string }): string {
	if (opts?.hubUrl?.trim()) return stripTrailingSlash(opts.hubUrl.trim());
	const env = process.env.OMP_A2A_HUB_URL?.trim();
	if (env) return stripTrailingSlash(env);

	const home = opts?.home ?? os.homedir();
	for (const name of ["config.yml", "config.yaml", "config.json"]) {
		const file = path.join(a2aRoot(home), name);
		if (!fs.existsSync(file)) continue;
		if (name.endsWith(".json")) {
			try {
				const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
				const value = raw.hubUrl ?? raw.hub_url ?? raw.url;
				if (typeof value === "string" && value.trim()) return stripTrailingSlash(value.trim());
			} catch {
				// Ignore malformed global config and continue to the default.
			}
			continue;
		}
		for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
			const match = line.match(/^(?:hubUrl|hub_url|url)\s*:\s*(.+)$/);
			if (!match) continue;
			let value = match[1]!.trim().replace(/#.*$/, "").trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (value) return stripTrailingSlash(value);
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

export async function connectHub(opts?: { hubUrl?: string; home?: string }): Promise<HubMeta> {
	const baseUrl = resolveHubUrl(opts);
	const meta = await probeHub(baseUrl);
	if (!meta) {
		throw new Error(
			`A2A hub not reachable at ${baseUrl}. Start it separately: \`bun run hub\` (or set OMP_A2A_HUB_URL / hubUrl in config).`,
		);
	}
	return meta;
}

export class HubClient {
	#baseUrl: string;

	constructor(baseUrl: string) {
		this.#baseUrl = stripTrailingSlash(baseUrl);
	}

	static async connect(opts?: { hubUrl?: string; home?: string }): Promise<HubClient> {
		const meta = await connectHub(opts);
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
		const response = await fetchJson<{ project: A2aProject }>(`${this.#baseUrl}/v1/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
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
		const response = await fetchJson<{ projects: A2aProject[] }>(`${this.#baseUrl}/v1/projects`);
		return response.projects;
	}

	async register(body: HubRegisterBody): Promise<{ member: A2aMember; hub: HubMeta }> {
		return await fetchJson<{ member: A2aMember; hub: HubMeta }>(`${this.#baseUrl}/v1/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async heartbeat(project: string, agentId: string): Promise<A2aMember> {
		const response = await fetchJson<{ member: A2aMember }>(`${this.#baseUrl}/v1/heartbeat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project, agentId }),
		});
		return response.member;
	}

	async unregister(project: string, agentId: string): Promise<void> {
		await fetchJson<{ ok: true }>(`${this.#baseUrl}/v1/unregister`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project, agentId }),
		});
	}

	async listMembers(project: string, all = false): Promise<A2aMember[]> {
		const query = new URLSearchParams({ project });
		if (all) query.set("all", "1");
		const response = await fetchJson<{ members: A2aMember[] }>(`${this.#baseUrl}/v1/members?${query}`);
		return response.members;
	}

	async send(input: HubSendInput): Promise<HubEnvelope> {
		const response = await fetchJson<{ ok: true; message: HubWireEnvelope }>(`${this.#baseUrl}/v1/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: input.project,
				from: input.from,
				to: input.to,
				messageId: input.messageId ?? crypto.randomUUID(),
				replyTo: input.replyTo,
				payload: encodeTextPayload(input.text),
			}),
		});
		return decodeWireEnvelope(response.message);
	}

	async inbox(project: string, agentId: string, limit = 500): Promise<HubEnvelope[]> {
		const query = new URLSearchParams({ project, agentId, limit: String(limit) });
		const response = await fetchJson<{ messages: HubWireEnvelope[] }>(`${this.#baseUrl}/v1/inbox?${query}`);
		return response.messages.map(decodeWireEnvelope);
	}

	async readInbox(project: string, agentId: string, limit = 500): Promise<HubInboxBatch> {
		try {
			const response = await fetchJson<HubWireInboxBatch>(`${this.#baseUrl}/v1/inbox/read`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ project, agentId, limit }),
			});
			return {
				messages: response.messages.map(decodeWireEnvelope),
				cursor: response.cursor,
			};
		} catch (error) {
			if (!(error instanceof HubHttpError) || error.status !== 404) throw error;
			const query = new URLSearchParams({ project, agentId, limit: String(limit) });
			const response = await fetchJson<{ messages: HubWireEnvelope[]; cursor?: number }>(
				`${this.#baseUrl}/v1/inbox?${query}`,
			);
			return {
				messages: response.messages.map(decodeWireEnvelope),
				cursor: Number.isSafeInteger(response.cursor) ? response.cursor! : 0,
			};
		}
	}

	async ack(project: string, agentId: string, messageIds: string[]): Promise<HubAckBatch | null> {
		const response = await fetchJson<Partial<HubAckBatch> & { ok: true }>(`${this.#baseUrl}/v1/inbox/ack`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project, agentId, messageIds }),
		});
		if (!Array.isArray(response.acknowledgments) || !Number.isSafeInteger(response.cursor)) return null;
		return { acknowledgments: response.acknowledgments, cursor: response.cursor! };
	}
}
