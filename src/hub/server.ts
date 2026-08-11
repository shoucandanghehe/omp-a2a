import type { Server } from "node:http";
import * as path from "node:path";
import express from "express";
import { hubLockPath, hubStoreDatabasePath } from "../paths";
import { HubDataDirInUseError, HubDataLock } from "./data-lock";
import { RealtimeHub } from "./realtime-server";
import { A2A_PROTOCOL_VERSION } from "./realtime-types";
import { HubStore, ProjectConflictError } from "./store";

export type StartHubServerOptions = {
	host: string;
	port: number;
	dataDir: string;
};

export type HubServerHandle = {
	listenUrl: string;
	stop: () => Promise<void>;
};

export { HubDataDirInUseError };

function requestedPort(value: number): number {
	if (!Number.isInteger(value) || value < 0 || value > 65_535) {
		throw new Error(`invalid Hub port: ${value}`);
	}
	return value;
}

function listenUrlHost(host: string): string {
	if (host === "0.0.0.0") return "127.0.0.1";
	if (host === "::" || host === "0:0:0:0:0:0:0:0") return "[::1]";
	return host.includes(":") ? `[${host}]` : host;
}

export async function startHubServer(
	options: StartHubServerOptions,
): Promise<HubServerHandle> {
	const port = requestedPort(options.port);
	const host = options.host.trim();
	if (!host) throw new Error("Hub host must not be empty");
	const configuredDataDir = options.dataDir.trim();
	if (!configuredDataDir)
		throw new Error("Hub data directory must not be empty");
	const dataDir = path.resolve(configuredDataDir);
	let dataLock: HubDataLock | null = null;
	let store: HubStore | null = null;
	let server: Server | null = null;
	let realtime: RealtimeHub | null = null;
	let cleanupPromise: Promise<void> | null = null;
	const cleanup = (): Promise<void> => {
		if (cleanupPromise) return cleanupPromise;
		cleanupPromise = (async () => {
			const errors: unknown[] = [];
			const release = async (action: () => void | Promise<void>) => {
				try {
					await action();
				} catch (error) {
					if (errors.length === 0) errors.push(error);
				}
			};
			await release(async () => {
				await realtime?.close();
			});
			await release(() => server?.closeIdleConnections());
			await release(() => server?.closeAllConnections());
			await release(async () => {
				const listeningServer = server;
				if (!listeningServer?.listening) return;
				await new Promise<void>((resolve, reject) =>
					listeningServer.close((error) => (error ? reject(error) : resolve())),
				);
			});
			await release(() => store?.close());
			await release(() => dataLock?.close());
			if (errors.length > 0) throw errors[0];
		})();
		return cleanupPromise;
	};

	try {
		dataLock = new HubDataLock(hubLockPath(dataDir), dataDir);
		const hubStore = new HubStore(hubStoreDatabasePath(dataDir));
		store = hubStore;

		const app = express();
		app.use(express.json({ limit: Number.POSITIVE_INFINITY }));
		app.get("/healthz", (_request, response) =>
			response.json({ ok: true, service: "omp-a2a-hub" }),
		);
		app.get("/v1/meta", (_request, response) =>
			response.json({ protocolVersion: A2A_PROTOCOL_VERSION }),
		);
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
		const listenUrl = `http://${listenUrlHost(host)}:${address.port}`;
		realtime = new RealtimeHub(listeningServer, hubStore);
		return { listenUrl, stop: cleanup };
	} catch (error) {
		try {
			await cleanup();
		} catch {
			// The startup error happened first and remains authoritative.
		}
		throw error;
	}
}
