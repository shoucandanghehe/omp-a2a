import { Database } from "bun:sqlite";
import * as path from "node:path";
import { ensureDir } from "../paths";
import { AGENT_NAME_RE, PROJECT_NAME_RE } from "../types";
import { parseEncodedAttachments, validateMessageContent } from "./payload";
import type {
	HistoryPage,
	HistoryQuery,
	MessageTarget,
	RealtimeMessage,
} from "./realtime-types";
import type { EncodedAttachment, EncodedTextPayload } from "./types";

const MESSAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const MESSAGE_STORAGE_VERSION = 1;
const UNSUPPORTED_STORAGE_MESSAGE =
	"unsupported pre-release storage; start with an empty data directory";
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

export class MessageIdConflictError extends Error {}
export class UnknownReplyTargetError extends Error {}

export type MessageDraft = {
	messageId: string;
	project: string;
	from: { name: string; presenceId: string };
	target: MessageTarget;
	payload: EncodedTextPayload;
	attachments: EncodedAttachment[];
	createdAt: number;
	replyTo?: string;
};

type MessageRow = {
	project: string;
	project_sequence: number;
	msg_id: string;
	sender_name: string;
	sender_presence_id: string;
	target_kind: string;
	target_name: string | null;
	target_presence_id: string | null;
	encoding: string;
	data: string;
	uncompressed_bytes: number;
	attachments: string;
	content_bytes: number;
	created_at: number;
	reply_to_sequence: number | null;
};

type SequenceRow = { next_sequence: number };

const PROJECT_SEQUENCES_SCHEMA = `
	CREATE TABLE project_sequences (
		project TEXT PRIMARY KEY NOT NULL,
		next_sequence INTEGER NOT NULL
	)
`;

const MESSAGES_SCHEMA = `
	CREATE TABLE messages (
		project TEXT NOT NULL,
		project_sequence INTEGER NOT NULL,
		msg_id TEXT NOT NULL UNIQUE,
		sender_name TEXT NOT NULL,
		sender_presence_id TEXT NOT NULL,
		target_kind TEXT NOT NULL,
		target_name TEXT,
		target_presence_id TEXT,
		encoding TEXT NOT NULL,
		data TEXT NOT NULL,
		uncompressed_bytes INTEGER NOT NULL,
		attachments TEXT NOT NULL,
		content_bytes INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		reply_to_sequence INTEGER,
		PRIMARY KEY(project, project_sequence)
	)
`;

const MESSAGES_PROJECT_SENDER_INDEX_SCHEMA =
	"CREATE INDEX messages_project_sender ON messages(project, sender_name, project_sequence)";

function normalizeSchema(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

const CURRENT_SCHEMA = [
	{
		type: "index",
		name: "messages_project_sender",
		sql: normalizeSchema(MESSAGES_PROJECT_SENDER_INDEX_SCHEMA),
	},
	{
		type: "table",
		name: "messages",
		sql: normalizeSchema(MESSAGES_SCHEMA),
	},
	{
		type: "table",
		name: "project_sequences",
		sql: normalizeSchema(PROJECT_SEQUENCES_SCHEMA),
	},
];

type ParsedMessageRef = { project: string; sequence: number };

export function formatMessageRef(project: string, sequence: number): string {
	if (
		!PROJECT_NAME_RE.test(project) ||
		!Number.isSafeInteger(sequence) ||
		sequence <= 0
	) {
		throw new Error("invalid message reference components");
	}
	return `${project}:${sequence}`;
}

export function parseMessageRef(reference: string): ParsedMessageRef {
	const separator = reference.lastIndexOf(":");
	const project = reference.slice(0, separator);
	const sequenceText = reference.slice(separator + 1);
	const sequence = Number(sequenceText);
	if (
		separator <= 0 ||
		!PROJECT_NAME_RE.test(project) ||
		!/^[1-9]\d*$/.test(sequenceText) ||
		!Number.isSafeInteger(sequence)
	) {
		throw new Error(`invalid message reference: ${reference}`);
	}
	return { project, sequence };
}

export class MessageStore {
	#database: Database;
	#allocateSequence;
	#findById;
	#findByRef;
	#insert;
	#append;

	constructor(databasePath: string) {
		ensureDir(path.dirname(databasePath));
		this.#database = new Database(databasePath, { create: true });
		try {
			this.#initializeSchema();
		} catch (error) {
			this.#database.close();
			throw error;
		}
		this.#database.run("PRAGMA journal_mode = WAL");
		this.#database.run("PRAGMA synchronous = FULL");
		this.#allocateSequence = this.#database.query<SequenceRow, [string]>(`
			INSERT INTO project_sequences(project, next_sequence)
			VALUES (?, 1)
			ON CONFLICT(project) DO UPDATE
			SET next_sequence = next_sequence + 1
			RETURNING next_sequence
		`);
		this.#findById = this.#database.query<MessageRow, [string]>(
			"SELECT * FROM messages WHERE msg_id = ?",
		);
		this.#findByRef = this.#database.query<MessageRow, [string, number]>(
			"SELECT * FROM messages WHERE project = ? AND project_sequence = ?",
		);
		this.#insert = this.#database.query(`
			INSERT INTO messages(
				project, project_sequence, msg_id, sender_name, sender_presence_id,
				target_kind, target_name, target_presence_id, encoding, data,
				uncompressed_bytes, attachments, content_bytes, created_at,
				reply_to_sequence
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		this.#append = this.#database.transaction(
			(
				draft: MessageDraft,
			): { inserted: boolean; message: RealtimeMessage } => {
				const { attachments, contentBytes } = this.#validateDraft(draft);
				const replyToSequence = this.#resolveReply(
					draft.project,
					draft.replyTo,
				);
				const existing = this.#findById.get(draft.messageId);
				if (existing) {
					if (!this.#matches(existing, draft, attachments, replyToSequence)) {
						throw new MessageIdConflictError(
							`messageId already used with different content: ${draft.messageId}`,
						);
					}
					return { inserted: false, message: this.#toMessage(existing) };
				}
				const sequence = this.#allocateSequence.get(
					draft.project,
				)?.next_sequence;
				if (!sequence)
					throw new Error(
						`failed to allocate message sequence for ${draft.project}`,
					);
				this.#insert.run(
					draft.project,
					sequence,
					draft.messageId,
					draft.from.name,
					draft.from.presenceId,
					draft.target.type,
					draft.target.type === "agent" ? draft.target.name : null,
					draft.target.type === "agent"
						? (draft.target.presenceId ?? null)
						: null,
					draft.payload.encoding,
					draft.payload.data,
					draft.payload.uncompressedBytes,
					JSON.stringify(attachments),
					contentBytes,
					draft.createdAt,
					replyToSequence,
				);
				return {
					inserted: true,
					message: {
						messageId: draft.messageId,
						messageRef: formatMessageRef(draft.project, sequence),
						project: draft.project,
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
					},
				};
			},
		);
	}

	append(draft: MessageDraft): { inserted: boolean; message: RealtimeMessage } {
		return this.#append(draft);
	}

	get(reference: string): RealtimeMessage | null {
		const parsed = parseMessageRef(reference);
		const row = this.#findByRef.get(parsed.project, parsed.sequence);
		return row ? this.#toMessage(row) : null;
	}

	history(query: HistoryQuery): HistoryPage {
		if (!PROJECT_NAME_RE.test(query.project))
			throw new Error(`invalid project: ${query.project}`);
		if (query.before && query.after)
			throw new Error("history accepts before or after, not both");
		if (query.from !== undefined && !AGENT_NAME_RE.test(query.from))
			throw new Error(`invalid name: ${query.from}`);
		const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 500);
		const params: Array<string | number> = [query.project];
		const predicates = ["project = ?"];
		let ascending = false;
		if (query.before) {
			const ref = parseMessageRef(query.before);
			if (ref.project !== query.project)
				throw new Error("history cursor belongs to another project");
			predicates.push("project_sequence < ?");
			params.push(ref.sequence);
		} else if (query.after) {
			const ref = parseMessageRef(query.after);
			if (ref.project !== query.project)
				throw new Error("history cursor belongs to another project");
			predicates.push("project_sequence > ?");
			params.push(ref.sequence);
			ascending = true;
		}
		if (query.from) {
			predicates.push("sender_name = ?");
			params.push(query.from);
		}
		const order = ascending ? "ASC" : "DESC";
		params.push(MAX_HISTORY_BYTES, limit);
		const rows = this.#database
			.query<MessageRow & { cumulative_bytes: number }, Array<string | number>>(
				`SELECT * FROM (
					SELECT messages.*, SUM(content_bytes) OVER (ORDER BY project_sequence ${order}) AS cumulative_bytes
					FROM messages
					WHERE ${predicates.join(" AND ")}
				)
				WHERE cumulative_bytes <= ?
				ORDER BY project_sequence ${order}
				LIMIT ?`,
			)
			.all(...params);
		if (!ascending) rows.reverse();
		return { messages: rows.map((row) => this.#toMessage(row)) };
	}

	deleteProject(project: string): void {
		this.#database.transaction(() => {
			this.#database
				.query("DELETE FROM messages WHERE project = ?")
				.run(project);
			this.#database
				.query("DELETE FROM project_sequences WHERE project = ?")
				.run(project);
		})();
	}

	close(): void {
		this.#database.close();
	}

	#initializeSchema(): void {
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
				this.#database.run(PROJECT_SEQUENCES_SCHEMA);
				this.#database.run(MESSAGES_SCHEMA);
				this.#database.run(MESSAGES_PROJECT_SENDER_INDEX_SCHEMA);
				this.#database.run(
					`PRAGMA user_version = ${MESSAGE_STORAGE_VERSION}`,
				);
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

	#resolveReply(project: string, replyTo: string | undefined): number | null {
		if (!replyTo) return null;
		const parsed = parseMessageRef(replyTo);
		if (parsed.project !== project)
			throw new UnknownReplyTargetError("replyTo belongs to another project");
		if (!this.#findByRef.get(project, parsed.sequence))
			throw new UnknownReplyTargetError(`unknown replyTo: ${replyTo}`);
		return parsed.sequence;
	}

	#validateDraft(draft: MessageDraft): {
		attachments: EncodedAttachment[];
		contentBytes: number;
	} {
		if (!MESSAGE_ID_RE.test(draft.messageId))
			throw new Error(`invalid messageId: ${draft.messageId}`);
		if (!PROJECT_NAME_RE.test(draft.project))
			throw new Error(`invalid project: ${draft.project}`);
		if (!AGENT_NAME_RE.test(draft.from.name))
			throw new Error(`invalid sender name: ${draft.from.name}`);
		if (!draft.from.presenceId)
			throw new Error("sender presenceId is required");
		if (
			draft.target.type === "agent" &&
			!AGENT_NAME_RE.test(draft.target.name)
		) {
			throw new Error(`invalid recipient name: ${draft.target.name}`);
		}
		if (!Number.isSafeInteger(draft.createdAt) || draft.createdAt < 0)
			throw new Error("invalid createdAt");
		return validateMessageContent(draft.payload, draft.attachments);
	}

	#matches(
		row: MessageRow,
		draft: MessageDraft,
		attachments: EncodedAttachment[],
		replyToSequence: number | null,
	): boolean {
		return (
			row.project === draft.project &&
			row.sender_name === draft.from.name &&
			row.target_kind === draft.target.type &&
			row.target_name ===
				(draft.target.type === "agent" ? draft.target.name : null) &&
			row.encoding === draft.payload.encoding &&
			row.data === draft.payload.data &&
			row.uncompressed_bytes === draft.payload.uncompressedBytes &&
			row.attachments === JSON.stringify(attachments) &&
			row.reply_to_sequence === replyToSequence
		);
	}

	#toMessage(row: MessageRow): RealtimeMessage {
		if (row.target_kind !== "agent" && row.target_kind !== "project") {
			throw new Error(`invalid stored target kind: ${row.target_kind}`);
		}
		const target: MessageTarget =
			row.target_kind === "agent"
				? {
						type: "agent",
						name: row.target_name ?? "",
						presenceId: row.target_presence_id ?? undefined,
					}
				: { type: "project" };
		const payload: EncodedTextPayload = {
			encoding: row.encoding as EncodedTextPayload["encoding"],
			data: row.data,
			uncompressedBytes: row.uncompressed_bytes,
		};
		const attachments = parseEncodedAttachments(JSON.parse(row.attachments));
		const contentBytes =
			payload.uncompressedBytes +
			attachments.reduce(
				(total, attachment) => total + attachment.payload.uncompressedBytes,
				0,
			);
		if (contentBytes !== row.content_bytes)
			throw new Error("stored message content size does not match metadata");
		return {
			messageId: row.msg_id,
			messageRef: formatMessageRef(row.project, row.project_sequence),
			project: row.project,
			sequence: row.project_sequence,
			from: {
				name: row.sender_name,
				presenceId: row.sender_presence_id,
			},
			target,
			payload,
			attachments,
			createdAt: row.created_at,
			replyTo:
				row.reply_to_sequence == null
					? undefined
					: formatMessageRef(row.project, row.reply_to_sequence),
		};
	}
}
