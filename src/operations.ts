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

type PublishedConnection = {
	connection: A2aConnection;
	client: HubClient;
};

type Candidate = {
	connection: A2aConnection | null;
	state: "candidate" | "published" | "retired";
	events: Array<{ publish: () => void; discard: () => void }>;
	closed?: { manual: boolean; code: number; reason: string };
};


export class A2aRuntime {
	#getClient: (signal?: AbortSignal) => Promise<HubClient>;
	#connect: typeof A2aConnection.connect;
	#events: A2aRuntimeEvents;
	#connection: PublishedConnection | null = null;
	#transition = 0;
	#transitionAbort: AbortController | null = null;

	constructor(options: {
		getClient: (signal?: AbortSignal) => Promise<HubClient>;
		events?: A2aRuntimeEvents;
		connect?: typeof A2aConnection.connect;
	}) {
		this.#getClient = options.getClient;
		this.#events = options.events ?? {};
		this.#connect = options.connect ?? A2aConnection.connect;
	}

	get connected(): boolean {
		return this.#connection !== null;
	}

	get project(): string | null {
		return this.#connection?.connection.project ?? null;
	}

	get name(): string | null {
		return this.#connection?.connection.name ?? null;
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
		const transition = ++this.#transition;
		const superseded = new Error("A2A connection transition was superseded");
		this.#transitionAbort?.abort(superseded);
		const transitionAbort = new AbortController();
		this.#transitionAbort = transitionAbort;
		const client = await this.#getClient(transitionAbort.signal);
		if (transition !== this.#transition)
			throw new Error("A2A connection transition was superseded");
		const current = this.#connection;
		if (
			current?.connection.project === project &&
			current.connection.name === name &&
			current.client.baseUrl === client.baseUrl
		) {
			return {
				project,
				name,
				presenceId: current.connection.self.presenceId,
				peers: current.connection.peers(),
			};
		}

		const candidate: Candidate = {
			connection: null,
			state: "candidate",
			events: [],
		};
		const emit = (publish: () => void, discard: () => void = () => {}): void => {
			if (candidate.state === "candidate") {
				candidate.events.push({ publish, discard });
				return;
			}
			if (
				candidate.state === "published" &&
				this.#connection?.connection === candidate.connection
			)
				publish();
			else discard();
		};
		try {
			candidate.connection = await this.#connect({
				baseUrl: client.baseUrl,
				project,
				name,
				signal: transitionAbort.signal,
				events: {
					onPresenceJoined: (peer) =>
						emit(() => this.#events.onPresenceJoined?.(peer)),
					onPresenceLeft: (peer, reason) =>
						emit(() => this.#events.onPresenceLeft?.(peer, reason)),
					onDelivery: (delivery) =>
						emit(() => this.#events.onDelivery?.(delivery)),
					onError: (error) => emit(() => this.#events.onError?.(error)),
					onMessage: async (message) =>
						await new Promise<void>((resolve, reject) => {
							emit(
								() => {
									Promise.resolve(
										this.#events.onMessage?.(this.#view(message)),
									).then(resolve, reject);
								},
								resolve,
							);
						}),
					onClose: (event) => {
						candidate.closed = event;
						if (candidate.state === "candidate") return;
						emit(() => {
							if (this.#connection?.connection !== candidate.connection) return;
							this.#connection = null;
							candidate.state = "retired";
							this.#events.onClose?.(event);
						});
					},
				},
			});
		} catch (error) {
			candidate.state = "retired";
			for (const event of candidate.events.splice(0)) event.discard();
			throw error;
		}
		const connection = candidate.connection;
		if (!connection) throw new Error("A2A connection candidate was not created");
		const candidateClosed = candidate.closed as
			| Candidate["closed"]
			| undefined;

		if (transition !== this.#transition || candidateClosed) {
			candidate.state = "retired";
			for (const event of candidate.events.splice(0)) event.discard();
			await connection.close();
			if (candidateClosed) {
				throw new Error(
					`A2A connection closed (${candidateClosed.code}): ${candidateClosed.reason || "no reason"}`,
				);
			}
			throw new Error("A2A connection transition was superseded");
		}

		const previous = this.#connection;
		candidate.state = "published";
		this.#connection = {
			connection,
			client,
		};
		for (const event of candidate.events.splice(0)) event.publish();
		if (previous) await previous.connection.close();
		const closed = candidate.closed as Candidate["closed"] | undefined;
		if (
			transition !== this.#transition ||
			candidate.state !== "published" ||
			this.#connection?.connection !== connection ||
			closed
		) {
			if (closed) {
				throw new Error(
					`A2A connection closed (${closed.code}): ${closed.reason || "no reason"}`,
				);
			}
			throw new Error("A2A connection transition was superseded");
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
		this.#transitionAbort?.abort(
			new Error("A2A connection transition was superseded"),
		);
		this.#transitionAbort = null;
		const published = this.#connection;
		if (!published) return false;
		this.#connection = null;
		await published.connection.close();
		return true;
	}

	peers(): Peer[] {
		if (!this.#connection) throw new Error("A2A is not connected");
		return this.#connection.connection.peers();
	}

	async message(
		options: {
			target: MessageRequestTarget;
			text: string;
			attachments?: EncodedAttachment[];
			replyTo?: string;
			messageId?: string;
		},
		requestOptions: HubRequestOptions = {},
	): Promise<{ message: MessageView; recipients: string[] }> {
		const connection = this.#connection?.connection;
		if (!connection) throw new Error("A2A is not connected");
		if (requestOptions.signal?.aborted)
			throw (
				requestOptions.signal.reason ?? new Error("A2A operation aborted")
			);
		const accepted: AcceptedMessage = await connection.send(options, {
			signal: requestOptions.signal,
		});
		return {
			message: this.#view(accepted.message),
			recipients: accepted.recipients,
		};
	}

	async history(
		query?: Omit<HistoryQuery, "project">,
		requestOptions: HubRequestOptions = {},
	): Promise<MessageView[]> {
		const published = this.#connection;
		if (!published) throw new Error("A2A is not connected");
		const page = await published.client.history(
			{
				project: published.connection.project,
				...query,
			},
			requestOptions,
		);
		return page.messages.map((message) => this.#view(message));
	}

	async status(requestOptions: HubRequestOptions = {}): Promise<RuntimeStatus> {
		const connection = this.#connection;
		const client =
			connection?.client ?? (await this.#getClient(requestOptions.signal));
		const hub = await client.meta(requestOptions);
		return {
			hub,
			connection: connection
				? {
						project: connection.connection.project,
						name: connection.connection.name,
						presenceId: connection.connection.self.presenceId,
						peers: connection.connection.peers(),
					}
				: null,
		};
	}

	async createProject(
		options: {
			name: string;
			displayName?: string;
			description?: string;
			createdByCwd?: string;
		},
		requestOptions: HubRequestOptions = {},
	): Promise<A2aProject> {
		return await (
			await this.#getClient(requestOptions.signal)
		).createProject(options, requestOptions);
	}

	async listProjects(
		requestOptions: HubRequestOptions = {},
	): Promise<A2aProject[]> {
		return await (
			await this.#getClient(requestOptions.signal)
		).listProjects(requestOptions);
	}

	async deleteProject(
		name: string,
		requestOptions: HubRequestOptions = {},
	): Promise<boolean> {
		return await (
			await this.#getClient(requestOptions.signal)
		).deleteProject(name, requestOptions);
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
