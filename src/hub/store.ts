import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../paths";
import type { A2aRoom } from "../types";
import { AGENT_NAME_RE, ROOM_NAME_RE } from "../types";
import { decodeTextPayload, parseEncodedAttachments } from "./payload";
import {
	decodeUserApprovalReceipt,
	formatMessageRef,
	type HistoryPage,
	type HistoryQuery,
	MESSAGE_ID_RE,
	type MessageTarget,
	parseMessageRef,
	type RealtimeMessage,
	type UserApprovalReceipt,
} from "./realtime-types";
import type { EncodedAttachment, EncodedTextPayload } from "./types";

export const MESSAGE_STORAGE_VERSION = 4;
const UNSUPPORTED_STORAGE_MESSAGE =
	"unsupported pre-release storage; start with an empty data directory";

export class MessageIdConflictError extends Error {}
export class RoomConflictError extends Error {}
export class UnknownRoomError extends Error {}
export class UnknownReplyTargetError extends Error {}
export type MessageDraft = {
	messageId: string;
	room: string;
	from: { name: string; presenceId: string };
	target: MessageTarget;
	payload: EncodedTextPayload;
	attachments: EncodedAttachment[];
	createdAt: number;
	replyTo?: string;
	userApproval?: UserApprovalReceipt;
};

export type MessageAppendResult =
	| { replayed: false; message: RealtimeMessage }
	| { replayed: true; message: RealtimeMessage };

type MessageRow = {
	room: string;
	room_sequence: number;
	msg_id: string;
	sender_name: string;
	sender_presence_id: string;
	target_kind: string;
	target_names: string | null;
	target_presence_ids: string | null;
	encoding: string;
	data: string;
	attachments: string;
	user_approved: number;
	created_at: number;
	reply_to_sequence: number | null;
};

type RoomRow = {
	name: string;
	display_name: string | null;
	description: string | null;
	created_at: number;
	created_by_cwd: string | null;
};

type SequenceRow = { next_sequence: number };

const ROOMS_SCHEMA = `
	CREATE TABLE rooms (
		name TEXT PRIMARY KEY,
		display_name TEXT,
		description TEXT,
		created_at INTEGER NOT NULL,
		created_by_cwd TEXT
	)
`;

const ROOM_SEQUENCES_SCHEMA = `
	CREATE TABLE room_sequences (
		room TEXT PRIMARY KEY NOT NULL,
		next_sequence INTEGER NOT NULL
	)
`;

const MESSAGES_SCHEMA = `
	CREATE TABLE messages (
		room TEXT NOT NULL,
		room_sequence INTEGER NOT NULL,
		msg_id TEXT NOT NULL UNIQUE,
		sender_name TEXT NOT NULL,
		sender_presence_id TEXT NOT NULL,
		target_kind TEXT NOT NULL,
		target_names TEXT,
		target_presence_ids TEXT,
		encoding TEXT NOT NULL,
		data TEXT NOT NULL,
		attachments TEXT NOT NULL,
		user_approved INTEGER NOT NULL CHECK (user_approved IN (0, 1)),
		created_at INTEGER NOT NULL,
		reply_to_sequence INTEGER,
		PRIMARY KEY(room, room_sequence)
	)
`;

const MESSAGES_ROOM_SENDER_INDEX_SCHEMA =
	"CREATE INDEX messages_room_sender ON messages(room, sender_name, room_sequence)";

function normalizeSchema(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

function storedStringArray(value: string | null, label: string): string[] {
	if (value === null) throw new Error(`missing stored ${label}`);
	const parsed: unknown = JSON.parse(value);
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		parsed.some((entry) => typeof entry !== "string" || entry === "")
	) {
		throw new Error(`invalid stored ${label}`);
	}
	return parsed as string[];
}

const CURRENT_SCHEMA = [
	{
		type: "index",
		name: "messages_room_sender",
		sql: normalizeSchema(MESSAGES_ROOM_SENDER_INDEX_SCHEMA),
	},
	{
		type: "table",
		name: "messages",
		sql: normalizeSchema(MESSAGES_SCHEMA),
	},
	{
		type: "table",
		name: "room_sequences",
		sql: normalizeSchema(ROOM_SEQUENCES_SCHEMA),
	},
	{
		type: "table",
		name: "rooms",
		sql: normalizeSchema(ROOMS_SCHEMA),
	},
];

function assertRoomName(name: unknown): asserts name is string {
	if (typeof name !== "string" || !ROOM_NAME_RE.test(name)) {
		throw new Error(
			`invalid room name "${String(name)}" (use [a-zA-Z0-9._-], start alnum, max 64)`,
		);
	}
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string")
		throw new Error(`Room ${field} must be a string`);
	return value;
}

function toRoom(row: RoomRow): A2aRoom {
	return {
		name: row.name,
		displayName: row.display_name ?? undefined,
		description: row.description ?? undefined,
		createdAt: row.created_at,
		createdByCwd: row.created_by_cwd ?? undefined,
	};
}

export class HubStore {
	#database: Database;
	#allocateSequence;
	#deleteRoom;
	#findById;
	#findByRef;
	#findRoom;
	#insert;
	#insertRoom;
	#append;

	constructor(databasePath: string) {
		const databaseExisted = existsSync(databasePath);
		ensureDir(path.dirname(databasePath));
		this.#database = new Database(databasePath, { create: true });
		try {
			this.#initializeSchema(databaseExisted);
			this.#database.run("PRAGMA journal_mode = WAL");
			this.#database.run("PRAGMA synchronous = FULL");
			this.#allocateSequence = this.#database.query<SequenceRow, [string]>(`
				INSERT INTO room_sequences(room, next_sequence)
				VALUES (?, 1)
				ON CONFLICT(room) DO UPDATE
				SET next_sequence = next_sequence + 1
				RETURNING next_sequence
			`);
			this.#findById = this.#database.query<MessageRow, [string]>(
				"SELECT * FROM messages WHERE msg_id = ?",
			);
			this.#findByRef = this.#database.query<MessageRow, [string, number]>(
				"SELECT * FROM messages WHERE room = ? AND room_sequence = ?",
			);
			this.#findRoom = this.#database.query<RoomRow, [string]>(
				"SELECT * FROM rooms WHERE name = ?",
			);
			this.#insert = this.#database.query(`
				INSERT INTO messages(
					room, room_sequence, msg_id, sender_name, sender_presence_id,
					target_kind, target_names, target_presence_ids, encoding, data,
					attachments, user_approved, created_at, reply_to_sequence
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);
			this.#insertRoom = this.#database.query(`
				INSERT INTO rooms(
					name, display_name, description, created_at, created_by_cwd
				) VALUES (?, ?, ?, ?, ?)
			`);
			this.#deleteRoom = this.#database.transaction((room: string): boolean => {
				if (!this.#findRoom.get(room)) return false;
				this.#database.query("DELETE FROM messages WHERE room = ?").run(room);
				this.#database
					.query("DELETE FROM room_sequences WHERE room = ?")
					.run(room);
				this.#database.query("DELETE FROM rooms WHERE name = ?").run(room);
				return true;
			});
			this.#append = this.#database.transaction(
				(draft: MessageDraft): MessageAppendResult => {
					const attachments = this.#validateDraft(draft);
					if (!this.#findRoom.get(draft.room)) {
						throw new UnknownRoomError(`unknown room: ${draft.room}`);
					}
					const replyToSequence = this.#resolveReply(draft.room, draft.replyTo);
					const existing = this.#findById.get(draft.messageId);
					if (existing) {
						if (!this.#matches(existing, draft, attachments, replyToSequence)) {
							throw new MessageIdConflictError(
								`messageId already used with different content: ${draft.messageId}`,
							);
						}
						return { replayed: true, message: this.#toMessage(existing) };
					}
					const sequence = this.#allocateSequence.get(
						draft.room,
					)?.next_sequence;
					if (!sequence)
						throw new Error(
							`failed to allocate message sequence for ${draft.room}`,
						);
					this.#insert.run(
						draft.room,
						sequence,
						draft.messageId,
						draft.from.name,
						draft.from.presenceId,
						draft.target.type,
						draft.target.type === "agents"
							? JSON.stringify(draft.target.names)
							: null,
						draft.target.type === "agents" && draft.target.presenceIds
							? JSON.stringify(draft.target.presenceIds)
							: null,
						draft.payload.encoding,
						draft.payload.data,
						JSON.stringify(attachments),
						draft.userApproval === undefined ? 0 : 1,
						draft.createdAt,
						replyToSequence,
					);
					return {
						replayed: false,
						message: {
							messageId: draft.messageId,
							messageRef: formatMessageRef(draft.room, sequence),
							room: draft.room,
							sequence,
							from: { ...draft.from },
							target: { ...draft.target },
							payload: { ...draft.payload },
							attachments: attachments.map((attachment) => ({
								name: attachment.name,
								payload: { ...attachment.payload },
							})),
							createdAt: draft.createdAt,
							replyTo: draft.replyTo,
							userApproval:
								draft.userApproval === undefined
									? undefined
									: { kind: "omp-ui" },
						},
					};
				},
			);
		} catch (error) {
			this.#database.close();
			throw error;
		}
	}

	replay(
		draft: MessageDraft,
	): Extract<MessageAppendResult, { replayed: true }> | null {
		const existing = this.#findById.get(draft.messageId);
		if (!existing) return null;
		const attachments = this.#validateDraft(draft);
		const replyToSequence = this.#resolveReply(draft.room, draft.replyTo);
		if (!this.#matches(existing, draft, attachments, replyToSequence)) {
			throw new MessageIdConflictError(
				`messageId already used with different content: ${draft.messageId}`,
			);
		}
		return { replayed: true, message: this.#toMessage(existing) };
	}

	createRoom(options: {
		name: string;
		displayName?: string;
		description?: string;
		createdByCwd?: string;
	}): A2aRoom {
		assertRoomName(options.name);
		const displayName = optionalString(options.displayName, "displayName");
		const description = optionalString(options.description, "description");
		const createdByCwd = optionalString(options.createdByCwd, "createdByCwd");
		if (this.#findRoom.get(options.name)) {
			throw new RoomConflictError(`room already exists: ${options.name}`);
		}
		const room: A2aRoom = {
			name: options.name,
			displayName,
			description,
			createdAt: Date.now(),
			createdByCwd,
		};
		this.#insertRoom.run(
			room.name,
			room.displayName ?? null,
			room.description ?? null,
			room.createdAt,
			room.createdByCwd ?? null,
		);
		return room;
	}

	getRoom(name: string): A2aRoom | null {
		assertRoomName(name);
		const row = this.#findRoom.get(name);
		return row ? toRoom(row) : null;
	}

	listRooms(): A2aRoom[] {
		return this.#database
			.query<RoomRow, []>("SELECT * FROM rooms")
			.all()
			.map(toRoom)
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	deleteRoom(room: string): boolean {
		assertRoomName(room);
		return this.#deleteRoom.immediate(room);
	}

	append(draft: MessageDraft): MessageAppendResult {
		return this.#append(draft);
	}

	get(reference: string): RealtimeMessage | null {
		const parsed = parseMessageRef(reference);
		const row = this.#findByRef.get(parsed.room, parsed.sequence);
		return row ? this.#toMessage(row) : null;
	}

	history(query: HistoryQuery): HistoryPage {
		if (!ROOM_NAME_RE.test(query.room))
			throw new Error(`invalid room: ${query.room}`);
		if (!this.#findRoom.get(query.room)) {
			throw new UnknownRoomError(`unknown room: ${query.room}`);
		}
		if (query.before && query.after)
			throw new Error("history accepts before or after, not both");
		if (query.from !== undefined && !AGENT_NAME_RE.test(query.from))
			throw new Error(`invalid name: ${query.from}`);
		const limit = query.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit <= 0)
			throw new Error("history limit must be a positive integer");
		const params: Array<string | number> = [query.room];
		const predicates = ["room = ?"];
		let ascending = false;
		if (query.before) {
			const ref = parseMessageRef(query.before);
			if (ref.room !== query.room)
				throw new Error("history cursor belongs to another room");
			predicates.push("room_sequence < ?");
			params.push(ref.sequence);
		} else if (query.after) {
			const ref = parseMessageRef(query.after);
			if (ref.room !== query.room)
				throw new Error("history cursor belongs to another room");
			predicates.push("room_sequence > ?");
			params.push(ref.sequence);
			ascending = true;
		}
		if (query.from) {
			predicates.push("sender_name = ?");
			params.push(query.from);
		}
		const order = ascending ? "ASC" : "DESC";
		params.push(limit);
		const rows = this.#database
			.query<MessageRow, Array<string | number>>(
				`SELECT * FROM messages
				WHERE ${predicates.join(" AND ")}
				ORDER BY room_sequence ${order}
				LIMIT ?`,
			)
			.all(...params);
		if (!ascending) rows.reverse();
		return { messages: rows.map((row) => this.#toMessage(row)) };
	}

	integrityCheck(): string {
		return (
			this.#database
				.query<{ integrity_check: string }, []>("PRAGMA integrity_check")
				.get()?.integrity_check ?? "unknown"
		);
	}

	close(): void {
		this.#database.close();
	}

	#initializeSchema(databaseExisted: boolean): void {
		this.#database.transaction(() => {
			const schema = this.#database
				.query<{ type: string; name: string; sql: string | null }, []>(
					"SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
				)
				.all()
				.map(({ type, name, sql }) => ({
					type,
					name,
					sql: normalizeSchema(sql ?? ""),
				}));
			const version =
				this.#database
					.query<{ user_version: number }, []>("PRAGMA user_version")
					.get()?.user_version ?? 0;
			if (schema.length === 0 && version === 0) {
				if (databaseExisted) throw new Error(UNSUPPORTED_STORAGE_MESSAGE);
				this.#database.run(ROOMS_SCHEMA);
				this.#database.run(ROOM_SEQUENCES_SCHEMA);
				this.#database.run(MESSAGES_SCHEMA);
				this.#database.run(MESSAGES_ROOM_SENDER_INDEX_SCHEMA);
				this.#database.run(`PRAGMA user_version = ${MESSAGE_STORAGE_VERSION}`);
				return;
			}
			if (
				version !== MESSAGE_STORAGE_VERSION ||
				JSON.stringify(schema) !== JSON.stringify(CURRENT_SCHEMA)
			) {
				throw new Error(UNSUPPORTED_STORAGE_MESSAGE);
			}
		})();
	}

	#resolveReply(room: string, replyTo: string | undefined): number | null {
		if (!replyTo) return null;
		const parsed = parseMessageRef(replyTo);
		if (parsed.room !== room)
			throw new UnknownReplyTargetError("replyTo belongs to another room");
		if (!this.#findByRef.get(room, parsed.sequence))
			throw new UnknownReplyTargetError(`unknown replyTo: ${replyTo}`);
		return parsed.sequence;
	}

	#validateDraft(draft: MessageDraft): EncodedAttachment[] {
		if (!MESSAGE_ID_RE.test(draft.messageId))
			throw new Error(`invalid messageId: ${draft.messageId}`);
		if (!ROOM_NAME_RE.test(draft.room))
			throw new Error(`invalid room: ${draft.room}`);
		if (!AGENT_NAME_RE.test(draft.from.name))
			throw new Error(`invalid sender name: ${draft.from.name}`);
		if (!draft.from.presenceId)
			throw new Error("sender presenceId is required");
		if (draft.target.type === "agents") {
			if (draft.target.names.length === 0)
				throw new Error("target names are required");
			if (new Set(draft.target.names).size !== draft.target.names.length)
				throw new Error("target names must be unique");
			for (const name of draft.target.names) {
				if (!AGENT_NAME_RE.test(name))
					throw new Error(`invalid recipient name: ${name}`);
			}
			const presenceIds = draft.target.presenceIds;
			if (presenceIds) {
				if (presenceIds.length !== draft.target.names.length)
					throw new Error("target presenceIds must match names");
				for (const presenceId of presenceIds) {
					if (!presenceId) throw new Error("recipient presenceId is required");
				}
			}
		}
		if (!Number.isSafeInteger(draft.createdAt) || draft.createdAt < 0)
			throw new Error("invalid createdAt");
		if (decodeTextPayload(draft.payload).trim().length === 0)
			throw new Error("message text required");
		if (draft.userApproval !== undefined)
			decodeUserApprovalReceipt(draft.userApproval, "message.userApproval");
		return parseEncodedAttachments(draft.attachments);
	}

	#matches(
		row: MessageRow,
		draft: MessageDraft,
		attachments: EncodedAttachment[],
		replyToSequence: number | null,
	): boolean {
		return (
			row.room === draft.room &&
			row.sender_name === draft.from.name &&
			row.target_kind === draft.target.type &&
			row.target_names ===
				(draft.target.type === "agents"
					? JSON.stringify(draft.target.names)
					: null) &&
			row.encoding === draft.payload.encoding &&
			row.data === draft.payload.data &&
			row.attachments === JSON.stringify(attachments) &&
			row.user_approved === (draft.userApproval === undefined ? 0 : 1) &&
			row.reply_to_sequence === replyToSequence
		);
	}

	#toMessage(row: MessageRow): RealtimeMessage {
		if (row.target_kind !== "agents" && row.target_kind !== "all") {
			throw new Error(`invalid stored target kind: ${row.target_kind}`);
		}
		const target: MessageTarget =
			row.target_kind === "agents"
				? {
						type: "agents",
						names: storedStringArray(row.target_names, "target names"),
						presenceIds:
							row.target_presence_ids === null
								? undefined
								: storedStringArray(
										row.target_presence_ids,
										"target presenceIds",
									),
					}
				: { type: "all" };
		const payload: EncodedTextPayload = {
			encoding: row.encoding as EncodedTextPayload["encoding"],
			data: row.data,
		};
		const attachments = parseEncodedAttachments(JSON.parse(row.attachments));
		return {
			messageId: row.msg_id,
			messageRef: formatMessageRef(row.room, row.room_sequence),
			room: row.room,
			sequence: row.room_sequence,
			from: {
				name: row.sender_name,
				presenceId: row.sender_presence_id,
			},
			target,
			payload,
			attachments,
			userApproval: row.user_approved === 1 ? { kind: "omp-ui" } : undefined,
			createdAt: row.created_at,
			replyTo:
				row.reply_to_sequence == null
					? undefined
					: formatMessageRef(row.room, row.reply_to_sequence),
		};
	}
}
