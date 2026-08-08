import type { WebSocket } from "ws";
import { AGENT_NAME_RE, PROJECT_NAME_RE } from "../types";
import type { Peer } from "./realtime-types";

export class NameInUseError extends Error {}

export type Presence = Peer & {
	project: string;
	socket: WebSocket;
	connectedAt: number;
};

export class PresenceRegistry {
	#byProject = new Map<string, Map<string, Presence>>();
	#bySocket = new Map<WebSocket, Presence>();

	claim(
		project: string,
		name: string,
		socket: WebSocket,
	): { self: Presence; peers: Peer[] } {
		if (!PROJECT_NAME_RE.test(project))
			throw new Error(`invalid project: ${project}`);
		if (!AGENT_NAME_RE.test(name)) throw new Error(`invalid name: ${name}`);
		if (this.#bySocket.has(socket))
			throw new Error("connection already claimed a name");
		let room = this.#byProject.get(project);
		if (!room) {
			room = new Map();
			this.#byProject.set(project, room);
		}
		if (room.has(name))
			throw new NameInUseError(`name already in use in ${project}: ${name}`);
		const peers = Array.from(
			room.values(),
			({ name: peerName, presenceId }) => ({ name: peerName, presenceId }),
		);
		const self: Presence = {
			project,
			name,
			presenceId: crypto.randomUUID(),
			socket,
			connectedAt: Date.now(),
		};
		room.set(name, self);
		this.#bySocket.set(socket, self);
		return { self, peers };
	}

	get(project: string, name: string): Presence | null {
		return this.#byProject.get(project)?.get(name) ?? null;
	}

	getBySocket(socket: WebSocket): Presence | null {
		return this.#bySocket.get(socket) ?? null;
	}

	connections(project: string): Presence[] {
		return Array.from(this.#byProject.get(project)?.values() ?? []);
	}

	remove(socket: WebSocket): Presence | null {
		const presence = this.#bySocket.get(socket);
		if (!presence) return null;
		this.#bySocket.delete(socket);
		const room = this.#byProject.get(presence.project);
		room?.delete(presence.name);
		if (room?.size === 0) this.#byProject.delete(presence.project);
		return presence;
	}

	count(project: string): number {
		return this.#byProject.get(project)?.size ?? 0;
	}

	close(): Presence[] {
		const presences = Array.from(this.#bySocket.values());
		this.#bySocket.clear();
		this.#byProject.clear();
		return presences;
	}
}
