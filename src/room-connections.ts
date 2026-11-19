import type { HubClient } from "./hub/client";
import type { DeliveryEvent, Peer } from "./hub/realtime-types";
import { A2aRuntime, type MessageView } from "./operations";

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;

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

type RoomConnection = {
	room: string;
	hubUrl: string;
	runtime: A2aRuntime;
	target: ConnectionTarget;
	connecting: boolean;
	reportedToken?: AbortSignal;
	reconnectTimer?: NodeJS.Timeout;
	reconnectDelayMs: number;
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

	async connect(room: string, name: string, hubUrl: string): Promise<void> {
		const pinned = this.hubUrl;
		if (pinned !== undefined && pinned !== hubUrl) {
			throw new Error(
				`A2A Rooms are using Hub ${pinned}; disconnect them before connecting to ${hubUrl}`,
			);
		}

		const target = { name };
		let connection = this.#rooms.get(room);
		if (connection) {
			this.#clearReconnect(connection);
			connection.target = target;
		} else {
			connection = this.#createRoom(room, hubUrl, target);
			this.#rooms.set(room, connection);
		}
		await this.#attempt(connection, target);
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
			reconnectDelayMs: INITIAL_RECONNECT_DELAY_MS,
		};
		return connection;
	}

	async #attempt(
		connection: RoomConnection,
		target: ConnectionTarget,
	): Promise<void> {
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
			const message = error instanceof Error ? error.message : String(error);
			const retrying = !message.startsWith("name_in_use:");
			if (retrying) {
				this.#scheduleReconnect(connection);
			} else {
				const published = runtime.publishedTarget;
				if (published) {
					connection.target = { name: published.name };
					connection.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
				} else {
					this.#remove(connection);
				}
			}
			this.#events.onConnectError?.(room, message, retrying);
			return;
		}

		if (!isCurrent()) return;
		connection.connecting = false;
		if (!runtime.connected) {
			this.#scheduleReconnect(connection);
			return;
		}
		connection.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
		const token = runtime.connectionToken();
		const changed = token !== connection.reportedToken;
		connection.reportedToken = token;
		this.#events.onConnected?.(room, runtime, changed);
	}

	#scheduleReconnect(connection: RoomConnection): void {
		if (connection.connecting || connection.reconnectTimer) return;
		const target = connection.target;
		connection.reconnectTimer = setTimeout(() => {
			connection.reconnectTimer = undefined;
			void this.#attempt(connection, target);
		}, connection.reconnectDelayMs);
		connection.reconnectDelayMs = Math.min(
			connection.reconnectDelayMs * 2,
			MAX_RECONNECT_DELAY_MS,
		);
	}

	#clearReconnect(connection: RoomConnection): void {
		clearTimeout(connection.reconnectTimer);
		connection.reconnectTimer = undefined;
	}

	#remove(connection: RoomConnection): void {
		const { room, runtime } = connection;
		this.#rooms.delete(room);
		this.#clearReconnect(connection);
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
