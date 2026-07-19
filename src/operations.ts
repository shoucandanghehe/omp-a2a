import type { HubClient } from "./hub/client";
import type { HubEnvelope, HubMeta } from "./hub/types";
import type { A2aMember } from "./types";

export type A2aMembership = { project: string; agentId: string };

export type A2aOperationRequest = {
	action:
		| "hub"
		| "project_create"
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
	#membership: A2aMembership | null = null;

	constructor(options: A2aOperationsOptions) {
		this.#getClient = options.getClient;
		this.#pid = options.pid ?? process.pid;
	}

	get membership(): A2aMembership | null {
		return this.#membership ? { ...this.#membership } : null;
	}

	async execute(request: A2aOperationRequest, context: A2aOperationContext): Promise<A2aOperationResult> {
		if (request.action === "leave") {
			if (!this.#membership) return { text: "Not joined", details: { left: null } };
			const left = this.#membership;
			this.#membership = null;
			let cleanupPending = false;
			try {
				await (await this.#getClient()).unregister(left.project, left.agentId);
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
		const client = await this.#getClient();
		switch (request.action) {
			case "project_create": {
				if (!request.project) throw new Error("project is required");
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
			case "project_list": {
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
				if (
					this.#membership?.project === request.project &&
					this.#membership.agentId === request.agentId
				) {
					await client.heartbeat(request.project, request.agentId);
				} else {
					if (this.#membership) {
						const previous = this.#membership;
						this.#membership = null;
						await client.unregister(previous.project, previous.agentId).catch(() => undefined);
					}
					const { member } = await client.register({
						project: request.project,
						agentId: request.agentId,
						cwd: context.cwd,
						pid: this.#pid,
						caps: request.caps,
						displayName: request.displayName,
						sessionId: context.sessionId,
					});
					this.#membership = { project: member.project, agentId: member.agentId };
				}
				const members = await client.listMembers(request.project);
				return {
					text: `Joined ${request.project} as ${request.agentId}\n${formatMembers(members)}`,
					details: { member: this.#membership, members },
					membershipChanged: "joined",
				};
			}
			case "send": {
				if (!this.#membership) throw new Error("not joined");
				if (!request.to) throw new Error("to is required");
				if (!request.text?.trim()) throw new Error("text is required");
				if (request.to === this.#membership.agentId) throw new Error("cannot send to yourself");
				const message = await client.send({
					project: this.#membership.project,
					from: this.#membership.agentId,
					to: request.to,
					text: request.text,
				});
				return {
					text: `Sent to ${message.to} msg=${message.msgId}`,
					details: { message },
				};
			}
			case "hub": {
				const meta = await client.meta();
				return {
					text: `Hub running\nbase: ${meta.baseUrl}\ndata: ${meta.dataDir}\npid: ${meta.pid}`,
					details: { hub: meta },
				};
			}
			case "status": {
				const meta = await client.meta();
				if (!this.#membership) {
					return {
						text: `A2A: not joined\nHub: ${meta.baseUrl} (pid ${meta.pid})`,
						details: { membership: null, hub: meta },
					};
				}
				const members = await client.listMembers(this.#membership.project);
				return {
					text: [
						`A2A project: ${this.#membership.project}`,
						`You: ${this.#membership.agentId} @ ${context.cwd}`,
						`Hub: ${meta.baseUrl} (pid ${meta.pid})`,
						`Online members (${members.length}):`,
						formatMembers(members),
					].join("\n"),
					details: { membership: this.#membership, members, hub: meta },
				};
			}
			case "list": {
				const project = request.project ?? this.#membership?.project;
				if (!project) throw new Error("project is required (or join first)");
				const members = await client.listMembers(project, request.all);
				return {
					text: `Project ${project}:\n${formatMembers(members)}`,
					details: { project, members },
				};
			}
			case "inbox": {
				if (!this.#membership) throw new Error("not joined");
				const messages = await client.inbox(this.#membership.project, this.#membership.agentId);
				const text =
					messages.length === 0
						? "Inbox empty."
						: messages
								.map((message) => `[${message.msgId}] from=${message.from}\n${message.text}`)
								.join("\n\n");
				if (messages.length > 0) {
					await client.ack(
						this.#membership.project,
						this.#membership.agentId,
						messages.map((message) => message.msgId),
					);
				}
				return { text, details: { messages } };
			}
			default:
				throw new Error(`unsupported A2A action: ${request.action}`);
		}
	}

	async heartbeat(): Promise<A2aMember | null> {
		if (!this.#membership) return null;
		const client = await this.#getClient();
		return await client.heartbeat(this.#membership.project, this.#membership.agentId);
	}

	async receive(deliver: (message: HubEnvelope) => void | Promise<void>): Promise<number> {
		if (!this.#membership) return 0;
		const membership = this.#membership;
		const client = await this.#getClient();
		const messages = await client.inbox(membership.project, membership.agentId);
		let delivered = 0;
		for (const message of messages) {
			await deliver(message);
			await client.ack(membership.project, membership.agentId, [message.msgId]);
			delivered++;
		}
		return delivered;
	}

	async meta(): Promise<HubMeta> {
		return await (await this.#getClient()).meta();
	}
}
