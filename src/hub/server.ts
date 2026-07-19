import express from "express";
import * as fs from "node:fs";
import type { Server } from "node:http";
import * as path from "node:path";
import {
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
} from "../registry";
import {
	defaultDataDir,
	ensureDir,
	hubLockPath,
	hubMetaPath,
	hubPidPath,
	inboxDatabasePath,
} from "../paths";
import { HubDataLock, HubDataDirInUseError } from "./data-lock";
import {
	CausalParentError,
	InboxStore,
	MessageIdConflictError,
	OutOfOrderAcknowledgmentError,
	UnknownMessageError,
} from "./inbox";
import { decodeTextPayload, PayloadTooLargeError } from "./payload";
import type { HubMeta, HubRegisterBody, HubSendBody, HubWireMessageDraft } from "./types";

const DEFAULT_PORT = 4173;
class RecipientUnavailableError extends Error {}


export type HubServerHandle = {
	meta: HubMeta;
	stop: () => Promise<void>;
};

export { HubDataDirInUseError };

function writeJsonAtomic(file: string, data: unknown): void {
	ensureDir(path.dirname(file));
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

function requestedPort(value: number | undefined): number {
	const configured = value ?? (process.env.OMP_A2A_HUB_PORT ? Number(process.env.OMP_A2A_HUB_PORT) : DEFAULT_PORT);
	if (!Number.isInteger(configured) || configured < 0 || configured > 65_535) {
		throw new Error(`invalid Hub port: ${configured}`);
	}
	return configured;
}

export async function startHubServer(opts?: {
	port?: number;
	host?: string;
	publicUrl?: string;
	dataDir?: string;
}): Promise<HubServerHandle> {
	const port = requestedPort(opts?.port);
	const host = (opts?.host ?? process.env.OMP_A2A_HUB_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
	const dataDir = path.resolve(opts?.dataDir ?? process.env.OMP_A2A_HUB_DATA_DIR ?? defaultDataDir());
	const dataLock = new HubDataLock(hubLockPath(dataDir), dataDir);
	let inboxes: InboxStore;
	try {
		inboxes = new InboxStore(inboxDatabasePath(dataDir));
	} catch (error) {
		dataLock.close();
		throw error;
	}
	const app = express();
	app.use(express.json({ limit: "6mb" }));
	let meta: HubMeta;

	app.get("/healthz", (_request, response) => response.json({ ok: true, service: "omp-a2a-hub", ...meta }));
	app.get("/v1/meta", (_request, response) => response.json(meta));
	app.get("/v1/projects", (_request, response) => response.json({ projects: listProjects(dataDir) }));
	app.post("/v1/projects", (request, response) => {
		try {
			const body = request.body as {
				name?: string;
				displayName?: string;
				description?: string;
				createdByCwd?: string;
			};
			if (!body.name) return void response.status(400).json({ error: "name required" });
			const project = createProject({ ...body, name: body.name, dataDir });
			response.status(201).json({ project });
		} catch (error) {
			const status = error instanceof RegistryConflictError ? 409 : 400;
			response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.delete("/v1/projects/:name", (request, response) => {
		try {
			const deleted = deleteProject(request.params.name, dataDir);
			inboxes.deleteProject(request.params.name);
			response.json({ ok: true, deleted });
		} catch (error) {
			const status = error instanceof RegistryConflictError ? 409 : 400;
			response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/v1/register", (request, response) => {
		try {
			const body = request.body as HubRegisterBody;
			if (!body.project || !body.agentId || !body.cwd) {
				return void response.status(400).json({ error: "project, agentId, cwd required" });
			}
			if (!getProject(body.project, dataDir)) {
				return void response.status(404).json({ error: `unknown project: ${body.project}` });
			}
			const member = joinProject({ ...body, pid: body.pid ?? 0, dataDir });
			response.json({ member, hub: meta });
		} catch (error) {
			const status = error instanceof RegistryConflictError ? 409 : 400;
			response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/v1/heartbeat", (request, response) => {
		try {
			const body = request.body as { project?: string; agentId?: string };
			if (!body.project || !body.agentId) {
				return void response.status(400).json({ error: "project and agentId required" });
			}
			response.json({ member: heartbeat(body.project, body.agentId, dataDir) });
		} catch (error) {
			response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/v1/unregister", (request, response) => {
		try {
			const body = request.body as { project?: string; agentId?: string };
			if (!body.project || !body.agentId) {
				return void response.status(400).json({ error: "project and agentId required" });
			}
			leaveProject(body.project, body.agentId, dataDir);
			response.json({ ok: true });
		} catch (error) {
			response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.get("/v1/members", (request, response) => {
		try {
			const project = String(request.query.project ?? "");
			if (!project) return void response.status(400).json({ error: "project required" });
			const all = request.query.all === "1" || request.query.all === "true";
			response.json({ members: listMembers({ project, all, dataDir }) });
		} catch (error) {
			response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/v1/send", (request, response) => {
		try {
			const body = request.body as HubSendBody;
			if (!body.project || !body.from || !body.to || !body.payload) {
				return void response.status(400).json({ error: "project, from, to, payload required" });
			}
			if (body.from === body.to) return void response.status(400).json({ error: "cannot send to yourself" });
			if (decodeTextPayload(body.payload).trim().length === 0) {
				return void response.status(400).json({ error: "message text required" });
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
			const draft: HubWireMessageDraft = {
				kind: "message",
				msgId: messageId,
				project: body.project,
				from: body.from,
				to: body.to,
				payload: body.payload,
				createdAt: Date.now(),
				replyTo: body.replyTo,
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
							: 400;
			response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.get("/v1/inbox", (request, response) => {
		const project = String(request.query.project ?? "");
		const agentId = String(request.query.agentId ?? "");
		if (!project || !agentId) return void response.status(400).json({ error: "project and agentId required" });
		const limit = Math.min(Math.max(Number(request.query.limit) || 500, 1), 1_000);
		response.json(inboxes.read(project, agentId, limit));
	});

	app.post("/v1/inbox/read", (request, response) => {
		const body = request.body as { project?: string; agentId?: string; limit?: number };
		if (!body.project || !body.agentId) {
			return void response.status(400).json({ error: "project and agentId required" });
		}
		const limit = Math.min(Math.max(Number(body.limit) || 500, 1), 1_000);
		response.json(inboxes.read(body.project, body.agentId, limit));
	});

	app.post("/v1/inbox/ack", (request, response) => {
		try {
			const body = request.body as { project?: string; agentId?: string; messageIds?: unknown };
			if (
				!body.project ||
				!body.agentId ||
				!Array.isArray(body.messageIds) ||
				!body.messageIds.every((value): value is string => typeof value === "string")
			) {
				return void response.status(400).json({ error: "project, agentId, string messageIds required" });
			}
			const result = inboxes.acknowledge(body.project, body.agentId, body.messageIds);
			response.json({ ok: true, ...result });
		} catch (error) {
			const status =
				error instanceof UnknownMessageError
					? 404
					: error instanceof OutOfOrderAcknowledgmentError
						? 409
						: 400;
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

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		dataLock.close();
		inboxes.close();
		throw new Error("Hub did not expose a TCP address");
	}
	const actualPort = address.port;
	const baseUrl = (opts?.publicUrl ?? process.env.OMP_A2A_HUB_PUBLIC_URL ?? `http://127.0.0.1:${actualPort}`)
		.trim()
		.replace(/\/+$/, "");
	meta = { pid: process.pid, port: actualPort, baseUrl, dataDir, startedAt: Date.now() };
	writeJsonAtomic(hubMetaPath(dataDir), meta);
	fs.writeFileSync(hubPidPath(dataDir), `${process.pid}\n`, { mode: 0o600 });

	let stopped = false;
	return {
		meta,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			try {
				if (server.listening) {
					await new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					);
				}
			} finally {
				inboxes.close();
				fs.rmSync(hubMetaPath(dataDir), { force: true });
				fs.rmSync(hubPidPath(dataDir), { force: true });
				dataLock.close();
			}
		},
	};
}
