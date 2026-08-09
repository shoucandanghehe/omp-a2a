import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../paths";
import { AGENT_NAME_RE, PROJECT_NAME_RE } from "../types";
import {
	decodeTextPayload,
	parseEncodedAttachments,
	validateMessageContent,
} from "./payload";
import type {
	HistoryPage,
	HistoryQuery,
	MessageTarget,
	RealtimeMessage,
} from "./realtime-types";
import type { EncodedAttachment, EncodedTextPayload } from "./types";

const MESSAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
export const MAX_HISTORY_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_HISTORY_LIMIT = 500;
const LEGACY_MIGRATION_KEY = "legacy_message_ledger_migrated";

export class MessageIdConflictError extends Error {}
export class UnknownReplyTargetError extends Error {}
export class MessageValidationError extends Error {}

export type RecipientSnapshot = { name: string; presenceId: string };

export type MessageDraft = {
	messageId: string;
	project: string;
	from: { name: string; presenceId: string };
	target: MessageTarget;
	payload: EncodedTextPayload;
	attachments: EncodedAttachment[];
	createdAt: number;
	replyTo?: string;
	recipients?: RecipientSnapshot[];
};

export type MessageAppendResult = {
	inserted: boolean;
	message: RealtimeMessage;
	recipients: RecipientSnapshot[];
};

export type MessageRetryResult = MessageAppendResult & { inserted: false };

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
	uncompressed_bytes: number;
	attachments: string;
	content_bytes: number;
	created_at: number;
	reply_to_sequence: number | null;
};

type RecipientRow = {
	name: string;
	presence_id: string;
};

type SequenceRow = { next_sequence: number };

type LegacyMessageRow = {
	msg_id: string;
	project: string;
	sender: string;
	recipient: string;
	encoding: string;
	data: string;
	uncompressed_bytes: number;
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
	#insertRecipient;
	#findRecipients;
	#append;

	constructor(databasePath: string, options?: { legacyDatabasePath?: string }) {
		ensureDir(path.dirname(databasePath));
		this.#database = new Database(databasePath, { create: true });
		this.#database.run("PRAGMA journal_mode = WAL");
		this.#database.run("PRAGMA synchronous = FULL");
		const tableExists = this.#database.query<{ name: string }, [string]>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		);
		const hadMessagesTable = tableExists.get("messages") != null;
		const hadMetadataTable =
			tableExists.get("message_store_metadata") != null;
		this.#database.transaction(() => {
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
					uncompressed_bytes INTEGER NOT NULL,
					attachments TEXT NOT NULL DEFAULT '[]',
					content_bytes INTEGER,
					created_at INTEGER NOT NULL,
					reply_to_sequence INTEGER,
					PRIMARY KEY(project, project_sequence)
				)
			`);
			this.#migrateSchema();
			this.#database.run(
				"CREATE INDEX IF NOT EXISTS messages_project_sender ON messages(project, sender_name, project_sequence)",
			);
			this.#database.run(`
				CREATE TABLE IF NOT EXISTS message_recipients (
					msg_id TEXT NOT NULL,
					ordinal INTEGER NOT NULL,
					name TEXT NOT NULL,
					presence_id TEXT NOT NULL,
					PRIMARY KEY(msg_id, ordinal),
					FOREIGN KEY(msg_id) REFERENCES messages(msg_id) ON DELETE CASCADE
				)
			`);
			this.#database.run(`
				CREATE TABLE IF NOT EXISTS message_store_metadata (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				)
			`);
			if (hadMessagesTable && !hadMetadataTable) {
				this.#database
					.query(
						"INSERT INTO message_store_metadata(key, value) VALUES (?, ?)",
					)
					.run(LEGACY_MIGRATION_KEY, "1");
			}
			this.#database.run(`
				INSERT OR IGNORE INTO message_recipients(msg_id, ordinal, name, presence_id)
				SELECT msg_id, 0, target_name, target_presence_id
				FROM messages
				WHERE target_kind = 'agent'
					AND target_name IS NOT NULL
					AND target_presence_id IS NOT NULL
			`);
		})();
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
		this.#insertRecipient = this.#database.query(`
			INSERT INTO message_recipients(msg_id, ordinal, name, presence_id)
			VALUES (?, ?, ?, ?)
		`);
		this.#findRecipients = this.#database.query<RecipientRow, [string]>(
			"SELECT name, presence_id FROM message_recipients WHERE msg_id = ? ORDER BY ordinal",
		);
		this.#append = this.#database.transaction(
			(
				draft: MessageDraft,
			): MessageAppendResult => {
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
					return {
						inserted: false,
						message: this.#toMessage(existing),
						recipients: this.#recipients(existing.msg_id),
					};
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
				const recipients = this.#draftRecipients(draft);
				for (const [ordinal, recipient] of recipients.entries()) {
					this.#insertRecipient.run(
						draft.messageId,
						ordinal,
						recipient.name,
						recipient.presenceId,
					);
				}
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
					recipients,
				};
			},
		);
		if (
			options?.legacyDatabasePath &&
			fs.existsSync(options.legacyDatabasePath)
		) {
			try {
				this.#migrateLegacy(options.legacyDatabasePath);
			} catch (error) {
				this.#database.close();
				throw error;
			}
		}
	}

	append(draft: MessageDraft): MessageAppendResult {
		return this.#append(draft);
	}

	findRetry(
		draft: Omit<MessageDraft, "createdAt" | "recipients">,
	): MessageRetryResult | null {
		const { attachments } = this.#validateDraft({ ...draft, createdAt: 0 });
		const replyToSequence = this.#resolveReply(draft.project, draft.replyTo);
		const existing = this.#findById.get(draft.messageId);
		if (!existing) return null;
		if (!this.#matches(existing, draft, attachments, replyToSequence)) {
			throw new MessageIdConflictError(
				`messageId already used with different content: ${draft.messageId}`,
			);
		}
		return {
			inserted: false,
			message: this.#toMessage(existing),
			recipients: this.#recipients(existing.msg_id),
		};
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
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
			throw new MessageValidationError(
				`history limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`,
			);
		}
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
		const firstStatement = this.#database.query<
			MessageRow,
			Array<string | number>
		>(
			`SELECT *
			FROM messages
			WHERE ${predicates.join(" AND ")}
			ORDER BY project_sequence ${order}
			LIMIT 1`,
		);
		const nextStatement = this.#database.query<
			MessageRow,
			Array<string | number>
		>(
			`SELECT *
			FROM messages
			WHERE ${predicates.join(" AND ")}
				AND project_sequence ${ascending ? ">" : "<"} ?
			ORDER BY project_sequence ${order}
			LIMIT 1`,
		);
		const selected: RealtimeMessage[] = [];
		let decodedBytes = 0;
		let responseBytes = Buffer.byteLength('{"messages":[]}', "utf8");
		let row = firstStatement.get(...params);
		for (let index = 0; row && index < limit; index++) {
			if (
				!Number.isSafeInteger(row.content_bytes) ||
				row.content_bytes < 0
			) {
				throw new Error(`invalid stored content size: ${row.msg_id}`);
			}
			const candidateDecodedBytes = decodedBytes + row.content_bytes;
			if (candidateDecodedBytes > MAX_HISTORY_BYTES) break;
			const message = this.#toMessage(row);
			const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
			const separatorBytes = selected.length === 0 ? 0 : 1;
			const candidateResponseBytes =
				responseBytes + messageBytes + separatorBytes;
			if (candidateResponseBytes > MAX_HISTORY_RESPONSE_BYTES) break;
			selected.push(message);
			decodedBytes = candidateDecodedBytes;
			responseBytes = candidateResponseBytes;
			row = nextStatement.get(...params, row.project_sequence);
		}
		if (!ascending) selected.reverse();
		return { messages: selected };
	}

	deleteProject(project: string): void {
		this.#database.transaction(() => {
			this.#database
				.query(
					"DELETE FROM message_recipients WHERE msg_id IN (SELECT msg_id FROM messages WHERE project = ?)",
				)
				.run(project);
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
		const migrationComplete =
			this.#database
				.query<{ value: string }, [string]>(
					"SELECT value FROM message_store_metadata WHERE key = ?",
				)
				.get(LEGACY_MIGRATION_KEY) != null;
		if (migrationComplete) return;

		const legacy = new Database(legacyDatabasePath);
		try {
			const hasLedger =
				legacy
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_ledger'",
					)
					.get() != null;
			if (!hasLedger) return;
			const expectedRows =
				legacy
					.query<{ count: number }, []>(
						"SELECT COUNT(*) AS count FROM message_ledger",
					)
					.get()?.count ?? 0;
			let migratedRows = 0;

			const selectRows = legacy.query<LegacyMessageRow, []>(
				`SELECT msg_id, project, sender, recipient, encoding, data,
					uncompressed_bytes, created_at, reply_to
				FROM message_ledger
				ORDER BY project, created_at, msg_id`,
			);
			const updateReply = this.#database.query(
				"UPDATE messages SET reply_to_sequence = ? WHERE msg_id = ?",
			);
			this.#database.transaction(() => {
				for (const row of selectRows.iterate()) {
					decodeTextPayload({
						encoding: row.encoding as EncodedTextPayload["encoding"],
						data: row.data,
						uncompressedBytes: row.uncompressed_bytes,
					});
					const sequence = this.#allocateSequence.get(
						row.project,
					)?.next_sequence;
					if (!sequence) {
						throw new Error(
							`failed to allocate migrated sequence for ${row.project}`,
						);
					}
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
						row.uncompressed_bytes,
						"[]",
						row.uncompressed_bytes,
						row.created_at,
						null,
					);
					this.#insertRecipient.run(
						row.msg_id,
						0,
						row.recipient,
						"legacy",
					);
					migratedRows++;
				}

				for (const row of selectRows.iterate()) {
					if (!row.reply_to) continue;
					const message = this.#findById.get(row.msg_id);
					const parent = this.#findById.get(row.reply_to);
					if (!message || !parent || parent.project !== message.project) {
						throw new Error(
							`cannot migrate reply ${row.msg_id}: missing parent ${row.reply_to}`,
						);
					}
					updateReply.run(parent.project_sequence, row.msg_id);
				}
				if (migratedRows !== expectedRows) {
					throw new Error(
						`legacy migration row count mismatch: expected ${expectedRows}, migrated ${migratedRows}`,
					);
				}
				const integrity =
					this.#database
						.query<{ integrity_check: string }, []>("PRAGMA integrity_check")
						.get()?.integrity_check ?? "unknown";
				if (integrity !== "ok") {
					throw new Error(`message database integrity check failed: ${integrity}`);
				}
				this.#database
					.query(
						"INSERT INTO message_store_metadata(key, value) VALUES (?, ?)",
					)
					.run(LEGACY_MIGRATION_KEY, "1");
			})();
		} finally {
			legacy.close();
		}
	}

	#migrateSchema(): void {
		const columns = new Set(
			this.#database
				.query<{ name: string }, []>("PRAGMA table_info(messages)")
				.all()
				.map((column) => column.name),
		);
		if (!columns.has("attachments")) {
			this.#database.run(
				"ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
			);
		}
		if (!columns.has("content_bytes")) {
			this.#database.run(
				"ALTER TABLE messages ADD COLUMN content_bytes INTEGER",
			);
		}
		this.#database.run(
			"UPDATE messages SET content_bytes = uncompressed_bytes WHERE content_bytes IS NULL",
		);
	}

	#resolveReply(project: string, replyTo: string | undefined): number | null {
		if (replyTo === undefined) return null;
		if (replyTo.trim().length === 0) {
			throw new MessageValidationError("replyTo must not be blank");
		}
		let parsed: ParsedMessageRef;
		try {
			parsed = parseMessageRef(replyTo);
		} catch {
			throw new MessageValidationError(`invalid replyTo: ${replyTo}`);
		}
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
			throw new MessageValidationError(`invalid messageId: ${draft.messageId}`);
		if (!PROJECT_NAME_RE.test(draft.project))
			throw new MessageValidationError(`invalid project: ${draft.project}`);
		if (!AGENT_NAME_RE.test(draft.from.name))
			throw new MessageValidationError(`invalid sender name: ${draft.from.name}`);
		if (!draft.from.presenceId)
			throw new MessageValidationError("sender presenceId is required");
		if (
			draft.target.type === "agent" &&
			!AGENT_NAME_RE.test(draft.target.name)
		) {
			throw new MessageValidationError(
				`invalid recipient name: ${draft.target.name}`,
			);
		}
		if (!Number.isSafeInteger(draft.createdAt) || draft.createdAt < 0)
			throw new MessageValidationError("invalid createdAt");
		if (draft.replyTo !== undefined && draft.replyTo.trim().length === 0)
			throw new MessageValidationError("replyTo must not be blank");
		for (const recipient of draft.recipients ?? []) {
			if (!AGENT_NAME_RE.test(recipient.name) || !recipient.presenceId) {
				throw new MessageValidationError("invalid recipient snapshot");
			}
		}
		return validateMessageContent(draft.payload, draft.attachments);
	}

	#matches(
		row: MessageRow,
		draft: Omit<MessageDraft, "createdAt" | "recipients">,
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

	#draftRecipients(draft: MessageDraft): RecipientSnapshot[] {
		if (draft.recipients) {
			return draft.recipients.map((recipient) => ({ ...recipient }));
		}
		if (draft.target.type === "agent" && draft.target.presenceId) {
			return [
				{
					name: draft.target.name,
					presenceId: draft.target.presenceId,
				},
			];
		}
		return [];
	}

	#recipients(messageId: string): RecipientSnapshot[] {
		return this.#findRecipients
			.all(messageId)
			.map((row) => ({ name: row.name, presenceId: row.presence_id }));
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
