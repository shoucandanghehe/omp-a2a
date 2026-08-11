import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type as omptype } from "@oh-my-pi/omptype";
import { parseWithSchema } from "../config-document";
import { a2aRoot } from "../paths";
import { type A2aProject, AGENT_NAME_RE, PROJECT_NAME_RE } from "../types";
import {
	parseEncodedAttachments,
	decodeTextPayload as validateEncodedText,
} from "./payload";
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

export class HubTransportError extends Error {
	constructor(
		readonly operation: string,
		readonly url: string,
		cause: unknown,
	) {
		super(`${operation} failed to reach ${url}`, { cause });
		this.name = "HubTransportError";
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

const HUB_META_KEYS = ["protocolVersion"] as const;
const PROJECT_KEYS = [
	"name",
	"displayName",
	"description",
	"createdAt",
	"createdByCwd",
] as const;
const PEER_KEYS = ["name", "presenceId"] as const;
const PROJECT_TARGET_KEYS = ["type"] as const;
const AGENT_TARGET_KEYS = ["type", "name", "presenceId"] as const;
const PAYLOAD_KEYS = ["encoding", "data"] as const;
const ATTACHMENT_KEYS = ["name", "payload"] as const;
const MESSAGE_KEYS = [
	"messageId",
	"messageRef",
	"project",
	"sequence",
	"from",
	"target",
	"payload",
	"attachments",
	"createdAt",
	"replyTo",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactRecord(
	value: unknown,
	label: string,
	expectedKeys: readonly string[],
): Record<string, unknown> {
	const candidate = record(value, label);
	for (const key of Object.keys(candidate)) {
		if (!expectedKeys.includes(key))
			throw new Error(`${label}.${key} is not allowed`);
	}
	return candidate;
}

function assertExactAttachmentKeys(value: unknown): void {
	if (!Array.isArray(value)) return;
	for (const [index, candidate] of value.entries()) {
		const label = `message.attachments[${index}]`;
		const attachment = exactRecord(candidate, label, ATTACHMENT_KEYS);
		exactRecord(attachment.payload, `${label}.payload`, PAYLOAD_KEYS);
	}
}

function stringField(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const field = value[key];
	if (typeof field !== "string")
		throw new Error(`${label}.${key} must be a string`);
	return field;
}

function optionalStringField(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	const field = value[key];
	if (field === undefined) return undefined;
	if (typeof field !== "string")
		throw new Error(`${label}.${key} must be a string`);
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
	const meta = exactRecord(value, "metadata", HUB_META_KEYS);
	return {
		protocolVersion: safeIntegerField(meta, "protocolVersion", "metadata", 0),
	};
}

function decodeProject(value: unknown): A2aProject {
	const project = exactRecord(value, "project", PROJECT_KEYS);
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
	const peer = exactRecord(value, "message.from", PEER_KEYS);
	const name = stringField(peer, "name", "message.from");
	if (!AGENT_NAME_RE.test(name))
		throw new Error("message.from.name is invalid");
	const presenceId = stringField(peer, "presenceId", "message.from");
	if (!presenceId) throw new Error("message.from.presenceId must not be empty");
	return { name, presenceId };
}

function decodeTarget(value: unknown): MessageTarget {
	const candidate = record(value, "message.target");
	const type = stringField(candidate, "type", "message.target");
	const target = exactRecord(
		candidate,
		"message.target",
		type === "project" ? PROJECT_TARGET_KEYS : AGENT_TARGET_KEYS,
	);
	if (type === "project") return { type };
	if (type !== "agent") throw new Error("message.target.type is invalid");
	const name = stringField(target, "name", "message.target");
	if (!AGENT_NAME_RE.test(name))
		throw new Error("message.target.name is invalid");
	const presenceId = optionalStringField(
		target,
		"presenceId",
		"message.target",
	);
	if (presenceId === "")
		throw new Error("message.target.presenceId is invalid");
	return presenceId === undefined ? { type, name } : { type, name, presenceId };
}

function decodeTextPayload(value: unknown): EncodedTextPayload {
	const payload = exactRecord(value, "message.payload", PAYLOAD_KEYS);
	const encoding = stringField(payload, "encoding", "message.payload");
	const data = stringField(payload, "data", "message.payload");
	if (encoding !== "identity" && encoding !== "gzip+base64")
		throw new Error("message.payload.encoding is invalid");
	const decoded: EncodedTextPayload = { encoding, data };
	validateEncodedText(decoded);
	return decoded;
}

function decodeRealtimeMessage(value: unknown): RealtimeMessage {
	const message = exactRecord(value, "message", MESSAGE_KEYS);
	const messageId = stringField(message, "messageId", "message");
	if (!MESSAGE_ID_RE.test(messageId))
		throw new Error("message.messageId is invalid");
	const project = stringField(message, "project", "message");
	if (!PROJECT_NAME_RE.test(project))
		throw new Error("message.project is invalid");
	const sequence = safeIntegerField(message, "sequence", "message", 1);
	const messageRef = stringField(message, "messageRef", "message");
	if (messageRef !== formatMessageRef(project, sequence))
		throw new Error("message.messageRef is not canonical");
	const payload = decodeTextPayload(message.payload);
	assertExactAttachmentKeys(message.attachments);
	const attachments = parseEncodedAttachments(message.attachments);
	const replyTo = optionalStringField(message, "replyTo", "message");
	if (replyTo !== undefined) {
		const reply = parseMessageRef(replyTo);
		if (reply.project !== project)
			throw new Error("message.replyTo belongs to another project");
		if (reply.sequence >= sequence)
			throw new Error("message.replyTo must precede the message");
	}
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
	const projects = exactRecord(value, "Project list response", [
		"projects",
	]).projects;
	if (!Array.isArray(projects))
		throw new Error("Project list response.projects must be an array");
	return projects.map(decodeProject);
}

function decodeProjectDeletion(value: unknown): boolean {
	const response = exactRecord(value, "Project deletion response", [
		"ok",
		"deleted",
	]);
	if (response.ok !== true)
		throw new Error("Project deletion response.ok must be true");
	if (typeof response.deleted !== "boolean")
		throw new Error("Project deletion response.deleted must be a boolean");
	return response.deleted;
}

function decodeHistoryPage(value: unknown, project: string): HistoryPage {
	const response = exactRecord(value, "history response", ["messages"]);
	if (!Array.isArray(response.messages))
		throw new Error("history response.messages must be an array");
	const messages = response.messages.map(decodeRealtimeMessage);
	let previousSequence = 0;
	for (const message of messages) {
		if (message.project !== project)
			throw new Error("history response contains another Project");
		if (message.sequence <= previousSequence)
			throw new Error("history response sequences must be strictly increasing");
		previousSequence = message.sequence;
	}
	return { messages };
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
	let response: Response;
	let body: string;
	try {
		response = await fetch(options.url, { ...options.init, signal });
		body = await response.text();
	} catch (error) {
		throwIfRequestAborted(
			callerSignal,
			timeoutSignal,
			options.operation,
			options.timeoutMs,
		);
		throw new HubTransportError(options.operation, options.url, error);
	}
	throwIfRequestAborted(
		callerSignal,
		timeoutSignal,
		options.operation,
		options.timeoutMs,
	);
	if (!response.ok)
		throw new HubHttpError(response.status, options.url, decodeHttpError(body));
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
}

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

const globalHubConfigSchema = omptype({
	hubUrl: omptype("string")
		.pipe((value) => value.trim())
		.narrow(
			(value, context) =>
				value.length > 0 || context.mustBe("a non-blank string"),
		),
	"+": "reject",
});

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
		const config = parseWithSchema(file, globalHubConfigSchema, {
			label: "Hub config",
		});
		return stripTrailingSlash(config.hubUrl);
	}
	return DEFAULT_HUB_URL;
}

export async function probeHub(baseUrl: string): Promise<HubMeta | null> {
	try {
		return await new HubClient(baseUrl, {
			requestTimeoutMs: PROBE_TIMEOUT_MS,
		}).meta();
	} catch (error) {
		if (error instanceof HubTransportError) return null;
		throw error;
	}
}

export async function connectHub(options?: {
	hubUrl?: string;
	home?: string;
}): Promise<string> {
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
	return baseUrl;
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
			throw new Error(
				"Hub request timeout must be a non-negative safe integer",
			);
		}
	}

	static async connect(options?: {
		hubUrl?: string;
		home?: string;
		requestTimeoutMs?: number;
	}): Promise<HubClient> {
		const baseUrl = await connectHub(options);
		return new HubClient(
			baseUrl,
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
				const response = exactRecord(value, "Project creation response", [
					"project",
				]);
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
		const { project: requestedProject, before, after, from, limit } = query;
		const parameters = new URLSearchParams({ project: requestedProject });
		if (before) parameters.set("before", before);
		if (after) parameters.set("after", after);
		if (from) parameters.set("from", from);
		if (limit !== undefined) parameters.set("limit", String(limit));
		return await this.#request(
			"History request",
			"history response",
			`/v1/history?${parameters}`,
			(value) => decodeHistoryPage(value, requestedProject),
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
