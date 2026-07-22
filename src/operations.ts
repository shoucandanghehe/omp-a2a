import type { HubClient } from "./hub/client";
import type { HubEnvelope, HubMeta } from "./hub/types";
import type { A2aMember } from "./types";
export const ASYNC_REPLY_GUIDANCE =
	"Inbound messages and replies are injected automatically. " +
	"Never wait, sleep, or poll inbox for a reply after send. " +
	"Continue independent work; if blocked, end the current turn—the reply will trigger a future turn. " +
	"Use inbox only for one-off inspection or recovery.";

export type A2aMembership = { project: string; agentId: string; hubBaseUrl: string };

export type A2aOperationRequest = {
	action:
		| "hub"
		| "project_create"
		| "project_delete"
		| "project_list"
		| "join"
		| "leave"
		| "list"
		| "status"
		| "send"
		| "inbox";
	project?: string;
	agentId?: string;
	to?: string;
	text?: string;
	messageId?: string;
	replyTo?: string;
	replyToRef?: string;
	caps?: string[];
	displayName?: string;
	description?: string;
	all?: boolean;
};

export type A2aOperationContext = {
	cwd: string;
	sessionId?: string;
};

export type A2aOperationResult = {
	text: string;
	details: Record<string, unknown>;
	membershipChanged?: "joined" | "left";
	cleanupPending?: boolean;
};

type A2aOperationsOptions = {
	getClient: () => Promise<HubClient>;
	pid?: number;
};

type BoundMembership = A2aMembership & {
	client: HubClient;
	leaseId: string;
};

function publicMembership(membership: BoundMembership): A2aMembership {
	return {
		project: membership.project,
		agentId: membership.agentId,
		hubBaseUrl: membership.hubBaseUrl,
	};
}

function formatMembers(members: A2aMember[]): string {
	if (members.length === 0) return "(no members)";
	return members
		.map((member) => {
			const caps = member.caps.length > 0 ? member.caps.join(",") : "-";
			return `- ${member.agentId}\t${member.status}\tpid=${member.pid}\tcwd=${member.cwd}\tcaps=${caps}`;
		})
		.join("\n");
}

export class A2aOperations {
	#getClient: () => Promise<HubClient>;
	#pid: number;
	#membership: BoundMembership | null = null;

	constructor(options: A2aOperationsOptions) {
		this.#getClient = options.getClient;
		this.#pid = options.pid ?? process.pid;
	}

	get membership(): A2aMembership | null {
		return this.#membership ? publicMembership(this.#membership) : null;
	}

	async execute(request: A2aOperationRequest, context: A2aOperationContext): Promise<A2aOperationResult> {
		if (request.action === "leave") {
			if (!this.#membership) return { text: "Not joined", details: { left: null } };
			const membership = this.#membership;
			const left = publicMembership(membership);
			this.#membership = null;
			let cleanupPending = false;
			try {
				await membership.client.unregister(membership.project, membership.agentId, membership.leaseId);
			} catch {
				cleanupPending = true;
			}
			return {
				text: cleanupPending
					? `Left ${left.project} as ${left.agentId}; Hub cleanup pending lease expiry`
					: `Left ${left.project} as ${left.agentId}`,
				details: { left, cleanupPending },
				membershipChanged: "left",
				cleanupPending,
			};
		}

		switch (request.action) {
			case "project_create": {
				if (!request.project) throw new Error("project is required");
				const client = await this.#getClient();
				const project = await client.createProject({
					name: request.project,
					displayName: request.displayName,
					description: request.description,
					createdByCwd: context.cwd,
				});
				return {
					text: `Created A2A project ${project.name}`,
					details: { project },
				};
			}
			case "project_delete": {
				if (!request.project) throw new Error("project is required");
				const client = await this.#getClient();
				const deleted = await client.deleteProject(request.project);
				return {
					text: deleted
						? `Deleted A2A project ${request.project}`
						: `A2A project ${request.project} does not exist`,
					details: { project: request.project, deleted },
				};
			}
			case "project_list": {
				const client = await this.#getClient();
				const projects = await client.listProjects();
				const rows = await Promise.all(
					projects.map(async (project) => ({
						...project,
						online: (await client.listMembers(project.name)).length,
					})),
				);
				return {
					text:
						rows.length === 0
							? "No A2A projects."
							: rows.map((project) => `- ${project.name} online=${project.online}`).join("\n"),
					details: { projects: rows },
				};
			}
			case "join": {
				if (!request.project) throw new Error("project is required");
				if (!request.agentId) throw new Error("agentId is required");
				const client = await this.#getClient();
				const previous = this.#membership;
				const sameMembership =
					previous &&
					previous.project === request.project &&
					previous.agentId === request.agentId &&
					previous.hubBaseUrl === client.baseUrl;

				let members: A2aMember[];
				if (sameMembership) {
					await previous.client.heartbeat(previous.project, previous.agentId, previous.leaseId);
					members = await previous.client.listMembers(previous.project);
				} else {
					const { member, leaseId } = await client.register({
						project: request.project,
						agentId: request.agentId,
						cwd: context.cwd,
						pid: this.#pid,
						caps: request.caps,
						displayName: request.displayName,
						sessionId: context.sessionId,
					});
					try {
						members = await client.listMembers(request.project);
					} catch (error) {
						await client.unregister(member.project, member.agentId, leaseId).catch(() => undefined);
						throw error;
					}
					this.#membership = {
						project: member.project,
						agentId: member.agentId,
						hubBaseUrl: client.baseUrl,
						client,
						leaseId,
					};
					if (previous) {
						await previous.client
							.unregister(previous.project, previous.agentId, previous.leaseId)
							.catch(() => undefined);
					}
				}

				const membership = this.#membership;
				if (!membership) throw new Error("membership was not established");
				return {
					text: `Joined ${request.project} as ${request.agentId}\n${formatMembers(members)}`,
					details: { member: publicMembership(membership), members },
					membershipChanged: "joined",
				};
			}
			case "send": {
				const membership = this.#membership;
				if (!membership) throw new Error("not joined");
				if (!request.to) throw new Error("to is required");
				if (!request.text?.trim()) throw new Error("text is required");
				if (request.to === membership.agentId) throw new Error("cannot send to yourself");
				const message = await membership.client.send({
					project: membership.project,
					from: membership.agentId,
					to: request.to,
					text: request.text,
					messageId: request.messageId,
					replyTo: request.replyTo,
					replyToRef: request.replyToRef,
				});
				return {
					text: `Queued for ${message.to} ref=${message.messageRef ?? "-"} msg=${message.msgId}${message.replyToRef ? ` replyTo=${message.replyToRef}` : message.replyTo ? ` replyTo=${message.replyTo}` : ""}\n${ASYNC_REPLY_GUIDANCE}`,
					details: { message },
				};
			}
			case "hub": {
				const meta = await (await this.#getClient()).meta();
				return {
					text: `Hub running\nbase: ${meta.baseUrl}\ndata: ${meta.dataDir}\npid: ${meta.pid}`,
					details: { hub: meta },
				};
			}
			case "status": {
				const membership = this.#membership;
				const client = membership?.client ?? (await this.#getClient());
				const meta = await client.meta();
				if (!membership) {
					return {
						text: `A2A: not joined\nHub: ${meta.baseUrl} (pid ${meta.pid})`,
						details: { membership: null, hub: meta },
					};
				}
				const members = await client.listMembers(membership.project);
				return {
					text: [
						`A2A project: ${membership.project}`,
						`You: ${membership.agentId} @ ${context.cwd}`,
						`Hub: ${meta.baseUrl} (pid ${meta.pid})`,
						`Online members (${members.length}):`,
						formatMembers(members),
					].join("\n"),
					details: { membership: publicMembership(membership), members, hub: meta },
				};
			}
			case "list": {
				const membership = this.#membership;
				const project = request.project ?? membership?.project;
				if (!project) throw new Error("project is required (or join first)");
				const client =
					membership && project === membership.project ? membership.client : await this.#getClient();
				const members = await client.listMembers(project, request.all);
				return {
					text: `Project ${project}:\n${formatMembers(members)}`,
					details: { project, members },
				};
			}
			case "inbox": {
				const membership = this.#membership;
				if (!membership) throw new Error("not joined");
				const { messages, cursor } = await membership.client.readInbox(
					membership.project,
					membership.agentId,
					500,
					membership.leaseId,
				);
				const entries =
					messages.length === 0
						? "Inbox empty."
						: messages
								.map((message) =>
									message.kind === "delivery_receipt"
										? `[delivery receipt] ref=${message.messageRef ?? "-"} at=${new Date(message.createdAt).toISOString()} msg=${message.receiptFor} to=${message.from} deliveredAt=${new Date(message.deliveredAt).toISOString()}`
										: `[ref=${message.messageRef ?? "-"} at=${new Date(message.createdAt).toISOString()} msg=${message.msgId} replyTo=${message.replyToRef ?? message.replyTo ?? "-"}] from=${message.from}\n${message.text}`,
								)
								.join("\n\n");
				const acknowledgment =
					messages.length === 0
						? null
						: await membership.client.ack(
								membership.project,
								membership.agentId,
								messages.map((message) => message.msgId),
								membership.leaseId,
							);
				const cursorStatus =
					acknowledgment?.cursor ?? (messages.length === 0 ? cursor : "unknown (legacy Hub)");
				return {
					text: `Inbox cursor=${cursorStatus}\n${entries}`,
					details: {
						messages,
						cursor: acknowledgment?.cursor ?? cursor,
						acknowledgments: acknowledgment?.acknowledgments ?? null,
					},
				};
			}
			default:
				throw new Error(`unsupported A2A action: ${request.action}`);
		}
	}

	async heartbeat(): Promise<A2aMember | null> {
		const membership = this.#membership;
		if (!membership) return null;
		return await membership.client.heartbeat(
			membership.project,
			membership.agentId,
			membership.leaseId,
		);
	}

	async receive(
		deliver: (message: HubEnvelope) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<number> {
		const membership = this.#membership;
		if (!membership) return 0;
		if (signal?.aborted) throw signal.reason ?? new Error("Inbox receive aborted");
		const { messages } = await membership.client.readInbox(
			membership.project,
			membership.agentId,
			500,
			membership.leaseId,
			signal,
		);
		if (signal?.aborted) throw signal.reason ?? new Error("Inbox receive aborted");
		let delivered = 0;
		for (const message of messages) {
			if (signal?.aborted) throw signal.reason ?? new Error("Inbox receive aborted");
			await deliver(message);
			if (signal?.aborted) throw signal.reason ?? new Error("Inbox receive aborted");
			await membership.client.ack(
				membership.project,
				membership.agentId,
				[message.msgId],
				membership.leaseId,
				signal,
			);
			delivered++;
		}
		return delivered;
	}

	async meta(): Promise<HubMeta> {
		return await (await this.#getClient()).meta();
	}
}
