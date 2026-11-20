import type { HubClient } from "./hub/client";
import type { DeliveryEvent, Peer } from "./hub/realtime-types";
import { A2aRuntime, type MessageView } from "./operations";
import { canReconnectRoom, RoomReconnect } from "./room-reconnect";

type RoomConnectionEvents = {
	onConnected?: (room: string, runtime: A2aRuntime, changed: boolean) => void;
	onDisconnected?: (room: string) => void;
	onConnectError?: (room: string, message: string, retrying: boolean) => void;
	onMessage?: (
		runtime: A2aRuntime,
		message: MessageView,
		signal: AbortSignal,
	) => Promise<void> | void;
	onPresenceJoined?: (room: string, peer: Peer) => void;
	onPresenceLeft?: (room: string, peer: Peer) => void;
	onDelivery?: (room: string, event: DeliveryEvent) => void;
	onError?: (room: string, error: Error) => void;
};

type ConnectionTarget = { name: string };
type ConnectFailure = { error: Error; retrying: boolean };

type RoomConnection = {
	room: string;
	hubUrl: string;
	runtime: A2aRuntime;
	target: ConnectionTarget;
	connecting: boolean;
	reportedToken?: AbortSignal;
	reconnect: RoomReconnect;
};

export class RoomConnections {
	#rooms = new Map<string, RoomConnection>();
	#teardowns = new Map<string, Promise<void>>();
	#getClient: (hubUrl: string) => Promise<HubClient>;
	#events: RoomConnectionEvents;

	constructor(options: {
		getClient: (hubUrl: string) => Promise<HubClient>;
		events?: RoomConnectionEvents;
	}) {
		this.#getClient = options.getClient;
		this.#events = options.events ?? {};
	}

	get hubUrl(): string | undefined {
		return this.#rooms.values().next().value?.hubUrl;
	}

	get(room: string): A2aRuntime | undefined {
		return this.#rooms.get(room)?.runtime;
	}

	entries(): Array<[string, A2aRuntime]> {
		return Array.from(this.#rooms, ([room, { runtime }]) => [room, runtime]);
	}

	snapshots() {
		return Array.from(this.#rooms, ([room, connection]) => {
			const { runtime } = connection;
			const self = runtime.self;
			return {
				room,
				state: self
					? ("connected" as const)
					: connection.reconnect.backedOff
						? ("reconnecting" as const)
						: ("connecting" as const),
				self: self?.name,
				peers: self ? runtime.peers().map(({ name }) => name) : [],
			};
		});
	}

	async connect(
		room: string,
		name: string,
		hubUrl: string,
	): Promise<ConnectFailure | undefined> {
		const pinned = this.hubUrl;
		if (pinned !== undefined && pinned !== hubUrl) {
			throw new Error(
				`A2A Rooms are using Hub ${pinned}; disconnect them before connecting to ${hubUrl}`,
			);
		}

		const target = { name };
		let connection = this.#rooms.get(room);
		if (connection) {
			connection.reconnect.cancel();
			connection.target = target;
		} else {
			connection = this.#createRoom(room, hubUrl, target);
			this.#rooms.set(room, connection);
		}
		return await this.#attempt(connection, target);
	}

	async disconnect(room?: string): Promise<boolean> {
		if (room !== undefined) {
			const connection = this.#rooms.get(room);
			if (connection) this.#remove(connection);
			await this.#teardowns.get(room);
			return connection !== undefined;
		}

		const removed = this.#rooms.size > 0;
		for (const connection of this.#rooms.values()) this.#remove(connection);
		await Promise.all(this.#teardowns.values());
		return removed;
	}

	#createRoom(
		room: string,
		hubUrl: string,
		target: ConnectionTarget,
	): RoomConnection {
		let client: HubClient | undefined;
		const isCurrent = () => this.#rooms.get(room) === connection;
		const runtime: A2aRuntime = new A2aRuntime({
			getClient: async () => {
				client ??= await this.#getClient(hubUrl);
				return client;
			},
			events: {
				onPresenceJoined: (peer) => {
					if (isCurrent()) this.#events.onPresenceJoined?.(room, peer);
				},
				onPresenceLeft: (peer) => {
					if (isCurrent()) this.#events.onPresenceLeft?.(room, peer);
				},
				onDelivery: (event) => {
					if (isCurrent()) this.#events.onDelivery?.(room, event);
				},
				onError: (error) => {
					if (isCurrent()) this.#events.onError?.(room, error);
				},
				onMessage: (message, signal) => {
					const handler = this.#events.onMessage;
					if (!isCurrent() || !handler)
						throw new Error("A2A inbound message has no injection handler");
					return handler(runtime, message, signal);
				},
				onClose: ({ manual }) => {
					if (manual || !isCurrent()) return;
					this.#scheduleReconnect(connection);
					this.#events.onDisconnected?.(room);
				},
			},
		});
		const connection: RoomConnection = {
			room,
			hubUrl,
			runtime,
			target,
			connecting: false,
			reconnect: new RoomReconnect(),
		};
		return connection;
	}

	async #attempt(
		connection: RoomConnection,
		target: ConnectionTarget,
	): Promise<ConnectFailure | undefined> {
		const { room, runtime } = connection;
		const isCurrent = () =>
			this.#rooms.get(room) === connection && connection.target === target;
		if (!isCurrent()) return;
		connection.connecting = true;

		try {
			// A rejoin must not claim the name before the removed runtime lets it go.
			const teardown = this.#teardowns.get(room);
			if (teardown) await teardown;
			if (!isCurrent()) return;
			await runtime.connect(room, target.name);
		} catch (error) {
			if (!isCurrent()) return;
			connection.connecting = false;
			const failure = error instanceof Error ? error : new Error(String(error));
			const { message } = failure;
			const retrying = canReconnectRoom(failure);
			if (retrying) {
				this.#scheduleReconnect(connection);
			} else {
				const published = runtime.publishedTarget;
				if (published) {
					connection.target = { name: published.name };
					connection.reconnect.reset();
				} else {
					this.#remove(connection);
				}
			}
			this.#events.onConnectError?.(room, message, retrying);
			return { error: failure, retrying };
		}

		if (!isCurrent()) return;
		connection.connecting = false;
		if (!runtime.connected) {
			this.#scheduleReconnect(connection);
			return;
		}
		connection.reconnect.reset();
		const token = runtime.connectionToken();
		const changed = token !== connection.reportedToken;
		connection.reportedToken = token;
		this.#events.onConnected?.(room, runtime, changed);
	}

	#scheduleReconnect(connection: RoomConnection): void {
		if (connection.connecting) return;
		const target = connection.target;
		connection.reconnect.schedule(() => {
			void this.#attempt(connection, target);
		});
	}

	#remove(connection: RoomConnection): void {
		const { room, runtime } = connection;
		this.#rooms.delete(room);
		connection.reconnect.cancel();
		const teardown = Promise.all([
			this.#teardowns.get(room),
			runtime.disconnect(),
		]).then(() => undefined);
		this.#teardowns.set(room, teardown);
		const clear = () => {
			if (this.#teardowns.get(room) === teardown) this.#teardowns.delete(room);
		};
		void teardown.then(clear, clear);
	}
}
