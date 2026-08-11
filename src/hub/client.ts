import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { a2aRoot } from "../paths";
import {
	AGENT_NAME_RE,
	type A2aProject,
	PROJECT_NAME_RE,
} from "../types";
import { validateMessageContent } from "./payload";
import {
	A2A_PROTOCOL_VERSION,
	formatMessageRef,
	type HistoryPage,
	type HistoryQuery,
	MESSAGE_ID_RE,
	type MessageTarget,
	type Peer,
	parseMessageRef,
	type RealtimeMessage,
} from "./realtime-types";
import type { EncodedTextPayload, HubMeta } from "./types";

const DEFAULT_HUB_URL = "http://127.0.0.1:4173";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_500;

export type HubRequestOptions = {
	signal?: AbortSignal;
};

export class HubHttpError extends Error {
	constructor(
		readonly status: number,
		readonly url: string,
		readonly hubError?: string,
	) {
		super(
			`Hub request failed: HTTP ${status} ${url}${hubError ? `: ${hubError}` : ""}`,
		);
		this.name = "HubHttpError";
	}
}

export class HubDeadlineError extends Error {
	constructor(
		readonly operation: string,
		readonly timeoutMs: number,
	) {
		super(`${operation} timed out after ${timeoutMs}ms`);
		this.name = "HubDeadlineError";
	}
}

export class HubResponseError extends Error {
	constructor(
		readonly responseName: string,
		detail: string,
	) {
		super(`Hub returned invalid ${responseName}: ${detail}`);
		this.name = "HubResponseError";
	}
}

type Decoder<T> = (value: unknown) => T;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function stringField(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const field = value[key];
	if (typeof field !== "string") throw new Error(`${label}.${key} must be a string`);
	return field;
}

function optionalStringField(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	const field = value[key];
	if (field === undefined) return undefined;
	if (typeof field !== "string") throw new Error(`${label}.${key} must be a string`);
	return field;
}

function safeIntegerField(
	value: Record<string, unknown>,
	key: string,
	label: string,
	minimum: number,
): number {
	const field = value[key];
	if (
		typeof field !== "number" ||
		!Number.isSafeInteger(field) ||
		field < minimum
	) {
		throw new Error(`${label}.${key} must be a safe integer >= ${minimum}`);
	}
	return field;
}

function decodeHubMeta(value: unknown): HubMeta {
	const meta = record(value, "metadata");
	const pid = safeIntegerField(meta, "pid", "metadata", 1);
	const port = safeIntegerField(meta, "port", "metadata", 1);
	if (port > 65_535) throw new Error("metadata.port must be <= 65535");
	const baseUrl = stringField(meta, "baseUrl", "metadata");
	let parsedBaseUrl: URL;
	try {
		parsedBaseUrl = new URL(baseUrl);
	} catch {
		throw new Error("metadata.baseUrl must be a valid URL");
	}
	if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:")
		throw new Error("metadata.baseUrl must use HTTP or HTTPS");
	const dataDir = stringField(meta, "dataDir", "metadata");
	if (!dataDir) throw new Error("metadata.dataDir must not be empty");
	return {
		pid,
		port,
		baseUrl,
		dataDir,
		startedAt: safeIntegerField(meta, "startedAt", "metadata", 0),
		protocolVersion: safeIntegerField(
			meta,
			"protocolVersion",
			"metadata",
			0,
		),
	};
}

function decodeProject(value: unknown): A2aProject {
	const project = record(value, "project");
	const name = stringField(project, "name", "project");
	if (!PROJECT_NAME_RE.test(name)) throw new Error("project.name is invalid");
	const decoded: A2aProject = {
		name,
		createdAt: safeIntegerField(project, "createdAt", "project", 0),
	};
	const displayName = optionalStringField(project, "displayName", "project");
	const description = optionalStringField(project, "description", "project");
	const createdByCwd = optionalStringField(project, "createdByCwd", "project");
	if (displayName !== undefined) decoded.displayName = displayName;
	if (description !== undefined) decoded.description = description;
	if (createdByCwd !== undefined) decoded.createdByCwd = createdByCwd;
	return decoded;
}

function decodePeer(value: unknown): Peer {
	const peer = record(value, "message.from");
	const name = stringField(peer, "name", "message.from");
	if (!AGENT_NAME_RE.test(name)) throw new Error("message.from.name is invalid");
	const presenceId = stringField(peer, "presenceId", "message.from");
	if (!presenceId) throw new Error("message.from.presenceId must not be empty");
	return { name, presenceId };
}

function decodeTarget(value: unknown): MessageTarget {
	const target = record(value, "message.target");
	const type = stringField(target, "type", "message.target");
	if (type === "project") return { type };
	if (type !== "agent") throw new Error("message.target.type is invalid");
	const name = stringField(target, "name", "message.target");
	if (!AGENT_NAME_RE.test(name)) throw new Error("message.target.name is invalid");
	const presenceId = optionalStringField(
		target,
		"presenceId",
		"message.target",
	);
	if (presenceId === "") throw new Error("message.target.presenceId is invalid");
	return presenceId === undefined
		? { type, name }
		: { type, name, presenceId };
}

function decodeTextPayload(value: unknown): EncodedTextPayload {
	const payload = record(value, "message.payload");
	const encoding = stringField(payload, "encoding", "message.payload");
	const data = stringField(payload, "data", "message.payload");
	const uncompressedBytes = safeIntegerField(
		payload,
		"uncompressedBytes",
		"message.payload",
		0,
	);
	if (encoding === "identity")
		return { encoding, data, uncompressedBytes };
	if (encoding === "gzip+base64")
		return { encoding, data, uncompressedBytes };
	throw new Error("message.payload.encoding is invalid");
}

function decodeRealtimeMessage(value: unknown): RealtimeMessage {
	const message = record(value, "message");
	const messageId = stringField(message, "messageId", "message");
	if (!MESSAGE_ID_RE.test(messageId)) throw new Error("message.messageId is invalid");
	const project = stringField(message, "project", "message");
	if (!PROJECT_NAME_RE.test(project)) throw new Error("message.project is invalid");
	const sequence = safeIntegerField(message, "sequence", "message", 1);
	const messageRef = stringField(message, "messageRef", "message");
	if (messageRef !== formatMessageRef(project, sequence))
		throw new Error("message.messageRef is not canonical");
	const payload = decodeTextPayload(message.payload);
	const { attachments } = validateMessageContent(payload, message.attachments);
	const replyTo = optionalStringField(message, "replyTo", "message");
	if (replyTo !== undefined && parseMessageRef(replyTo).project !== project)
		throw new Error("message.replyTo belongs to another project");
	const decoded: RealtimeMessage = {
		messageId,
		messageRef,
		project,
		sequence,
		from: decodePeer(message.from),
		target: decodeTarget(message.target),
		payload,
		attachments,
		createdAt: safeIntegerField(message, "createdAt", "message", 0),
	};
	if (replyTo !== undefined) decoded.replyTo = replyTo;
	return decoded;
}

function decodeProjectList(value: unknown): A2aProject[] {
	const projects = record(value, "Project list response").projects;
	if (!Array.isArray(projects))
		throw new Error("Project list response.projects must be an array");
	return projects.map(decodeProject);
}

function decodeProjectDeletion(value: unknown): boolean {
	const response = record(value, "Project deletion response");
	if (response.ok !== true)
		throw new Error("Project deletion response.ok must be true");
	if (typeof response.deleted !== "boolean")
		throw new Error("Project deletion response.deleted must be a boolean");
	return response.deleted;
}

function decodeHistoryPage(value: unknown): HistoryPage {
	const messages = record(value, "history response").messages;
	if (!Array.isArray(messages))
		throw new Error("history response.messages must be an array");
	return { messages: messages.map(decodeRealtimeMessage) };
}

function throwIfRequestAborted(
	callerSignal: AbortSignal | undefined,
	timeoutSignal: AbortSignal,
	operation: string,
	timeoutMs: number,
): void {
	if (callerSignal?.aborted) throw callerSignal.reason;
	if (timeoutSignal.aborted) throw new HubDeadlineError(operation, timeoutMs);
}

function decodeHttpError(body: string): string | undefined {
	if (!body) return undefined;
	try {
		const value: unknown = JSON.parse(body);
		const candidate = record(value, "error response").error;
		return typeof candidate === "string" && candidate ? candidate : undefined;
	} catch {
		return undefined;
	}
}

async function requestJson<T>(options: {
	operation: string;
	responseName: string;
	url: string;
	timeoutMs: number;
	request?: HubRequestOptions;
	init?: RequestInit;
	decode: Decoder<T>;
}): Promise<T> {
	const callerSignal = options.request?.signal;
	if (callerSignal?.aborted) throw callerSignal.reason;
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
	const signal = AbortSignal.any(
		callerSignal ? [callerSignal, timeoutSignal] : [timeoutSignal],
	);
	try {
		const response = await fetch(options.url, { ...options.init, signal });
		const body = await response.text();
		throwIfRequestAborted(
			callerSignal,
			timeoutSignal,
			options.operation,
			options.timeoutMs,
		);
		if (!response.ok)
			throw new HubHttpError(
				response.status,
				options.url,
				decodeHttpError(body),
			);
		let value: unknown;
		try {
			value = JSON.parse(body);
		} catch {
			throw new HubResponseError(
				options.responseName,
				"response body is not valid JSON",
			);
		}
		throwIfRequestAborted(
			callerSignal,
			timeoutSignal,
			options.operation,
			options.timeoutMs,
		);
		try {
			return options.decode(value);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new HubResponseError(options.responseName, detail);
		}
	} catch (error) {
		if (callerSignal?.aborted) throw callerSignal.reason;
		if (timeoutSignal.aborted)
			throw new HubDeadlineError(options.operation, options.timeoutMs);
		throw error;
	}
}

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
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
		if (name.endsWith(".json")) {
			const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
				string,
				unknown
			>;
			const value = raw.hubUrl ?? raw.hub_url ?? raw.url;
			if (typeof value !== "string" || !value.trim())
				throw new Error(`invalid Hub URL in ${file}`);
			return stripTrailingSlash(value.trim());
		}
		for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
			const match = line.match(/^(?:hubUrl|hub_url|url)\s*:\s*(.+)$/);
			if (!match) continue;
			const captured = match[1];
			if (!captured) continue;
			let value = captured.trim().replace(/#.*$/, "").trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			if (!value) throw new Error(`invalid Hub URL in ${file}`);
			return stripTrailingSlash(value);
		}
		throw new Error(`Hub config has no hubUrl: ${file}`);
	}
	return DEFAULT_HUB_URL;
}

export async function probeHub(baseUrl: string): Promise<HubMeta | null> {
	try {
		return await new HubClient(baseUrl, {
			requestTimeoutMs: PROBE_TIMEOUT_MS,
		}).meta();
	} catch (error) {
		if (error instanceof HubDeadlineError || error instanceof TypeError) return null;
		throw error;
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
			`A2A protocol mismatch: extension=${A2A_PROTOCOL_VERSION}, Hub=${meta.protocolVersion}`,
		);
	}
	return { ...meta, baseUrl };
}

export class HubClient {
	#baseUrl: string;
	#requestTimeoutMs: number;

	constructor(baseUrl: string, options?: { requestTimeoutMs?: number }) {
		this.#baseUrl = stripTrailingSlash(baseUrl);
		this.#requestTimeoutMs =
			options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		if (
			!Number.isSafeInteger(this.#requestTimeoutMs) ||
			this.#requestTimeoutMs < 0
		) {
			throw new Error("Hub request timeout must be a non-negative safe integer");
		}
	}

	static async connect(options?: {
		hubUrl?: string;
		home?: string;
		requestTimeoutMs?: number;
	}): Promise<HubClient> {
		const meta = await connectHub(options);
		return new HubClient(
			meta.baseUrl,
			options?.requestTimeoutMs === undefined
				? undefined
				: { requestTimeoutMs: options.requestTimeoutMs },
		);
	}

	get baseUrl(): string {
		return this.#baseUrl;
	}

	async meta(options?: HubRequestOptions): Promise<HubMeta> {
		return await this.#request(
			"Hub metadata",
			"metadata response",
			"/v1/meta",
			decodeHubMeta,
			options,
		);
	}

	async createProject(
		body: {
			name: string;
			displayName?: string;
			description?: string;
			createdByCwd?: string;
		},
		options?: HubRequestOptions,
	): Promise<A2aProject> {
		return await this.#request(
			"Project creation",
			"Project creation response",
			"/v1/projects",
			(value) => {
				const response = record(value, "Project creation response");
				return decodeProject(response.project);
			},
			options,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		);
	}

	async deleteProject(
		name: string,
		options?: HubRequestOptions,
	): Promise<boolean> {
		return await this.#request(
			"Project deletion",
			"Project deletion response",
			`/v1/projects/${encodeURIComponent(name)}`,
			decodeProjectDeletion,
			options,
			{ method: "DELETE" },
		);
	}

	async listProjects(options?: HubRequestOptions): Promise<A2aProject[]> {
		return await this.#request(
			"Project listing",
			"Project list response",
			"/v1/projects",
			decodeProjectList,
			options,
		);
	}

	async history(
		query: HistoryQuery,
		options?: HubRequestOptions,
	): Promise<HistoryPage> {
		const parameters = new URLSearchParams({ project: query.project });
		if (query.before) parameters.set("before", query.before);
		if (query.after) parameters.set("after", query.after);
		if (query.from) parameters.set("from", query.from);
		if (query.limit !== undefined) parameters.set("limit", String(query.limit));
		return await this.#request(
			"History request",
			"history response",
			`/v1/history?${parameters}`,
			decodeHistoryPage,
			options,
		);
	}

	async #request<T>(
		operation: string,
		responseName: string,
		requestPath: string,
		decode: Decoder<T>,
		request?: HubRequestOptions,
		init?: RequestInit,
	): Promise<T> {
		return await requestJson({
			operation,
			responseName,
			url: `${this.#baseUrl}${requestPath}`,
			timeoutMs: this.#requestTimeoutMs,
			request,
			init,
			decode,
		});
	}
}
