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
	hubStoreDatabasePath,
	inboxDatabasePath,
} from "../paths";
import { HubDataDirInUseError, HubDataLock } from "./data-lock";
import { RealtimeHub } from "./realtime-server";
import { HubStore, ProjectConflictError } from "./store";
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
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
			mode: 0o600,
		});
		fs.renameSync(temporary, file);
	} catch (error) {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {
			// The write or rename failure happened first.
		}
		throw error;
	}
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
	let dataLock: HubDataLock | null = null;
	let store: HubStore | null = null;
	let server: Server | null = null;
	let realtime: RealtimeHub | null = null;
	let cleanupPromise: Promise<void> | null = null;
	const cleanup = (): Promise<void> => {
		if (cleanupPromise) return cleanupPromise;
		cleanupPromise = (async () => {
			let firstError: { value: unknown } | null = null;
			const release = async (action: () => void | Promise<void>) => {
				try {
					await action();
				} catch (error) {
					firstError ??= { value: error };
				}
			};
			await release(() => {
				if (dataLock) fs.rmSync(hubPidPath(dataDir), { force: true });
			});
			await release(() => {
				if (dataLock) fs.rmSync(hubMetaPath(dataDir), { force: true });
			});
			await release(async () => {
				await realtime?.close();
			});
			await release(() => server?.closeIdleConnections());
			await release(() => server?.closeAllConnections());
			await release(async () => {
				const listeningServer = server;
				if (!listeningServer?.listening) return;
				await new Promise<void>((resolve, reject) =>
					listeningServer.close((error) =>
						error ? reject(error) : resolve(),
					),
				);
			});
			await release(() => store?.close());
			await release(() => dataLock?.close());
			if (firstError) throw firstError.value;
		})();
		return cleanupPromise;
	};

	try {
		dataLock = new HubDataLock(hubLockPath(dataDir), dataDir);
		const hubStore = new HubStore(hubStoreDatabasePath(dataDir), {
			legacyDatabasePath: inboxDatabasePath(dataDir),
		});
		store = hubStore;

		const app = express();
		app.use(express.json({ limit: "6mb" }));
		let meta: HubMeta;

		app.get("/healthz", (_request, response) =>
			response.json({ ok: true, service: "omp-a2a-hub", ...meta }),
		);
		app.get("/v1/meta", (_request, response) => response.json(meta));
		app.get("/v1/projects", (_request, response) =>
			response.json({ projects: hubStore.listProjects() }),
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
					project: hubStore.createProject({ ...body, name: body.name }),
				});
			} catch (error) {
				response
					.status(error instanceof ProjectConflictError ? 409 : 400)
					.json({
						error: error instanceof Error ? error.message : String(error),
					});
			}
		});
		app.delete("/v1/projects/:name", (request, response) => {
			try {
				if (realtime?.count(request.params.name)) {
					throw new ProjectConflictError(
						`project has active Presences: ${request.params.name}`,
					);
				}
				response.json({
					ok: true,
					deleted: hubStore.deleteProject(request.params.name),
				});
			} catch (error) {
				response
					.status(error instanceof ProjectConflictError ? 409 : 400)
					.json({
						error: error instanceof Error ? error.message : String(error),
					});
			}
		});
		app.get("/v1/history", (request, response) => {
			try {
				const project = String(request.query.project ?? "");
				if (!project)
					return void response.status(400).json({ error: "project required" });
				if (!hubStore.getProject(project))
					return void response
						.status(404)
						.json({ error: `unknown project: ${project}` });
				response.json(
					hubStore.history({
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

		const listeningServer = await new Promise<Server>((resolve, reject) => {
			const listening = app.listen(port, host, () => resolve(listening));
			server = listening;
			listening.once("error", reject);
		});
		server = listeningServer;
		const address = listeningServer.address();
		if (!address || typeof address === "string") {
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
		realtime = new RealtimeHub(listeningServer, hubStore);
		writeJsonAtomic(hubMetaPath(dataDir), meta);
		fs.writeFileSync(hubPidPath(dataDir), `${process.pid}\n`, { mode: 0o600 });

		return { meta, stop: cleanup };
	} catch (error) {
		try {
			await cleanup();
		} catch {
			// The startup error happened first and remains authoritative.
		}
		throw error;
	}
}
