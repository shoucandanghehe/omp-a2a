import express from "express";
import * as fs from "node:fs";
import type { Server } from "node:http";
import { isIP } from "node:net";
import * as path from "node:path";
import {
	assertProjectDeletable,
	authorizeInboxAccess,
	createProject,
	deleteProject,
	getProject,
	heartbeat,
	joinProject,
	leaveProject,
	listMembers,
	listProjects,
	readMember,
	RegistryConflictError,
	RegistryOperationError,
} from "../registry";
import { AGENT_ID_RE } from "../types";
import {
	defaultDataDir,
	ensureDir,
	hubLockPath,
	hubMetaPath,
	hubPidPath,
	inboxDatabasePath,
	projectDeletionMarkerPath,
	projectDeletionMarkersDir,
	projectDir,
	projectsRoot,
} from "../paths";
import { HubDataLock, HubDataDirInUseError } from "./data-lock";
import {
	CausalParentError,
	InboxStore,
	MAX_ACK_BATCH_MESSAGES,
	MAX_INBOX_BATCH_MESSAGES,
	MessageIdConflictError,
	OutOfOrderAcknowledgmentError,
	UnknownMessageError,
} from "./inbox";
import { parseMessageRef } from "./message-ref";
import { decodeTextPayload, PayloadTooLargeError } from "./payload";
import type {
	HubMeta,
	HubRegisterBody,
	HubSendBody,
	HubWireMessageDraft,
} from "./types";

const DEFAULT_PORT = 4173;
const DEFAULT_INBOX_LIMIT = 500;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
class RecipientUnavailableError extends Error {}
class RequestValidationError extends Error {}


export type HubServerHandle = {
	meta: HubMeta;
	listenUrl: string;
	stop: () => Promise<void>;
};

export { HubDataDirInUseError };

function fsyncDirectory(directory: string): void {
	const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

function writeJsonAtomic(file: string, data: unknown): void {
	const directory = path.dirname(file);
	ensureDir(directory);
	const parent = path.dirname(directory);
	if (parent !== directory) fsyncDirectory(parent);
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const descriptor = fs.openSync(temporary, "wx", 0o600);
	try {
		fs.writeFileSync(descriptor, `${JSON.stringify(data, null, 2)}\n`);
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
	fs.renameSync(temporary, file);
	fsyncDirectory(directory);
}

type ProjectDeletionMarker = {
	project: string;
	startedAt: number;
};

function removeFileIfExists(file: string, durable = false): void {
	try {
		fs.unlinkSync(file);
		if (durable) fsyncDirectory(path.dirname(file));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

function removeRuntimeFilesBestEffort(dataDir: string): void {
	for (const file of [hubMetaPath(dataDir), hubPidPath(dataDir)]) {
		try {
			removeFileIfExists(file);
		} catch {
			// Resource ownership cleanup must continue through every step.
		}
	}
}

function pendingProjectDeletions(dataDir: string): ProjectDeletionMarker[] {
	const directory = projectDeletionMarkersDir(dataDir);
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
		const file = path.join(directory, entry.name);
		const marker = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProjectDeletionMarker>;
		if (
			typeof marker.project !== "string" ||
			!Number.isSafeInteger(marker.startedAt) ||
			entry.name !== `${marker.project}.json`
		) {
			throw new Error(`invalid Project deletion marker: ${file}`);
		}
		return [{ project: marker.project, startedAt: marker.startedAt! }];
	});
}

function removeProjectRegistryState(project: string, dataDir: string, existed: boolean): void {
	if (existed) {
		deleteProject(project, dataDir);
	} else {
		fs.rmSync(projectDir(project, dataDir), { recursive: true, force: true });
	}
	const root = projectsRoot(dataDir);
	if (fs.existsSync(root)) fsyncDirectory(root);
}

function deleteProjectRecoverably(
	project: string,
	dataDir: string,
	inboxes: InboxStore,
	blockedCreations: Set<string>,
): boolean {
	const existed = assertProjectDeletable(project, dataDir);
	const markerPath = projectDeletionMarkerPath(project, dataDir);
	writeJsonAtomic(markerPath, { project, startedAt: Date.now() } satisfies ProjectDeletionMarker);
	blockedCreations.add(project);
	removeProjectRegistryState(project, dataDir, existed);
	inboxes.deleteProject(project);
	removeFileIfExists(markerPath, true);
	blockedCreations.delete(project);
	return existed;
}

function reconcileProjectDeletions(dataDir: string, inboxes: InboxStore): void {
	for (const marker of pendingProjectDeletions(dataDir)) {
		const existed = assertProjectDeletable(marker.project, dataDir);
		removeProjectRegistryState(marker.project, dataDir, existed);
		inboxes.deleteProject(marker.project);
		removeFileIfExists(projectDeletionMarkerPath(marker.project, dataDir), true);
	}
}

async function closeListeningServer(server: Server, graceMs = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(forceClose);
			if (error) reject(error);
			else resolve();
		};
		const forceClose = setTimeout(() => {
			server.closeAllConnections();
			finish();
		}, graceMs);
		server.close((error) => finish(error ?? undefined));
	});
}

function requestFailureStatus(error: unknown): 400 | 500 {
	return error instanceof RequestValidationError || error instanceof RegistryOperationError ? 400 : 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRegistration(value: unknown): HubRegisterBody {
	if (!isRecord(value)) throw new RequestValidationError("invalid registration body");
	const { project, agentId, cwd, pid, caps, displayName, sessionId } = value;
	if (
		typeof project !== "string" ||
		typeof agentId !== "string" ||
		typeof cwd !== "string" ||
		!project ||
		!agentId ||
		!cwd.trim()
	) {
		throw new RequestValidationError("project, agentId, cwd required");
	}
	if (pid !== undefined && (!Number.isSafeInteger(pid) || (pid as number) < 0)) {
		throw new RequestValidationError("pid must be a non-negative safe integer");
	}
	if (
		caps !== undefined &&
		(!Array.isArray(caps) || !caps.every((cap) => typeof cap === "string" && cap.trim().length > 0))
	) {
		throw new RequestValidationError("caps must be an array of non-empty strings");
	}
	if (displayName !== undefined && typeof displayName !== "string") {
		throw new RequestValidationError("displayName must be a string");
	}
	if (sessionId !== undefined && typeof sessionId !== "string") {
		throw new RequestValidationError("sessionId must be a string");
	}
	return {
		project,
		agentId,
		cwd,
		pid: pid as number | undefined,
		caps: caps as string[] | undefined,
		displayName,
		sessionId,
	};
}

function parseInboxLimit(value: unknown, allowString = false): number {
	if (value === undefined) return DEFAULT_INBOX_LIMIT;
	const parsed =
		typeof value === "number"
			? value
			: allowString && typeof value === "string" && /^[1-9]\d*$/.test(value)
				? Number(value)
				: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_INBOX_BATCH_MESSAGES) {
		throw new RequestValidationError(`limit must be an integer between 1 and ${MAX_INBOX_BATCH_MESSAGES}`);
	}
	return parsed;
}

function validateSendBody(value: unknown): asserts value is HubSendBody {
	if (
		!isRecord(value) ||
		typeof value.project !== "string" ||
		typeof value.from !== "string" ||
		typeof value.to !== "string" ||
		!isRecord(value.payload)
	) {
		throw new RequestValidationError("project, from, to, payload required");
	}
	if (!AGENT_ID_RE.test(value.from)) throw new RequestValidationError("invalid sender agentId");
	if (!AGENT_ID_RE.test(value.to)) throw new RequestValidationError("invalid recipient agentId");
	const payload = value.payload;
	if (
		(payload.encoding !== "identity" && payload.encoding !== "gzip+base64") ||
		typeof payload.data !== "string" ||
		!Number.isSafeInteger(payload.uncompressedBytes) ||
		(payload.uncompressedBytes as number) < 0
	) {
		throw new RequestValidationError("invalid message payload");
	}
}

function requestedPort(value: number | undefined): number {
	const configured = value ?? DEFAULT_PORT;
	if (!Number.isInteger(configured) || configured < 0 || configured > 65_535) {
		throw new Error(`invalid Hub port: ${configured}`);
	}
	return configured;
}

function canonicalHost(host: string): string {
	const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (isIP(unwrapped) !== 6) return unwrapped.toLowerCase();
	const hostname = new URL(`http://[${unwrapped}]`).hostname;
	return hostname.slice(1, -1);
}

function formatUrlHost(host: string): string {
	const canonical = canonicalHost(host);
	return isIP(canonical) === 6 ? `[${canonical}]` : canonical;
}

function isWildcardHost(host: string): boolean {
	const canonical = canonicalHost(host);
	return canonical === "0.0.0.0" || canonical === "::";
}

function normalizePublicUrl(value: string): string {
	const normalized = value.trim().replace(/\/+$/, "");
	if (!normalized) throw new Error("Hub public URL cannot be empty");
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error(`invalid Hub public URL: ${value}`);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		!parsed.hostname ||
		isWildcardHost(parsed.hostname)
	) {
		throw new Error(`invalid Hub public URL: ${value}`);
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash || /[?#]/.test(normalized)) {
		throw new Error(`Hub public URL must not contain credentials, query, or fragment: ${value}`);
	}
	return parsed.toString().replace(/\/+$/, "");
}

function listenerUrl(host: string, port: number): string {
	const canonical = canonicalHost(host);
	const reachableHost = canonical === "0.0.0.0" ? "127.0.0.1" : canonical === "::" ? "::1" : canonical;
	return `http://${formatUrlHost(reachableHost)}:${port}`;
}

export async function startHubServer(opts?: {
	port?: number;
	host?: string;
	publicUrl?: string;
	dataDir?: string;
	shutdownGraceMs?: number;
}): Promise<HubServerHandle> {
	const port = requestedPort(opts?.port);
	const shutdownGraceMs = opts?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
	if (!Number.isFinite(shutdownGraceMs) || shutdownGraceMs < 0) {
		throw new Error(`invalid Hub shutdown grace period: ${shutdownGraceMs}`);
	}
	const host = (opts?.host ?? "127.0.0.1").trim() || "127.0.0.1";
	const configuredPublicUrl = opts?.publicUrl;
	if (isWildcardHost(host) && configuredPublicUrl === undefined) {
		throw new Error("Hub public URL is required when binding a wildcard host");
	}
	const configuredDataDir = opts?.dataDir;
	if (configuredDataDir !== undefined && configuredDataDir.trim().length === 0) {
		throw new Error("Hub data directory cannot be empty");
	}
	const dataDir = path.resolve(configuredDataDir ?? defaultDataDir());
	const dataLock = new HubDataLock(hubLockPath(dataDir), dataDir);
	let inboxes: InboxStore;
	try {
		inboxes = new InboxStore(inboxDatabasePath(dataDir));
		try {
			reconcileProjectDeletions(dataDir, inboxes);
		} catch (error) {
			inboxes.close();
			throw error;
		}
	} catch (error) {
		dataLock.close();
		throw error;
	}
	const app = express();
	app.use(express.json({ limit: "6mb" }));
	let meta: HubMeta;
	let listenUrl: string;
	const blockedProjectCreations = new Set<string>();

	app.get("/healthz", (_request, response) => response.json({ ok: true, service: "omp-a2a-hub", ...meta }));
	app.get("/v1/meta", (_request, response) => response.json(meta));
	app.get("/v1/projects", (_request, response) => {
		try {
			response.json({ projects: listProjects(dataDir) });
		} catch (error) {
			response.status(requestFailureStatus(error)).json({
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
	app.post("/v1/projects", (request, response) => {
		try {
			const body = request.body;
			if (!isRecord(body) || typeof body.name !== "string" || !body.name) {
				return void response.status(400).json({ error: "name required" });
			}
			for (const field of ["displayName", "description", "createdByCwd"] as const) {
				if (body[field] !== undefined && typeof body[field] !== "string") {
					return void response.status(400).json({ error: `${field} must be a string` });
				}
			}
			if (
				blockedProjectCreations.has(body.name) ||
				fs.existsSync(projectDeletionMarkerPath(body.name, dataDir))
			) {
				return void response.status(409).json({ error: `project deletion pending: ${body.name}` });
			}
			const project = createProject({ ...body, name: body.name, dataDir });
			response.status(201).json({ project });
		} catch (error) {
			const status = error instanceof RegistryConflictError ? 409 : requestFailureStatus(error);
			response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.delete("/v1/projects/:name", (request, response) => {
		try {
			const deleted = deleteProjectRecoverably(
				request.params.name,
				dataDir,
				inboxes,
				blockedProjectCreations,
			);
			response.json({ ok: true, deleted });
		} catch (error) {
			const status = error instanceof RegistryConflictError ? 409 : requestFailureStatus(error);
			response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/v1/register", (request, response) => {
		try {
			const body = parseRegistration(request.body);
			if (!getProject(body.project, dataDir)) {
				return void response.status(404).json({ error: `unknown project: ${body.project}` });
			}
			const { member, leaseId } = joinProject({ ...body, pid: body.pid ?? 0, dataDir });
			response.json({ member, hub: meta, leaseId });
		} catch (error) {
			const status = error instanceof RegistryConflictError ? 409 : requestFailureStatus(error);
			response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/v1/heartbeat", (request, response) => {
		try {
			const body = request.body;
			if (
				!isRecord(body) ||
				typeof body.project !== "string" ||
				typeof body.agentId !== "string" ||
				typeof body.leaseId !== "string" ||
				!body.project ||
				!body.agentId ||
				!body.leaseId
			) {
				return void response.status(400).json({ error: "project, agentId, leaseId required" });
			}
			response.json({ member: heartbeat(body.project, body.agentId, body.leaseId, dataDir) });
		} catch (error) {
			response.status(requestFailureStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/v1/unregister", (request, response) => {
		try {
			const body = request.body;
			if (
				!isRecord(body) ||
				typeof body.project !== "string" ||
				typeof body.agentId !== "string" ||
				typeof body.leaseId !== "string" ||
				!body.project ||
				!body.agentId ||
				!body.leaseId
			) {
				return void response.status(400).json({ error: "project, agentId, leaseId required" });
			}
			leaveProject(body.project, body.agentId, body.leaseId, dataDir);
			response.json({ ok: true });
		} catch (error) {
			response.status(requestFailureStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.get("/v1/members", (request, response) => {
		try {
			const project = String(request.query.project ?? "");
			if (!project) return void response.status(400).json({ error: "project required" });
			const all = request.query.all === "1" || request.query.all === "true";
			response.json({ members: listMembers({ project, all, dataDir }) });
		} catch (error) {
			response.status(requestFailureStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/v1/send", (request, response) => {
		try {
			const body = request.body;
			validateSendBody(body);
			if (body.from === body.to) return void response.status(400).json({ error: "cannot send to yourself" });
			try {
				if (decodeTextPayload(body.payload).trim().length === 0) {
					return void response.status(400).json({ error: "message text required" });
				}
			} catch (error) {
				if (error instanceof PayloadTooLargeError) throw error;
				throw new RequestValidationError(error instanceof Error ? error.message : String(error));
			}
			const messageId = body.messageId ?? crypto.randomUUID();
			if (
				typeof messageId !== "string" ||
				!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(messageId)
			) {
				return void response.status(400).json({ error: "invalid messageId" });
			}
			if (
				body.replyTo !== undefined &&
				(typeof body.replyTo !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(body.replyTo))
			) {
				return void response.status(400).json({ error: "invalid replyTo" });
			}
			if (
				body.replyToRef !== undefined &&
				(typeof body.replyToRef !== "string" || body.replyToRef.trim().length === 0)
			) {
				return void response.status(400).json({ error: "invalid replyToRef" });
			}
			if (body.replyToRef !== undefined) {
				try {
					parseMessageRef(body.replyToRef);
				} catch (error) {
					throw new RequestValidationError(error instanceof Error ? error.message : String(error));
				}
			}
			const draft: HubWireMessageDraft = {
				kind: "message",
				msgId: messageId,
				project: body.project,
				from: body.from,
				to: body.to,
				payload: body.payload,
				createdAt: Date.now(),
				replyTo: body.replyTo,
				replyToRef: body.replyToRef,
			};
			const message = inboxes.enqueue(draft, () => {
				const recipient = readMember(body.project, body.to, dataDir);
				if (!recipient || recipient.status !== "online") {
					throw new RecipientUnavailableError(`peer ${body.to} is not online in ${body.project}`);
				}
			});
			response.json({ ok: true, message });
		} catch (error) {
			const status =
				error instanceof RecipientUnavailableError
					? 404
					: error instanceof MessageIdConflictError || error instanceof CausalParentError
						? 409
						: error instanceof PayloadTooLargeError
							? 413
							: requestFailureStatus(error);
			response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.get("/v1/inbox", (request, response) => {
		try {
			const project = String(request.query.project ?? "");
			const agentId = String(request.query.agentId ?? "");
			if (!project || !agentId) return void response.status(400).json({ error: "project and agentId required" });
			const leaseId = request.get("x-a2a-lease");
			authorizeInboxAccess(project, agentId, leaseId, dataDir);
			const limit = parseInboxLimit(request.query.limit, true);
			response.json(inboxes.read(project, agentId, limit));
		} catch (error) {
			response.status(requestFailureStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/v1/inbox/read", (request, response) => {
		try {
			const body = request.body;
			if (
				!isRecord(body) ||
				typeof body.project !== "string" ||
				typeof body.agentId !== "string" ||
				(body.leaseId !== undefined && typeof body.leaseId !== "string") ||
				!body.project ||
				!body.agentId
			) {
				return void response.status(400).json({ error: "project and agentId required" });
			}
			authorizeInboxAccess(body.project, body.agentId, body.leaseId, dataDir);
			const limit = parseInboxLimit(body.limit);
			response.json(inboxes.read(body.project, body.agentId, limit));
		} catch (error) {
			response.status(requestFailureStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/v1/inbox/ack", (request, response) => {
		try {
			const body = request.body;
			if (
				!isRecord(body) ||
				typeof body.project !== "string" ||
				typeof body.agentId !== "string" ||
				(body.leaseId !== undefined && typeof body.leaseId !== "string") ||
				!body.project ||
				!body.agentId ||
				!Array.isArray(body.messageIds)
			) {
				return void response.status(400).json({ error: "project, agentId, string messageIds required" });
			}
			if (body.messageIds.length > MAX_ACK_BATCH_MESSAGES) {
				return void response.status(413).json({
					error: `acknowledgment batch exceeds ${MAX_ACK_BATCH_MESSAGES} messages`,
				});
			}
			if (!body.messageIds.every((value): value is string => typeof value === "string")) {
				return void response.status(400).json({ error: "project, agentId, string messageIds required" });
			}
			authorizeInboxAccess(body.project, body.agentId, body.leaseId, dataDir);
			const result = inboxes.acknowledge(body.project, body.agentId, body.messageIds);
			response.json({ ok: true, ...result });
		} catch (error) {
			const status =
				error instanceof UnknownMessageError
					? 404
					: error instanceof OutOfOrderAcknowledgmentError
						? 409
						: requestFailureStatus(error);
			response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	let server: Server;
	try {
		server = await new Promise<Server>((resolve, reject) => {
			const listening = app.listen(port, host, () => resolve(listening));
			listening.once("error", reject);
		});
	} catch (error) {
		dataLock.close();
		inboxes.close();
		throw error;
	}

	try {
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Hub did not expose a TCP address");
		}
		const actualPort = address.port;
		listenUrl = listenerUrl(host, actualPort);
		const baseUrl =
			configuredPublicUrl === undefined
				? normalizePublicUrl(`http://${formatUrlHost(host)}:${actualPort}`)
				: normalizePublicUrl(configuredPublicUrl);
		meta = { pid: process.pid, port: actualPort, baseUrl, dataDir, startedAt: Date.now() };
		writeJsonAtomic(hubMetaPath(dataDir), meta);
		fs.writeFileSync(hubPidPath(dataDir), `${process.pid}\n`, { mode: 0o600 });
	} catch (error) {
		await closeListeningServer(server).catch(() => undefined);
		try {
			inboxes.close();
		} finally {
			removeRuntimeFilesBestEffort(dataDir);
			dataLock.close();
		}
		throw error;
	}

	let stopped = false;
	return {
		meta,
		listenUrl,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			try {
				await closeListeningServer(server, shutdownGraceMs);
				inboxes.close();
				removeFileIfExists(hubMetaPath(dataDir));
				removeFileIfExists(hubPidPath(dataDir));
			} finally {
				dataLock.close();
			}
		},
	};
}
