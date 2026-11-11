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
	UserApprovalReceipt,
} from "./hub/realtime-types";
import type { EncodedAttachment } from "./hub/types";
import type { A2aRoom } from "./types";

export type MessageAttachment = { name: string; bytes: Buffer };
export type MessageView = Omit<RealtimeMessage, "payload" | "attachments"> & {
	text: string;
	attachments: MessageAttachment[];
};
export type AcceptedMessageView =
	| { replayed: false; message: MessageView; recipients: string[] }
	| { replayed: true; message: MessageView };

export type RuntimeStatus = {
	hub: {
		baseUrl: string;
		protocolVersion: number;
	};
	connection: null | {
		room: string;
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
	room: string;
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

	get room(): string | null {
		return this.#published?.connection.room ?? null;
	}

	get name(): string | null {
		return this.#published?.connection.name ?? null;
	}

	get self(): Peer | null {
		return this.#published?.connection.self ?? null;
	}

	get publishedTarget(): {
		room: string;
		name: string;
		client: HubClient;
	} | null {
		const published = this.#published;
		return published
			? {
					room: published.connection.room,
					name: published.connection.name,
					client: published.client,
				}
			: null;
	}

	isPublishedConnection(token: AbortSignal): boolean {
		return this.#published?.lifecycle.signal === token && !token.aborted;
	}
	connectionToken(): AbortSignal {
		const published = this.#published;
		if (!published) throw new Error("A2A is not connected");
		return published.lifecycle.signal;
	}

	connect(
		room: string,
		name: string,
		client?: HubClient | (() => Promise<HubClient>),
	): Promise<ConnectionResult> {
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
			room,
			name,
			client,
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
		room: string;
		name: string;
		client?: HubClient | (() => Promise<HubClient>);
		abort: AbortController;
		predecessorTeardown: Promise<void>;
	}): Promise<ConnectionResult> {
		const {
			room,
			name,
			client: requestedClient,
			abort,
			predecessorTeardown,
		} = options;
		await predecessorTeardown;
		abort.signal.throwIfAborted();
		const client =
			typeof requestedClient === "function"
				? await requestedClient()
				: (requestedClient ?? (await this.#getClient()));
		abort.signal.throwIfAborted();

		const predecessor = this.#published;
		if (
			predecessor?.connection.room === room &&
			predecessor.connection.name === name &&
			predecessor.client.baseUrl === client.baseUrl
		) {
			return {
				room,
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
			room,
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
						throw new Error("A2A message arrived on an unpublished connection");
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
		if (abort.signal.aborted || candidateClosed) {
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
		if (this.#published?.connection !== connection) {
			throw new Error("A2A connection transition superseded");
		}
		return {
			room,
			name,
			presenceId: connection.self.presenceId,
			peers: connection.peers(),
		};
	}

	async disconnect(): Promise<boolean> {
		const candidate = this.#candidate;
		this.#candidate = null;
		candidate?.abort.abort(new Error("A2A connection transition disconnected"));
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

	async message(
		options: {
			target: MessageRequestTarget;
			text: string;
			attachments?: EncodedAttachment[];
			replyTo?: string;
			messageId?: string;
			userApproval?: UserApprovalReceipt;
		},
		request: { signal?: AbortSignal; connectionToken?: AbortSignal } = {},
	): Promise<AcceptedMessageView> {
		const published = this.#published;
		if (
			!published ||
			(request.connectionToken &&
				(published.lifecycle.signal !== request.connectionToken ||
					request.connectionToken.aborted))
		)
			throw new Error("A2A connection changed before message send");
		const accepted: AcceptedMessage = await published.connection.send(options, {
			signal: request.signal,
		});
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
		query?: Omit<HistoryQuery, "room">,
		options?: HubRequestOptions,
	): Promise<MessageView[]> {
		const published = this.#published;
		if (!published) throw new Error("A2A is not connected");
		if (query?.before && query.after)
			throw new Error("history accepts before or after, not both");
		const page = await published.client.history(
			{
				room: published.connection.room,
				...query,
			},
			options,
		);
		return page.messages.map((message) => this.#view(message));
	}

	async status(options?: HubRequestOptions): Promise<RuntimeStatus> {
		const published = this.#published;
		const client = published?.client ?? (await this.#getClient());
		const meta = await client.meta(options);
		const connection = published?.connection ?? null;
		return {
			hub: { baseUrl: client.baseUrl, protocolVersion: meta.protocolVersion },
			connection: connection
				? {
						room: connection.room,
						name: connection.name,
						presenceId: connection.self.presenceId,
						peers: connection.peers(),
					}
				: null,
		};
	}

	async createRoom(
		room: {
			name: string;
			displayName?: string;
			description?: string;
			createdByCwd?: string;
		},
		options?: HubRequestOptions,
	): Promise<A2aRoom> {
		return await (await this.#getClient()).createRoom(room, options);
	}

	async listRooms(options?: HubRequestOptions): Promise<A2aRoom[]> {
		return await (await this.#getClient()).listRooms(options);
	}

	async deleteRoom(
		name: string,
		options?: HubRequestOptions,
	): Promise<boolean> {
		return await (await this.#getClient()).deleteRoom(name, options);
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
