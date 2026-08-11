import * as fs from "node:fs";
import type { Server } from "node:http";
import * as path from "node:path";
import express from "express";
import {
	defaultDataDir,
	ensureDir,
	hubLockPath,
	hubMetaPath,
	hubPidPath,
	messageDatabasePath,
} from "../paths";
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
	RegistryConflictError,
} from "../registry";
import { HubDataDirInUseError, HubDataLock } from "./data-lock";
import { MessageStore } from "./messages";
import { RealtimeHub } from "./realtime-server";
import { A2A_PROTOCOL_VERSION } from "./realtime-types";
import type { HubMeta } from "./types";

const DEFAULT_PORT = 4173;

export type HubServerHandle = {
	meta: HubMeta;
	stop: () => Promise<void>;
};

export { HubDataDirInUseError };

function writeJsonAtomic(file: string, data: unknown): void {
	ensureDir(path.dirname(file));
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
		mode: 0o600,
	});
	fs.renameSync(temporary, file);
}

function requestedPort(value: number | undefined): number {
	const configured =
		value ??
		(process.env.OMP_A2A_HUB_PORT
			? Number(process.env.OMP_A2A_HUB_PORT)
			: DEFAULT_PORT);
	if (!Number.isInteger(configured) || configured < 0 || configured > 65_535) {
		throw new Error(`invalid Hub port: ${configured}`);
	}
	return configured;
}

export async function startHubServer(options?: {
	port?: number;
	host?: string;
	publicUrl?: string;
	dataDir?: string;
}): Promise<HubServerHandle> {
	const port = requestedPort(options?.port);
	const host =
		(options?.host ?? process.env.OMP_A2A_HUB_HOST ?? "127.0.0.1").trim() ||
		"127.0.0.1";
	const dataDir = path.resolve(
		options?.dataDir ?? process.env.OMP_A2A_HUB_DATA_DIR ?? defaultDataDir(),
	);
	const dataLock = new HubDataLock(hubLockPath(dataDir), dataDir);
	let messages: MessageStore;
	try {
		messages = new MessageStore(messageDatabasePath(dataDir));
	} catch (error) {
		dataLock.close();
		throw error;
	}

	const app = express();
	app.use(express.json({ limit: "6mb" }));
	let meta: HubMeta;
	let realtime: RealtimeHub | null = null;

	app.get("/healthz", (_request, response) =>
		response.json({ ok: true, service: "omp-a2a-hub", ...meta }),
	);
	app.get("/v1/meta", (_request, response) => response.json(meta));
	app.get("/v1/projects", (_request, response) =>
		response.json({ projects: listProjects(dataDir) }),
	);
	app.post("/v1/projects", (request, response) => {
		try {
			const body = request.body as {
				name?: string;
				displayName?: string;
				description?: string;
				createdByCwd?: string;
			};
			if (!body.name)
				return void response.status(400).json({ error: "name required" });
			response.status(201).json({
				project: createProject({ ...body, name: body.name, dataDir }),
			});
		} catch (error) {
			response.status(error instanceof RegistryConflictError ? 409 : 400).json({
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
	app.delete("/v1/projects/:name", (request, response) => {
		try {
			if (realtime?.count(request.params.name)) {
				throw new RegistryConflictError(
					`project has active Presences: ${request.params.name}`,
				);
			}
			const deleted = deleteProject(request.params.name, dataDir);
			if (deleted) messages.deleteProject(request.params.name);
			response.json({ ok: true, deleted });
		} catch (error) {
			response.status(error instanceof RegistryConflictError ? 409 : 400).json({
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
	app.get("/v1/history", (request, response) => {
		try {
			const project = String(request.query.project ?? "");
			if (!project)
				return void response.status(400).json({ error: "project required" });
			if (!getProject(project, dataDir))
				return void response
					.status(404)
					.json({ error: `unknown project: ${project}` });
			response.json(
				messages.history({
					project,
					before:
						request.query.before === undefined
							? undefined
							: String(request.query.before),
					after:
						request.query.after === undefined
							? undefined
							: String(request.query.after),
					from:
						request.query.from === undefined
							? undefined
							: String(request.query.from),
					limit:
						request.query.limit === undefined
							? undefined
							: Number(request.query.limit),
				}),
			);
		} catch (error) {
			response.status(400).json({
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	let server: Server;
	try {
		server = await new Promise<Server>((resolve, reject) => {
			const listening = app.listen(port, host, () => resolve(listening));
			listening.once("error", reject);
		});
	} catch (error) {
		messages.close();
		dataLock.close();
		throw error;
	}

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		messages.close();
		dataLock.close();
		throw new Error("Hub did not expose a TCP address");
	}
	const actualPort = address.port;
	const baseUrl = (
		options?.publicUrl ??
		process.env.OMP_A2A_HUB_PUBLIC_URL ??
		`http://127.0.0.1:${actualPort}`
	)
		.trim()
		.replace(/\/+$/, "");
	meta = {
		pid: process.pid,
		port: actualPort,
		baseUrl,
		dataDir,
		startedAt: Date.now(),
		protocolVersion: A2A_PROTOCOL_VERSION,
	};
	realtime = new RealtimeHub(server, messages, dataDir);
	writeJsonAtomic(hubMetaPath(dataDir), meta);
	fs.writeFileSync(hubPidPath(dataDir), `${process.pid}\n`, { mode: 0o600 });

	let stopped = false;
	return {
		meta,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			try {
				await realtime?.close();
				server.closeIdleConnections();
				server.closeAllConnections();
				if (server.listening) {
					await new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					);
				}
			} finally {
				messages.close();
				fs.rmSync(hubMetaPath(dataDir), { force: true });
				fs.rmSync(hubPidPath(dataDir), { force: true });
				dataLock.close();
			}
		},
	};
}
