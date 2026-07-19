import { Database } from "bun:sqlite";
import * as path from "node:path";
import { ensureDir } from "../paths";
import type { EncodedTextPayload, HubWireEnvelope } from "./types";

type MessageRow = {
	msg_id: string;
	project: string;
	sender: string;
	recipient: string;
	encoding: EncodedTextPayload["encoding"];
	data: string;
	uncompressed_bytes: number;
	created_at: number;
};

export class InboxStore {
	#database: Database;
	#insert;
	#list;
	#delete;
	#removeMessages;

	constructor(databasePath: string) {
		ensureDir(path.dirname(databasePath));
		this.#database = new Database(databasePath, { create: true });
		this.#database.run("PRAGMA journal_mode = WAL");
		this.#database.run("PRAGMA synchronous = FULL");
		this.#database.run(`
			CREATE TABLE IF NOT EXISTS inbox_messages (
				msg_id TEXT PRIMARY KEY,
				project TEXT NOT NULL,
				sender TEXT NOT NULL,
				recipient TEXT NOT NULL,
				encoding TEXT NOT NULL,
				data TEXT NOT NULL,
				uncompressed_bytes INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
		this.#database.run(
			"CREATE INDEX IF NOT EXISTS inbox_recipient_order ON inbox_messages(project, recipient, created_at, msg_id)",
		);
		this.#insert = this.#database.query(
			"INSERT INTO inbox_messages(msg_id, project, sender, recipient, encoding, data, uncompressed_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.#list = this.#database.query<MessageRow, [string, string, number]>(
			"SELECT msg_id, project, sender, recipient, encoding, data, uncompressed_bytes, created_at FROM inbox_messages WHERE project = ? AND recipient = ? ORDER BY created_at, msg_id LIMIT ?",
		);
		this.#delete = this.#database.query(
			"DELETE FROM inbox_messages WHERE msg_id = ? AND project = ? AND recipient = ?",
		);
		this.#removeMessages = this.#database.transaction((project: string, agentId: string, messageIds: string[]) => {
			for (const messageId of messageIds) this.#delete.run(messageId, project, agentId);
		});
	}

	push(message: HubWireEnvelope): void {
		this.#insert.run(
			message.msgId,
			message.project,
			message.from,
			message.to,
			message.payload.encoding,
			message.payload.data,
			message.payload.uncompressedBytes,
			message.createdAt,
		);
	}

	list(project: string, agentId: string, limit = 500): HubWireEnvelope[] {
		return this.#list.all(project, agentId, limit).map((row) => ({
			msgId: row.msg_id,
			project: row.project,
			from: row.sender,
			to: row.recipient,
			payload: {
				encoding: row.encoding,
				data: row.data,
				uncompressedBytes: row.uncompressed_bytes,
			} as EncodedTextPayload,
			createdAt: row.created_at,
		}));
	}

	ack(project: string, agentId: string, messageIds: string[]): void {
		this.#removeMessages(project, agentId, messageIds);
	}

	close(): void {
		this.#database.close();
	}
}
