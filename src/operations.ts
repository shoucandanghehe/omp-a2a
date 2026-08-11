import type { HubClient } from "./hub/client";
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
	onMessage?: (
		message: MessageView,
		signal: AbortSignal,
	) => void | Promise<void>;
	onDelivery?: (delivery: DeliveryEvent) => void;
	onClose?: A2aConnectionEvents["onClose"];
	onError?: A2aConnectionEvents["onError"];
};

type PublishedConnection = {
	connection: A2aConnection;
	client: HubClient;
	lifecycle: AbortController;
};
type ConnectionResult = {
	project: string;
	name: string;
	presenceId: string;
	peers: Peer[];
};

type ConnectionCandidate = {
	abort: AbortController;
	promise: Promise<ConnectionResult>;
};

export class A2aRuntime {
	#getClient: () => Promise<HubClient>;
	#events: A2aRuntimeEvents;
	#published: PublishedConnection | null = null;
	#transition = 0;
	#candidate: ConnectionCandidate | null = null;
	#teardown: Promise<void> = Promise.resolve();

	constructor(options: {
		getClient: () => Promise<HubClient>;
		events?: A2aRuntimeEvents;
	}) {
		this.#getClient = options.getClient;
		this.#events = options.events ?? {};
	}

	get connected(): boolean {
		return this.#published !== null;
	}

	get project(): string | null {
		return this.#published?.connection.project ?? null;
	}

	get name(): string | null {
		return this.#published?.connection.name ?? null;
	}

	get publishedTarget(): {
		project: string;
		name: string;
		client: HubClient;
	} | null {
		const published = this.#published;
		return published
			? {
					project: published.connection.project,
					name: published.connection.name,
					client: published.client,
				}
			: null;
	}

	isPublishedConnection(token: AbortSignal): boolean {
		return (
			this.#published?.lifecycle.signal === token &&
			!token.aborted
		);
	}
	connectionToken(): AbortSignal {
		const published = this.#published;
		if (!published) throw new Error("A2A is not connected");
		return published.lifecycle.signal;
	}

	connect(
		project: string,
		name: string,
		client?: HubClient | (() => Promise<HubClient>),
	): Promise<ConnectionResult> {
		const transition = ++this.#transition;
		const predecessorCandidate = this.#candidate;
		const predecessorTeardown = Promise.all([
			this.#teardown,
			predecessorCandidate?.promise.catch(() => undefined),
		]).then(() => undefined);
		this.#teardown = predecessorTeardown;
		predecessorCandidate?.abort.abort(
			new Error("A2A connection transition superseded"),
		);
		const abort = new AbortController();
		const promise = this.#connectCandidate({
			project,
			name,
			client,
			transition,
			abort,
			predecessorTeardown,
		});
		const candidate = { abort, promise };
		this.#candidate = candidate;
		const clearCandidate = () => {
			if (this.#candidate === candidate) this.#candidate = null;
		};
		void promise.then(clearCandidate, clearCandidate);
		return promise;
	}

	async #connectCandidate(options: {
		project: string;
		name: string;
		client?: HubClient | (() => Promise<HubClient>);
		transition: number;
		abort: AbortController;
		predecessorTeardown: Promise<void>;
	}): Promise<ConnectionResult> {
		const {
			project,
			name,
			client: requestedClient,
			transition,
			abort,
			predecessorTeardown,
		} = options;
		await predecessorTeardown;
		abort.signal.throwIfAborted();
		const client =
			typeof requestedClient === "function"
				? await requestedClient()
				: (requestedClient ?? (await this.#getClient()));
		if (transition !== this.#transition) {
			abort.abort(new Error("A2A connection transition superseded"));
		}
		abort.signal.throwIfAborted();

		const predecessor = this.#published;
		if (
			predecessor?.connection.project === project &&
			predecessor.connection.name === name &&
			predecessor.client.baseUrl === client.baseUrl
		) {
			return {
				project,
				name,
				presenceId: predecessor.connection.self.presenceId,
				peers: predecessor.connection.peers(),
			};
		}

		const lifecycle = new AbortController();
		let connection: A2aConnection | null = null;
		let candidateClosed = false;
		connection = await A2aConnection.connect({
			baseUrl: client.baseUrl,
			project,
			name,
			signal: abort.signal,
			events: {
				onPresenceJoined: (peer) => {
					if (this.#published?.connection === connection)
						this.#events.onPresenceJoined?.(peer);
				},
				onPresenceLeft: (peer, reason) => {
					if (this.#published?.connection === connection)
						this.#events.onPresenceLeft?.(peer, reason);
				},
				onDelivery: (delivery) => {
					if (this.#published?.connection === connection)
						this.#events.onDelivery?.(delivery);
				},
				onError: (error) => {
					if (this.#published?.connection === connection)
						this.#events.onError?.(error);
				},
				onMessage: async (message) => {
					if (this.#published?.connection !== connection) {
						throw new Error(
							"A2A message arrived on an unpublished connection",
						);
					}
					const handler = this.#events.onMessage;
					if (!handler)
						throw new Error("A2A inbound message has no injection handler");
					await handler(this.#view(message), lifecycle.signal);
					if (
						this.#published?.connection !== connection ||
						lifecycle.signal.aborted
					) {
						throw new Error(
							"A2A connection changed before message injection completed",
						);
					}
				},
				onClose: (event) => {
					candidateClosed = true;
					if (!connection || this.#published?.connection !== connection) return;
					lifecycle.abort(new Error("A2A published connection closed"));
					this.#published = null;
					this.#events.onClose?.(event);
				},
			},
		});
		if (
			transition !== this.#transition ||
			abort.signal.aborted ||
			candidateClosed
		) {
			await connection.close();
			abort.signal.throwIfAborted();
			throw new Error("A2A connection candidate closed before publication");
		}
		this.#published = { connection, client, lifecycle };
		if (predecessor) {
			predecessor.lifecycle.abort(
				new Error("A2A published connection replaced"),
			);
			await predecessor.connection.close();
		}
		if (
			transition !== this.#transition ||
			this.#published?.connection !== connection
		) {
			throw new Error("A2A connection transition superseded");
		}
		return {
			project,
			name,
			presenceId: connection.self.presenceId,
			peers: connection.peers(),
		};
	}

	async disconnect(): Promise<boolean> {
		++this.#transition;
		const candidate = this.#candidate;
		this.#candidate = null;
		candidate?.abort.abort(
			new Error("A2A connection transition disconnected"),
		);
		const published = this.#published;
		this.#published = null;
		published?.lifecycle.abort(
			new Error("A2A published connection disconnected"),
		);
		const teardown = Promise.all([
			this.#teardown,
			candidate?.promise.catch(() => undefined),
			published?.connection.close(),
		]).then(() => undefined);
		this.#teardown = teardown;
		await teardown;
		return published !== null;
	}

	peers(): Peer[] {
		const connection = this.#published?.connection;
		if (!connection) throw new Error("A2A is not connected");
		return connection.peers();
	}

	async message(options: {
		target: MessageRequestTarget;
		text: string;
		attachments?: EncodedAttachment[];
		replyTo?: string;
		messageId?: string;
	}, connectionToken?: AbortSignal): Promise<{
		message: MessageView;
		recipients: string[];
	}> {
		const published = this.#published;
		if (
			!published ||
			(connectionToken &&
				(published.lifecycle.signal !== connectionToken ||
					connectionToken.aborted))
		)
			throw new Error("A2A connection changed before message send");
		const accepted: AcceptedMessage = await published.connection.send(options);
		return {
			message: this.#view(accepted.message),
			recipients: accepted.recipients,
		};
	}

	async history(query?: Omit<HistoryQuery, "project">): Promise<MessageView[]> {
		const published = this.#published;
		if (!published) throw new Error("A2A is not connected");
		const page = await published.client.history({
			project: published.connection.project,
			...query,
		});
		return page.messages.map((message) => this.#view(message));
	}

	async status(): Promise<RuntimeStatus> {
		const published = this.#published;
		const hub = await (published?.client ?? (await this.#getClient())).meta();
		const connection = published?.connection ?? null;
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

	async createProject(options: {
		name: string;
		displayName?: string;
		description?: string;
		createdByCwd?: string;
	}): Promise<A2aProject> {
		return await (await this.#getClient()).createProject(options);
	}

	async listProjects(): Promise<A2aProject[]> {
		return await (await this.#getClient()).listProjects();
	}

	async deleteProject(name: string): Promise<boolean> {
		return await (await this.#getClient()).deleteProject(name);
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
