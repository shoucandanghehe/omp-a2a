import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../paths";
import { AGENT_NAME_RE, PROJECT_NAME_RE } from "../types";
import { decodeTextPayload, parseEncodedAttachments } from "./payload";
import type {
	HistoryPage,
	HistoryQuery,
	MessageTarget,
	RealtimeMessage,
} from "./realtime-types";
import type { EncodedAttachment, EncodedTextPayload } from "./types";

const MESSAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

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
	sender_presence_id: string | null;
	target_kind: string;
	target_name: string | null;
	target_presence_id: string | null;
	encoding: string;
	data: string;
	attachments: string;
	created_at: number;
	reply_to_sequence: number | null;
};

type SequenceRow = { next_sequence: number };

type LegacyMessageRow = {
	msg_id: string;
	project: string;
	sender: string;
	recipient: string;
	encoding: string;
	data: string;
	created_at: number;
	reply_to: string | null;
};

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

	constructor(databasePath: string, options?: { legacyDatabasePath?: string }) {
		ensureDir(path.dirname(databasePath));
		this.#database = new Database(databasePath, { create: true });
		this.#database.run("PRAGMA journal_mode = WAL");
		this.#database.run("PRAGMA synchronous = FULL");
		this.#database.run(`
			CREATE TABLE IF NOT EXISTS project_sequences (
				project TEXT PRIMARY KEY,
				next_sequence INTEGER NOT NULL
			)
		`);
		this.#database.run(`
			CREATE TABLE IF NOT EXISTS messages (
				project TEXT NOT NULL,
				project_sequence INTEGER NOT NULL,
				msg_id TEXT NOT NULL UNIQUE,
				sender_name TEXT NOT NULL,
				sender_presence_id TEXT,
				target_kind TEXT NOT NULL,
				target_name TEXT,
				target_presence_id TEXT,
				encoding TEXT NOT NULL,
				data TEXT NOT NULL,
				attachments TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				reply_to_sequence INTEGER,
				PRIMARY KEY(project, project_sequence)
			)
		`);
		this.#database.run(
			"CREATE INDEX IF NOT EXISTS messages_project_sender ON messages(project, sender_name, project_sequence)",
		);
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
				attachments, created_at, reply_to_sequence
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		this.#append = this.#database.transaction(
			(
				draft: MessageDraft,
			): { inserted: boolean; message: RealtimeMessage } => {
				const attachments = this.#validateDraft(draft);
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
					JSON.stringify(attachments),
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
						payload: {
							encoding: draft.payload.encoding,
							data: draft.payload.data,
						},
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
		if (
			options?.legacyDatabasePath &&
			fs.existsSync(options.legacyDatabasePath)
		) {
			this.#migrateLegacy(options.legacyDatabasePath);
		}
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
		const limit = query.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit <= 0)
			throw new Error("history limit must be a positive integer");
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
		params.push(limit);
		const rows = this.#database
			.query<MessageRow, Array<string | number>>(
				`SELECT * FROM messages
				WHERE ${predicates.join(" AND ")}
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

	#migrateLegacy(legacyDatabasePath: string): void {
		const existingCount =
			this.#database
				.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM messages")
				.get()?.count ?? 0;
		if (existingCount > 0) return;
		const legacy = new Database(legacyDatabasePath);
		try {
			const hasLedger =
				legacy
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_ledger'",
					)
					.get() != null;
			if (!hasLedger) return;
			const rows = legacy
				.query<LegacyMessageRow, []>(
					"SELECT msg_id, project, sender, recipient, encoding, data, created_at, reply_to FROM message_ledger ORDER BY project, created_at, msg_id",
				)
				.all();
			const updateReply = this.#database.query(
				"UPDATE messages SET reply_to_sequence = ? WHERE project = ? AND project_sequence = ?",
			);
			this.#database.transaction(() => {
				const migrated = new Map<
					string,
					{ project: string; sequence: number }
				>();
				for (const row of rows) {
					const sequence = this.#allocateSequence.get(
						row.project,
					)?.next_sequence;
					if (!sequence)
						throw new Error(
							`failed to allocate migrated sequence for ${row.project}`,
						);
					this.#insert.run(
						row.project,
						sequence,
						row.msg_id,
						row.sender,
						null,
						"agent",
						row.recipient,
						null,
						row.encoding,
						row.data,
						"[]",
						row.created_at,
						null,
					);
					migrated.set(row.msg_id, { project: row.project, sequence });
				}
				for (const row of rows) {
					if (!row.reply_to) continue;
					const message = migrated.get(row.msg_id);
					const parent = migrated.get(row.reply_to);
					if (!message || !parent || parent.project !== message.project) {
						throw new Error(
							`cannot migrate reply ${row.msg_id}: missing parent ${row.reply_to}`,
						);
					}
					updateReply.run(parent.sequence, message.project, message.sequence);
				}
			})();
		} finally {
			legacy.close();
		}
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

	#validateDraft(draft: MessageDraft): EncodedAttachment[] {
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
		const text = decodeTextPayload(draft.payload);
		if (text.trim().length === 0) throw new Error("message text required");
		return parseEncodedAttachments(draft.attachments);
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
		};
		decodeTextPayload(payload);
		const attachments = parseEncodedAttachments(JSON.parse(row.attachments));
		return {
			messageId: row.msg_id,
			messageRef: formatMessageRef(row.project, row.project_sequence),
			project: row.project,
			sequence: row.project_sequence,
			from: {
				name: row.sender_name,
				presenceId: row.sender_presence_id ?? "legacy",
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
