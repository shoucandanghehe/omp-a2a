import express from "express";
import * as fs from "node:fs";
import type { Server } from "node:http";
import { isIP } from "node:net";
import * as path from "node:path";
import {
	defaultDataDir,
	hubLockPath,
	hubMetaPath,
	hubPidPath,
	inboxDatabasePath,
	messageDatabasePath,
	projectDeletionMarkerPath,
	projectDeletionMarkersDir,
	projectDir,
	projectsRoot,
} from "../paths";
import {
	createProject,
	getProject,
	listProjects,
	RegistryConflictError,
	RegistryOperationError,
} from "../registry";
import { AGENT_NAME_RE, PROJECT_NAME_RE } from "../types";
import { HubDataDirInUseError, HubDataLock } from "./data-lock";
import { MessageStore, parseMessageRef } from "./messages";
import { RealtimeHub } from "./realtime-server";
import { A2A_PROTOCOL_VERSION } from "./realtime-types";
import type { HubMeta } from "./types";

const DEFAULT_PORT = 4173;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;


const PROJECT_CREATE_FIELDS: Record<string, true> = {
	name: true,
	displayName: true,
	description: true,
	createdByCwd: true,
};
class RequestValidationError extends Error {}

type ProjectDeletionMarker = {
	project: string;
	startedAt: number;
};

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

function ensureDirDurable(directory: string): void {
	if (fs.existsSync(directory)) return;
	const parent = path.dirname(directory);
	if (parent !== directory) ensureDirDurable(parent);
	try {
		fs.mkdirSync(directory);
		if (parent !== directory) fsyncDirectory(parent);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
			throw error;
	}
}

function writeJsonAtomic(file: string, data: unknown): void {
	const directory = path.dirname(file);
	ensureDirDurable(directory);
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

function writeTextDurable(file: string, value: string): void {
	const directory = path.dirname(file);
	ensureDirDurable(directory);
	const descriptor = fs.openSync(file, "w", 0o600);
	try {
		fs.writeFileSync(descriptor, value);
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
	fsyncDirectory(directory);
}

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
			fs.rmSync(file, { recursive: true, force: true });
			const directory = path.dirname(file);
			if (fs.existsSync(directory)) fsyncDirectory(directory);
		} catch {
			// Continue releasing resources even when a runtime path cannot be removed.
		}
	}
}

function pendingProjectDeletions(dataDir: string): ProjectDeletionMarker[] {
	const directory = projectDeletionMarkersDir(dataDir);
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
		const file = path.join(directory, entry.name);
		const marker = JSON.parse(
			fs.readFileSync(file, "utf8"),
		) as Partial<ProjectDeletionMarker>;
		if (
			typeof marker.project !== "string" ||
			!PROJECT_NAME_RE.test(marker.project) ||
			!Number.isSafeInteger(marker.startedAt) ||
			entry.name !== `${marker.project}.json`
		) {
			throw new Error(`invalid Project deletion marker: ${file}`);
		}
		return [{ project: marker.project, startedAt: marker.startedAt! }];
	});
}

function removeProjectRegistryState(project: string, dataDir: string): void {
	fs.rmSync(projectDir(project, dataDir), { recursive: true, force: true });
	const root = projectsRoot(dataDir);
	if (fs.existsSync(root)) fsyncDirectory(root);
}

function deleteProjectRecoverably(
	project: string,
	dataDir: string,
	messages: MessageStore,
	realtime: RealtimeHub | null,
	blockedCreations: Set<string>,
): boolean {
	const existed = getProject(project, dataDir) !== null;
	if (realtime?.count(project)) {
		throw new RegistryConflictError(
			`project has active Presences: ${project}`,
		);
	}
	const markerPath = projectDeletionMarkerPath(project, dataDir);
	writeJsonAtomic(markerPath, {
		project,
		startedAt: Date.now(),
	} satisfies ProjectDeletionMarker);
	blockedCreations.add(project);
	removeProjectRegistryState(project, dataDir);
	messages.deleteProject(project);
	removeFileIfExists(markerPath, true);
	blockedCreations.delete(project);
	return existed;
}

function reconcileProjectDeletions(
	dataDir: string,
	messages: MessageStore,
): void {
	for (const marker of pendingProjectDeletions(dataDir)) {
		removeProjectRegistryState(marker.project, dataDir);
		messages.deleteProject(marker.project);
		removeFileIfExists(
			projectDeletionMarkerPath(marker.project, dataDir),
			true,
		);
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
	const unwrapped =
		host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
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
	if (
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		/[?#]/.test(normalized)
	) {
		throw new Error(
			`Hub public URL must not contain credentials, query, or fragment: ${value}`,
		);
	}
	return parsed.toString().replace(/\/+$/, "");
}

function listenerUrl(host: string, port: number): string {
	const canonical = canonicalHost(host);
	const reachableHost =
		canonical === "0.0.0.0"
			? "127.0.0.1"
			: canonical === "::"
				? "::1"
				: canonical;
	return `http://${formatUrlHost(reachableHost)}:${port}`;
}

function requestFailureStatus(error: unknown): 400 | 500 {
	return error instanceof RequestValidationError ||
		error instanceof RegistryOperationError
		? 400
		: 500;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type ProjectCreateRecord = Record<string, unknown>;

function parseProjectCreateBody(value: unknown): {
	name: string;
	displayName?: string;
	description?: string;
	createdByCwd?: string;
} {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RequestValidationError("invalid Project create body");
	}
	const body = value as ProjectCreateRecord;
	const unknown = Object.keys(body).find(
		(field) => PROJECT_CREATE_FIELDS[field] !== true,
	);
	if (unknown)
		throw new RequestValidationError(`unknown Project field: ${unknown}`);
	if (typeof body.name !== "string" || !body.name)
		throw new RequestValidationError("name required");
	if (!PROJECT_NAME_RE.test(body.name)) {
		throw new RequestValidationError(
			`invalid project name "${body.name}" (use [a-zA-Z0-9._-], start alnum, max 64)`,
		);
	}
	for (const field of ["displayName", "description", "createdByCwd"] as const) {
		if (body[field] !== undefined && typeof body[field] !== "string") {
			throw new RequestValidationError(`${field} must be a string`);
		}
	}
	return {
		name: body.name,
		displayName: body.displayName as string | undefined,
		description: body.description as string | undefined,
		createdByCwd: body.createdByCwd as string | undefined,
	};
}

function parseHistoryLimit(value: unknown): number {
	if (value === undefined) return DEFAULT_HISTORY_LIMIT;
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
		throw new RequestValidationError(
			`limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`,
		);
	}
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit > MAX_HISTORY_LIMIT) {
		throw new RequestValidationError(
			`limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`,
		);
	}
	return limit;
}

function optionalQueryString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string")
		throw new RequestValidationError(`${field} must be a string`);
	return value;
}

async function closeListeningServer(server: Server): Promise<void> {
	server.closeIdleConnections();
	server.closeAllConnections();
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

export async function startHubServer(options?: {
	port?: number;
	host?: string;
	publicUrl?: string;
	dataDir?: string;
}): Promise<HubServerHandle> {
	const port = requestedPort(options?.port);
	const host = (options?.host ?? "127.0.0.1").trim() || "127.0.0.1";
	const publicUrl =
		options?.publicUrl === undefined
			? undefined
			: normalizePublicUrl(options.publicUrl);
	if (isWildcardHost(host) && publicUrl === undefined) {
		throw new Error("Hub public URL is required when binding a wildcard host");
	}
	if (options?.dataDir !== undefined && options.dataDir.trim().length === 0) {
		throw new Error("Hub data directory cannot be empty");
	}
	const dataDir = path.resolve(options?.dataDir ?? defaultDataDir());
	const dataLock = new HubDataLock(hubLockPath(dataDir), dataDir);
	let messages: MessageStore;
	try {
		const openedMessages = new MessageStore(messageDatabasePath(dataDir), {
			legacyDatabasePath: inboxDatabasePath(dataDir),
		});
		try {
			reconcileProjectDeletions(dataDir, openedMessages);
			messages = openedMessages;
		} catch (error) {
			openedMessages.close();
			throw error;
		}
	} catch (error) {
		dataLock.close();
		throw error;
	}

	const app = express();
	app.use(express.json({ limit: "6mb" }));
	let meta!: HubMeta;
	let realtime: RealtimeHub | null = null;
	const blockedProjectCreations = new Set<string>();

	app.get("/healthz", (_request, response) =>
		response.json({ ok: true, service: "omp-a2a-hub", ...meta }),
	);
	app.get("/v1/meta", (_request, response) => response.json(meta));
	app.get("/v1/projects", (_request, response) => {
		try {
			response.json({ projects: listProjects(dataDir) });
		} catch (error) {
			response.status(requestFailureStatus(error)).json({
				error: errorMessage(error),
			});
		}
	});
	app.post("/v1/projects", (request, response) => {
		try {
			const body = parseProjectCreateBody(request.body);
			if (
				blockedProjectCreations.has(body.name) ||
				fs.existsSync(projectDeletionMarkerPath(body.name, dataDir))
			) {
				return void response
					.status(409)
					.json({ error: `project deletion pending: ${body.name}` });
			}
			response.status(201).json({
				project: createProject({ ...body, dataDir }),
			});
		} catch (error) {
			const status =
				error instanceof RegistryConflictError
					? 409
					: requestFailureStatus(error);
			response.status(status).json({ error: errorMessage(error) });
		}
	});
	app.delete("/v1/projects/:name", (request, response) => {
		try {
			const deleted = deleteProjectRecoverably(
				request.params.name,
				dataDir,
				messages,
				realtime,
				blockedProjectCreations,
			);
			response.json({ ok: true, deleted });
		} catch (error) {
			const status =
				error instanceof RegistryConflictError
					? 409
					: requestFailureStatus(error);
			response.status(status).json({ error: errorMessage(error) });
		}
	});
	app.get("/v1/history", (request, response) => {
		try {
			const unknown = Object.keys(request.query).find(
				(key) =>
					key !== "project" &&
					key !== "before" &&
					key !== "after" &&
					key !== "from" &&
					key !== "limit",
			);
			if (unknown)
				throw new RequestValidationError(
					`unknown history query parameter: ${unknown}`,
				);
			const project = optionalQueryString(request.query.project, "project") ?? "";
			if (!project)
				return void response.status(400).json({ error: "project required" });
			if (!getProject(project, dataDir)) {
				return void response
					.status(404)
					.json({ error: `unknown project: ${project}` });
			}
			const before = optionalQueryString(request.query.before, "before");
			const after = optionalQueryString(request.query.after, "after");
			const from = optionalQueryString(request.query.from, "from");
			if (before !== undefined && after !== undefined) {
				throw new RequestValidationError(
					"history accepts before or after, not both",
				);
			}
			for (const cursor of [before, after]) {
				if (cursor === undefined) continue;
				let cursorProject: string;
				try {
					cursorProject = parseMessageRef(cursor).project;
				} catch (error) {
					throw new RequestValidationError(errorMessage(error));
				}
				if (cursorProject !== project) {
					throw new RequestValidationError(
						"history cursor belongs to another project",
					);
				}
			}
			if (from !== undefined && !AGENT_NAME_RE.test(from)) {
				throw new RequestValidationError(`invalid name: ${from}`);
			}
			response.json(
				messages.history({
					project,
					before,
					after,
					from,
					limit: parseHistoryLimit(request.query.limit),
				}),
			);
		} catch (error) {
			response.status(requestFailureStatus(error)).json({
				error: errorMessage(error),
			});
		}
	});

	app.use(
		(error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
			const candidate =
				typeof error === "object" &&
				error !== null &&
				"status" in error &&
				typeof error.status === "number"
					? error.status
					: 500;
			const status = candidate >= 400 && candidate < 500 ? candidate : 500;
			response.status(status).json({ error: errorMessage(error) });
		},
	);

	let server: Server;
	try {
		server = await new Promise<Server>((resolve, reject) => {
			const listening = app.listen(port, host, () => resolve(listening));
			listening.once("error", reject);
		});
	} catch (error) {
		try {
			messages.close();
		} finally {
			dataLock.close();
		}
		throw error;
	}

	let listenUrl: string;
	try {
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Hub did not expose a TCP address");
		}
		const actualPort = address.port;
		listenUrl = listenerUrl(host, actualPort);
		meta = {
			pid: process.pid,
			port: actualPort,
			baseUrl:
				publicUrl ??
				normalizePublicUrl(`http://${formatUrlHost(host)}:${actualPort}`),
			dataDir,
			startedAt: Date.now(),
			protocolVersion: A2A_PROTOCOL_VERSION,
		};
		realtime = new RealtimeHub(server, messages, dataDir);
		writeJsonAtomic(hubMetaPath(dataDir), meta);
		writeTextDurable(hubPidPath(dataDir), `${process.pid}\n`);
	} catch (error) {
		try {
			await realtime?.close();
		} catch {
			// Continue unwinding every resource acquired during startup.
		}
		try {
			await closeListeningServer(server);
		} catch {
			// Continue unwinding every resource acquired during startup.
		}
		try {
			messages.close();
		} catch {
			// Continue unwinding every resource acquired during startup.
		}
		removeRuntimeFilesBestEffort(dataDir);
		try {
			dataLock.close();
		} catch {
			// Preserve the startup failure after attempting lock release.
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
			let failure: unknown;
			try {
				await realtime?.close();
			} catch (error) {
				failure = error;
			}
			try {
				await closeListeningServer(server);
			} catch (error) {
				failure ??= error;
			}
			try {
				messages.close();
			} catch (error) {
				failure ??= error;
			}
			try {
				removeFileIfExists(hubMetaPath(dataDir), true);
				removeFileIfExists(hubPidPath(dataDir), true);
			} catch (error) {
				failure ??= error;
			}
			try {
				dataLock.close();
			} catch (error) {
				failure ??= error;
			}
			if (failure) throw failure;
		},
	};
}
