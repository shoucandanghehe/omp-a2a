import type { HubClient, HubRequestOptions } from "./hub/client";
import { A2aConnection, type A2aConnectionEvents } from "./hub/connection";
import { decodeBinaryPayload, decodeTextPayload } from "./hub/payload";
import type {
	AcceptedMessage,
	DeliveryEvent,
	HistoryQuery,
	MessageRequestTarget,
	Peer,
	RealtimeMessage,
} from "./hub/realtime-types";
import type { EncodedAttachment, HubMeta } from "./hub/types";
import type { A2aProject } from "./types";

export type MessageAttachment = { name: string; bytes: Buffer };
export type MessageView = Omit<RealtimeMessage, "payload" | "attachments"> & {
	text: string;
	attachments: MessageAttachment[];
};
export type AcceptedMessageView =
	| { replayed: false; message: MessageView; recipients: string[] }
	| { replayed: true; message: MessageView };


export type RuntimeStatus = {
	hub: HubMeta;
	connection: null | {
		project: string;
		name: string;
		presenceId: string;
		peers: Peer[];
	};
};

export type A2aRuntimeEvents = {
	onPresenceJoined?: A2aConnectionEvents["onPresenceJoined"];
	onPresenceLeft?: A2aConnectionEvents["onPresenceLeft"];
	onMessage?: (message: MessageView) => void | Promise<void>;
	onDelivery?: (delivery: DeliveryEvent) => void;
	onClose?: A2aConnectionEvents["onClose"];
	onError?: A2aConnectionEvents["onError"];
};

export class A2aRuntime {
	#getClient: () => Promise<HubClient>;
	#events: A2aRuntimeEvents;
	#connection: A2aConnection | null = null;

	constructor(options: {
		getClient: () => Promise<HubClient>;
		events?: A2aRuntimeEvents;
	}) {
		this.#getClient = options.getClient;
		this.#events = options.events ?? {};
	}

	get connected(): boolean {
		return this.#connection !== null;
	}

	get project(): string | null {
		return this.#connection?.project ?? null;
	}

	get name(): string | null {
		return this.#connection?.name ?? null;
	}

	async connect(
		project: string,
		name: string,
	): Promise<{
		project: string;
		name: string;
		presenceId: string;
		peers: Peer[];
	}> {
		if (
			this.#connection?.project === project &&
			this.#connection.name === name
		) {
			return {
				project,
				name,
				presenceId: this.#connection.self.presenceId,
				peers: this.#connection.peers(),
			};
		}
		await this.disconnect();
		const client = await this.#getClient();
		let connection: A2aConnection | null = null;
		connection = await A2aConnection.connect({
			baseUrl: client.baseUrl,
			project,
			name,
			events: {
				onPresenceJoined: this.#events.onPresenceJoined,
				onPresenceLeft: this.#events.onPresenceLeft,
				onDelivery: this.#events.onDelivery,
				onError: this.#events.onError,
				onMessage: async (message) =>
					await this.#events.onMessage?.(this.#view(message)),
				onClose: (event) => {
					if (connection && this.#connection === connection)
						this.#connection = null;
					this.#events.onClose?.(event);
				},
			},
		});
		this.#connection = connection;
		return {
			project,
			name,
			presenceId: connection.self.presenceId,
			peers: connection.peers(),
		};
	}

	async disconnect(): Promise<boolean> {
		const connection = this.#connection;
		if (!connection) return false;
		this.#connection = null;
		await connection.close();
		return true;
	}

	peers(): Peer[] {
		if (!this.#connection) throw new Error("A2A is not connected");
		return this.#connection.peers();
	}

	async message(
		options: {
			target: MessageRequestTarget;
			text: string;
			attachments?: EncodedAttachment[];
			replyTo?: string;
			messageId?: string;
		},
		request: { signal?: AbortSignal } = {},
	): Promise<AcceptedMessageView> {
		if (!this.#connection) throw new Error("A2A is not connected");
		const accepted: AcceptedMessage = await this.#connection.send(
			options,
			request,
		);
		return accepted.replayed
			? {
					replayed: true,
					message: this.#view(accepted.message),
				}
			: {
					replayed: false,
					message: this.#view(accepted.message),
					recipients: accepted.recipients,
				};
	}

	async history(
		query?: Omit<HistoryQuery, "project">,
		options?: HubRequestOptions,
	): Promise<MessageView[]> {
		if (!this.#connection) throw new Error("A2A is not connected");
		const page = await (await this.#getClient()).history(
			{
				project: this.#connection.project,
				...query,
			},
			options,
		);
		return page.messages.map((message) => this.#view(message));
	}

	async status(options?: HubRequestOptions): Promise<RuntimeStatus> {
		const hub = await (await this.#getClient()).meta(options);
		const connection = this.#connection;
		return {
			hub,
			connection: connection
				? {
						project: connection.project,
						name: connection.name,
						presenceId: connection.self.presenceId,
						peers: connection.peers(),
					}
				: null,
		};
	}

	async createProject(
		project: {
			name: string;
			displayName?: string;
			description?: string;
			createdByCwd?: string;
		},
		options?: HubRequestOptions,
	): Promise<A2aProject> {
		return await (await this.#getClient()).createProject(project, options);
	}

	async listProjects(options?: HubRequestOptions): Promise<A2aProject[]> {
		return await (await this.#getClient()).listProjects(options);
	}

	async deleteProject(
		name: string,
		options?: HubRequestOptions,
	): Promise<boolean> {
		return await (await this.#getClient()).deleteProject(name, options);
	}

	#view(message: RealtimeMessage): MessageView {
		const { payload, attachments, ...metadata } = message;
		return {
			...metadata,
			text: decodeTextPayload(payload),
			attachments: attachments.map((attachment) => ({
				name: attachment.name,
				bytes: decodeBinaryPayload(attachment.payload),
			})),
		};
	}
}
