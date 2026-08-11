import type { Server } from "node:http";
import * as path from "node:path";
import express from "express";
import {
	hubLockPath,
	inboxDatabasePath,
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
	if (!configuredDataDir) throw new Error("Hub data directory must not be empty");
	const dataDir = path.resolve(configuredDataDir);
	const dataLock = new HubDataLock(hubLockPath(dataDir), dataDir);
	let messages: MessageStore;
	try {
		messages = new MessageStore(messageDatabasePath(dataDir), {
			legacyDatabasePath: inboxDatabasePath(dataDir),
		});
	} catch (error) {
		dataLock.close();
		throw error;
	}

	const app = express();
	app.use(express.json({ limit: "6mb" }));
	const meta: HubMeta = { protocolVersion: A2A_PROTOCOL_VERSION };
	let realtime: RealtimeHub | null = null;

	app.get("/healthz", (_request, response) =>
		response.json({ ok: true, service: "omp-a2a-hub" }),
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
		const ready = Promise.withResolvers<void>();
		const listening = app.listen(port, host, ready.resolve);
		listening.once("error", ready.reject);
		await ready.promise;
		server = listening;
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
	const listenUrl = `http://${listenUrlHost(host)}:${address.port}`;
	realtime = new RealtimeHub(server, messages, dataDir);

	let stopPromise: Promise<void> | undefined;
	return {
		listenUrl,
		stop: () => {
			stopPromise ??= (async () => {
				try {
					await realtime?.close();
					server.closeIdleConnections();
					server.closeAllConnections();
					if (server.listening) {
						const closed = Promise.withResolvers<void>();
						server.close((error) =>
							error ? closed.reject(error) : closed.resolve(),
						);
						await closed.promise;
					}
				} finally {
					messages.close();
					dataLock.close();
				}
			})();
			return stopPromise;
		},
	};
}
