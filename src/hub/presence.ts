import type { WebSocket } from "ws";
import { AGENT_NAME_RE, ROOM_NAME_RE } from "../types";
import type { Peer } from "./realtime-types";

export class NameInUseError extends Error {}

export type Presence = Peer & {
	room: string;
	socket: WebSocket;
	connectedAt: number;
};

export class PresenceRegistry {
	#byRoom = new Map<string, Map<string, Presence>>();
	#bySocket = new Map<WebSocket, Presence>();

	claim(
		room: string,
		name: string,
		socket: WebSocket,
	): { self: Presence; peers: Peer[] } {
		if (!ROOM_NAME_RE.test(room)) throw new Error(`invalid room: ${room}`);
		if (!AGENT_NAME_RE.test(name)) throw new Error(`invalid name: ${name}`);
		if (this.#bySocket.has(socket))
			throw new Error("connection already claimed a name");
		let members = this.#byRoom.get(room);
		if (!members) {
			members = new Map();
			this.#byRoom.set(room, members);
		}
		if (members.has(name))
			throw new NameInUseError(`name already in use in ${room}: ${name}`);
		const peers = Array.from(
			members.values(),
			({ name: peerName, presenceId }) => ({ name: peerName, presenceId }),
		);
		const self: Presence = {
			room,
			name,
			presenceId: crypto.randomUUID(),
			socket,
			connectedAt: Date.now(),
		};
		members.set(name, self);
		this.#bySocket.set(socket, self);
		return { self, peers };
	}

	get(room: string, name: string): Presence | null {
		return this.#byRoom.get(room)?.get(name) ?? null;
	}

	getBySocket(socket: WebSocket): Presence | null {
		return this.#bySocket.get(socket) ?? null;
	}

	connections(room: string): Presence[] {
		return Array.from(this.#byRoom.get(room)?.values() ?? []);
	}

	remove(socket: WebSocket): Presence | null {
		const presence = this.#bySocket.get(socket);
		if (!presence) return null;
		this.#bySocket.delete(socket);
		const room = this.#byRoom.get(presence.room);
		room?.delete(presence.name);
		if (room?.size === 0) this.#byRoom.delete(presence.room);
		return presence;
	}

	count(room: string): number {
		return this.#byRoom.get(room)?.size ?? 0;
	}

	close(): Presence[] {
		const presences = Array.from(this.#bySocket.values());
		this.#bySocket.clear();
		this.#byRoom.clear();
		return presences;
	}
}
