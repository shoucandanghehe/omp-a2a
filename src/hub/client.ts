import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { a2aRoot } from "../paths";
import type { A2aMember, A2aProject, MemberRegistration } from "../types";
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
export const DEFAULT_HUB_REQUEST_TIMEOUT_MS = 15_000;

class HubHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function composeRequestSignal(caller: AbortSignal | null | undefined, timeout: AbortSignal) {
	const controller = new AbortController();
	const sources = caller ? [caller, timeout] : [timeout];
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	for (const source of sources) {
		if (source.aborted) {
			controller.abort(source.reason);
			break;
		}
		const listener = () => controller.abort(source.reason);
		source.addEventListener("abort", listener, { once: true });
		listeners.push({ signal: source, listener });
	}
	return {
		signal: controller.signal,
		cleanup() {
			for (const entry of listeners) {
				entry.signal.removeEventListener("abort", entry.listener);
			}
		},
	};
}

async function fetchJson<T>(
	url: string,
	init: RequestInit | undefined,
	requestTimeoutMs: number,
): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(Math.ceil(requestTimeoutMs));
	const composed = composeRequestSignal(init?.signal, timeoutSignal);
	try {
		const response = await fetch(url, { ...init, signal: composed.signal });
		let body: T & { error?: string };
		try {
			body = (await response.json()) as T & { error?: string };
		} catch (error) {
			if (composed.signal.aborted) throw composed.signal.reason ?? error;
			if (response.ok) throw new Error(`Hub returned invalid JSON for ${url}`);
			body = {} as T & { error?: string };
		}
		if (!response.ok) {
			throw new HubHttpError(response.status, body.error ? String(body.error) : `HTTP ${response.status} ${url}`);
		}
		return body;
	} finally {
		composed.cleanup();
	}
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
		return await fetchJson<HubMeta>(
			`${stripTrailingSlash(baseUrl)}/v1/meta`,
			undefined,
			1_500,
		);
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
	#leases = new Map<string, string>();
	#requestTimeoutMs: number;

	constructor(baseUrl: string, options: { requestTimeoutMs?: number } = {}) {
		this.#baseUrl = stripTrailingSlash(baseUrl);
		const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HUB_REQUEST_TIMEOUT_MS;
		if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
			throw new RangeError("requestTimeoutMs must be a positive finite number");
		}
		this.#requestTimeoutMs = requestTimeoutMs;
	}

	static async connect(opts?: { hubUrl?: string; home?: string }): Promise<HubClient> {
		const meta = await connectHub(opts);
		return new HubClient(meta.baseUrl);
	}

	get baseUrl(): string {
		return this.#baseUrl;
	}

	#fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
		return fetchJson<T>(url, init, this.#requestTimeoutMs);
	}

	async meta(): Promise<HubMeta> {
		return await this.#fetchJson<HubMeta>(`${this.#baseUrl}/v1/meta`);
	}

	async createProject(body: {
		name: string;
		displayName?: string;
		description?: string;
		createdByCwd?: string;
	}): Promise<A2aProject> {
		const response = await this.#fetchJson<{ project: A2aProject }>(`${this.#baseUrl}/v1/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return response.project;
	}

	async deleteProject(name: string): Promise<boolean> {
		const response = await this.#fetchJson<{ ok: true; deleted: boolean }>(
			`${this.#baseUrl}/v1/projects/${encodeURIComponent(name)}`,
			{ method: "DELETE" },
		);
		return response.deleted;
	}

	async listProjects(): Promise<A2aProject[]> {
		const response = await this.#fetchJson<{ projects: A2aProject[] }>(`${this.#baseUrl}/v1/projects`);
		return response.projects;
	}

	async register(body: HubRegisterBody): Promise<MemberRegistration & { hub: HubMeta }> {
		const registration = await this.#fetchJson<MemberRegistration & { hub: HubMeta }>(
			`${this.#baseUrl}/v1/register`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		this.#leases.set(`${body.project}\0${body.agentId}`, registration.leaseId);
		return registration;
	}

	async heartbeat(project: string, agentId: string, leaseId: string, signal?: AbortSignal): Promise<A2aMember> {
		const response = await this.#fetchJson<{ member: A2aMember }>(`${this.#baseUrl}/v1/heartbeat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project, agentId, leaseId }),
			signal,
		});
		return response.member;
	}

	async unregister(project: string, agentId: string, leaseId: string): Promise<void> {
		await this.#fetchJson<{ ok: true }>(`${this.#baseUrl}/v1/unregister`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project, agentId, leaseId }),
		});
	}

	async listMembers(project: string, all = false): Promise<A2aMember[]> {
		const query = new URLSearchParams({ project });
		if (all) query.set("all", "1");
		const response = await this.#fetchJson<{ members: A2aMember[] }>(`${this.#baseUrl}/v1/members?${query}`);
		return response.members;
	}

	async send(input: HubSendInput): Promise<HubEnvelope> {
		const response = await this.#fetchJson<{ ok: true; message: HubWireEnvelope }>(
			`${this.#baseUrl}/v1/send`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					project: input.project,
					from: input.from,
					to: input.to,
					messageId: input.messageId ?? crypto.randomUUID(),
					replyTo: input.replyTo,
					replyToRef: input.replyToRef,
					payload: encodeTextPayload(input.text),
				}),
			},
		);
		return decodeWireEnvelope(response.message);
	}

	async inbox(project: string, agentId: string, limit = 500, leaseId?: string): Promise<HubEnvelope[]> {
		const query = new URLSearchParams({ project, agentId, limit: String(limit) });
		const ownership = leaseId ?? this.#leases.get(`${project}\0${agentId}`);
		const response = await this.#fetchJson<{ messages: HubWireEnvelope[] }>(`${this.#baseUrl}/v1/inbox?${query}`, {
			headers: ownership ? { "x-a2a-lease": ownership } : undefined,
		});
		return response.messages.map(decodeWireEnvelope);
	}

	async readInbox(
		project: string,
		agentId: string,
		limit = 500,
		leaseId?: string,
		signal?: AbortSignal,
	): Promise<HubInboxBatch> {
		const ownership = leaseId ?? this.#leases.get(`${project}\0${agentId}`);
		try {
			const response = await this.#fetchJson<HubWireInboxBatch>(`${this.#baseUrl}/v1/inbox/read`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ project, agentId, limit, leaseId: ownership }),
				signal,
			});
			return {
				messages: response.messages.map(decodeWireEnvelope),
				cursor: response.cursor,
			};
		} catch (error) {
			if (!(error instanceof HubHttpError) || error.status !== 404) throw error;
			const query = new URLSearchParams({ project, agentId, limit: String(limit) });
			const response = await this.#fetchJson<{ messages: HubWireEnvelope[]; cursor?: number }>(
				`${this.#baseUrl}/v1/inbox?${query}`,
				{
					headers: ownership ? { "x-a2a-lease": ownership } : undefined,
					signal,
				},
			);
			return {
				messages: response.messages.map(decodeWireEnvelope),
				cursor: Number.isSafeInteger(response.cursor) ? response.cursor! : 0,
			};
		}
	}

	async ack(
		project: string,
		agentId: string,
		messageIds: string[],
		leaseId?: string,
		signal?: AbortSignal,
	): Promise<HubAckBatch | null> {
		const ownership = leaseId ?? this.#leases.get(`${project}\0${agentId}`);
		const response = await this.#fetchJson<Partial<HubAckBatch> & { ok: true }>(
			`${this.#baseUrl}/v1/inbox/ack`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ project, agentId, messageIds, leaseId: ownership }),
				signal,
			},
		);
		if (!Array.isArray(response.acknowledgments) || !Number.isSafeInteger(response.cursor)) return null;
		return { acknowledgments: response.acknowledgments, cursor: response.cursor! };
	}
}
