import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { a2aRoot } from "../paths";
import { parseSimpleYaml } from "../simple-yaml";
import type { A2aProject } from "../types";
import {
	A2A_PROTOCOL_VERSION,
	type HistoryPage,
	type HistoryQuery,
	type RealtimeMessage,
} from "./realtime-types";
import type { EncodedTextPayload, HubMeta } from "./types";

const DEFAULT_HUB_URL = "http://127.0.0.1:4173";
export const DEFAULT_HUB_REQUEST_TIMEOUT_MS = 15_000;

export interface HubRequestOptions {
	signal?: AbortSignal;
}

class HubHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function composeRequestSignal(
	caller: AbortSignal | null | undefined,
	timeout: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	for (const source of caller ? [caller, timeout] : [timeout]) {
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
		cleanup: () => {
			for (const entry of listeners) {
				entry.signal.removeEventListener("abort", entry.listener);
			}
		},
	};
}

async function fetchJson(
	url: string,
	init: RequestInit | undefined,
	requestTimeoutMs: number,
): Promise<unknown> {
	const composed = composeRequestSignal(
		init?.signal,
		AbortSignal.timeout(Math.ceil(requestTimeoutMs)),
	);
	try {
		let response: Response;
		try {
			response = await fetch(url, { ...init, signal: composed.signal });
		} catch (error) {
			if (composed.signal.aborted) throw composed.signal.reason ?? error;
			throw error;
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			if (composed.signal.aborted) throw composed.signal.reason ?? error;
			if (response.ok) throw new Error(`Hub returned invalid JSON for ${url}`);
			body = undefined;
		}
		if (!response.ok) {
			const errorMessage =
				typeof body === "object" &&
				body !== null &&
				!Array.isArray(body) &&
				"error" in body &&
				typeof body.error === "string"
					? body.error
					: `HTTP ${response.status} ${url}`;
			throw new HubHttpError(response.status, errorMessage);
		}
		return body;
	} finally {
		composed.cleanup();
	}
}

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function parseHubMeta(value: unknown): HubMeta {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Hub returned invalid metadata");
	}
	const meta = value as Record<string, unknown>;
	if (
		!Number.isSafeInteger(meta.pid) ||
		(meta.pid as number) < 0 ||
		!Number.isInteger(meta.port) ||
		(meta.port as number) < 1 ||
		(meta.port as number) > 65_535 ||
		!Number.isSafeInteger(meta.startedAt) ||
		(meta.startedAt as number) < 0 ||
		!Number.isSafeInteger(meta.protocolVersion) ||
		(meta.protocolVersion as number) < 0 ||
		typeof meta.dataDir !== "string" ||
		!meta.dataDir.trim() ||
		typeof meta.baseUrl !== "string" ||
		!meta.baseUrl ||
		meta.baseUrl !== meta.baseUrl.trim() ||
		stripTrailingSlash(meta.baseUrl) !== meta.baseUrl
	) {
		throw new Error("Hub returned invalid metadata");
	}
	try {
		const baseUrl = new URL(meta.baseUrl);
		const normalized = stripTrailingSlash(baseUrl.toString());
		if (
			(baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
			!baseUrl.hostname ||
			baseUrl.username ||
			baseUrl.password ||
			meta.baseUrl.includes("?") ||
			meta.baseUrl.includes("#") ||
			baseUrl.search ||
			baseUrl.hash ||
			normalized !== meta.baseUrl
		) {
			throw new Error("invalid base URL");
		}
	} catch (error) {
		throw new Error("Hub returned invalid metadata", { cause: error });
	}
	return value as HubMeta;
}

function parseProject(value: unknown): A2aProject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Hub returned an invalid Project");
	}
	const project = value as Record<string, unknown>;
	if (
		typeof project.name !== "string" ||
		!project.name ||
		!Number.isSafeInteger(project.createdAt) ||
		(project.createdAt as number) < 0 ||
		(project.displayName !== undefined &&
			typeof project.displayName !== "string") ||
		(project.description !== undefined &&
			typeof project.description !== "string") ||
		(project.createdByCwd !== undefined &&
			typeof project.createdByCwd !== "string")
	) {
		throw new Error("Hub returned an invalid Project");
	}
	return value as A2aProject;
}

function parsePayload(value: unknown): EncodedTextPayload {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Hub returned invalid history");
	}
	const payload = value as Record<string, unknown>;
	if (
		(payload.encoding !== "identity" && payload.encoding !== "gzip+base64") ||
		typeof payload.data !== "string" ||
		!Number.isSafeInteger(payload.uncompressedBytes) ||
		(payload.uncompressedBytes as number) < 0
	) {
		throw new Error("Hub returned invalid history");
	}
	return value as EncodedTextPayload;
}

function parseHistoryMessage(value: unknown): RealtimeMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Hub returned invalid history");
	}
	const message = value as Record<string, unknown>;
	const from = message.from;
	const target = message.target;
	if (
		typeof message.messageId !== "string" ||
		!message.messageId ||
		typeof message.messageRef !== "string" ||
		!message.messageRef ||
		typeof message.project !== "string" ||
		!message.project ||
		!Number.isSafeInteger(message.sequence) ||
		(message.sequence as number) < 0 ||
		!Number.isSafeInteger(message.createdAt) ||
		(message.createdAt as number) < 0 ||
		(message.replyTo !== undefined && typeof message.replyTo !== "string") ||
		typeof from !== "object" ||
		from === null ||
		Array.isArray(from) ||
		!("name" in from) ||
		typeof from.name !== "string" ||
		!from.name ||
		!("presenceId" in from) ||
		typeof from.presenceId !== "string" ||
		!from.presenceId ||
		typeof target !== "object" ||
		target === null ||
		Array.isArray(target)
	) {
		throw new Error("Hub returned invalid history");
	}
	const targetValue = target as Record<string, unknown>;
	if (
		(targetValue.type !== "project" && targetValue.type !== "agent") ||
		(targetValue.type === "agent" &&
			(typeof targetValue.name !== "string" ||
				!targetValue.name ||
				(targetValue.presenceId !== undefined &&
					typeof targetValue.presenceId !== "string")))
	) {
		throw new Error("Hub returned invalid history");
	}
	parsePayload(message.payload);
	return value as RealtimeMessage;
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
			const parsed: unknown = name.endsWith(".json")
				? JSON.parse(text)
				: parseSimpleYaml(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("config must be an object");
			}
			const config = parsed as Record<string, unknown>;
			let value: unknown;
			if (Object.prototype.hasOwnProperty.call(config, "hubUrl")) value = config.hubUrl;
			else if (Object.prototype.hasOwnProperty.call(config, "hub_url")) value = config.hub_url;
			else if (Object.prototype.hasOwnProperty.call(config, "url")) value = config.url;
			else throw new Error("config missing required Hub URL (hubUrl, hub_url, or url)");
			if (typeof value !== "string") throw new Error("Hub URL must be a string");
			if (!value.trim()) throw new Error("Hub URL must not be blank");
			return stripTrailingSlash(value.trim());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to load Hub config ${file}: ${message}`, {
				cause: error,
			});
		}
	}
	return DEFAULT_HUB_URL;
}

export async function probeHub(
	baseUrl: string,
	options: HubRequestOptions = {},
): Promise<HubMeta | null> {
	try {
		const value = await fetchJson(
			`${stripTrailingSlash(baseUrl)}/v1/meta`,
			{ signal: options.signal },
			1_500,
		);
		return parseHubMeta(value);
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		return null;
	}
}

export async function connectHub(options?: {
	hubUrl?: string;
	home?: string;
	signal?: AbortSignal;
}): Promise<HubMeta> {
	const baseUrl = resolveHubUrl(options);
	const meta = await probeHub(baseUrl, { signal: options?.signal });
	if (!meta) {
		throw new Error(
			`A2A Hub not reachable at ${baseUrl}. Start it separately with Docker Compose or set OMP_A2A_HUB_URL / hubUrl.`,
		);
	}
	if (meta.protocolVersion !== A2A_PROTOCOL_VERSION) {
		throw new Error(
			`A2A protocol mismatch: extension=${A2A_PROTOCOL_VERSION}, Hub=${meta.protocolVersion}`,
		);
	}
	return { ...meta, baseUrl };
}

export class HubClient {
	#baseUrl: string;
	#requestTimeoutMs: number;

	constructor(
		baseUrl: string,
		options: { requestTimeoutMs?: number } = {},
	) {
		this.#baseUrl = stripTrailingSlash(baseUrl);
		const requestTimeoutMs =
			options.requestTimeoutMs ?? DEFAULT_HUB_REQUEST_TIMEOUT_MS;
		if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
			throw new RangeError("requestTimeoutMs must be a positive finite number");
		}
		this.#requestTimeoutMs = requestTimeoutMs;
	}

	static async connect(options?: {
		hubUrl?: string;
		home?: string;
		signal?: AbortSignal;
		requestTimeoutMs?: number;
	}): Promise<HubClient> {
		const meta = await connectHub(options);
		return new HubClient(meta.baseUrl, {
			requestTimeoutMs: options?.requestTimeoutMs,
		});
	}

	get baseUrl(): string {
		return this.#baseUrl;
	}

	#fetchJson(url: string, init?: RequestInit): Promise<unknown> {
		return fetchJson(url, init, this.#requestTimeoutMs);
	}

	async meta(options: HubRequestOptions = {}): Promise<HubMeta> {
		return parseHubMeta(
			await this.#fetchJson(`${this.#baseUrl}/v1/meta`, {
				signal: options.signal,
			}),
		);
	}

	async createProject(
		body: {
			name: string;
			displayName?: string;
			description?: string;
			createdByCwd?: string;
		},
		options: HubRequestOptions = {},
	): Promise<A2aProject> {
		const value = await this.#fetchJson(`${this.#baseUrl}/v1/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options.signal,
		});
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			!("project" in value)
		) {
			throw new Error("Hub returned an invalid create-Project response");
		}
		return parseProject(value.project);
	}

	async deleteProject(
		name: string,
		options: HubRequestOptions = {},
	): Promise<boolean> {
		const value = await this.#fetchJson(
			`${this.#baseUrl}/v1/projects/${encodeURIComponent(name)}`,
			{ method: "DELETE", signal: options.signal },
		);
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			!("ok" in value) ||
			value.ok !== true ||
			!("deleted" in value) ||
			typeof value.deleted !== "boolean"
		) {
			throw new Error("Hub returned an invalid delete-Project response");
		}
		return value.deleted;
	}

	async listProjects(options: HubRequestOptions = {}): Promise<A2aProject[]> {
		const value = await this.#fetchJson(`${this.#baseUrl}/v1/projects`, {
			signal: options.signal,
		});
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			!("projects" in value) ||
			!Array.isArray(value.projects)
		) {
			throw new Error("Hub returned an invalid list-Projects response");
		}
		return value.projects.map(parseProject);
	}

	async history(
		query: HistoryQuery,
		options: HubRequestOptions = {},
	): Promise<HistoryPage> {
		const parameters = new URLSearchParams({ project: query.project });
		if (query.before) parameters.set("before", query.before);
		if (query.after) parameters.set("after", query.after);
		if (query.from) parameters.set("from", query.from);
		if (query.limit !== undefined) parameters.set("limit", String(query.limit));
		const value = await this.#fetchJson(
			`${this.#baseUrl}/v1/history?${parameters}`,
			{ signal: options.signal },
		);
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			!("messages" in value) ||
			!Array.isArray(value.messages)
		) {
			throw new Error("Hub returned invalid history");
		}
		return { messages: value.messages.map(parseHistoryMessage) };
	}
}
