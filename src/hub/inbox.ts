import { Database } from "bun:sqlite";
import * as path from "node:path";
import { ensureDir } from "../paths";
import { formatMessageRef, parseMessageRef } from "./message-ref";
import { encodeTextPayload } from "./payload";
import type {
	EncodedTextPayload,
	HubAckBatch,
	HubWireEnvelope,
	HubWireMessageDraft,
	HubWireInboxBatch,
	HubWireMessageEnvelope,
} from "./types";

export const MAX_INBOX_BATCH_MESSAGES = 1000;
export const MAX_INBOX_BATCH_ESTIMATED_BYTES = 8 * 1024 * 1024;
export const MAX_ACK_BATCH_MESSAGES = 1000;
export const RECEIPT_ID_PREFIX = "receipt:";
export const LEGACY_SEQUENCE_MIGRATION_BATCH_SIZE = 256;

const JSON_ENVELOPE_FIXED_ESTIMATED_BYTES = 512;

type MessageSizeRow = Omit<MessageRow, "data"> & { data_bytes: number };

function jsonSafeStringEstimatedBytes(value: string | null): number {
	return value === null ? 0 : Buffer.byteLength(value, "utf8") * 6;
}

function estimatedEnvelopeBytes(row: MessageSizeRow): number {
	const dataBytes = row.data_bytes * 6;
	return (
		JSON_ENVELOPE_FIXED_ESTIMATED_BYTES +
		dataBytes +
		jsonSafeStringEstimatedBytes(row.msg_id) +
		jsonSafeStringEstimatedBytes(row.kind) +
		jsonSafeStringEstimatedBytes(row.project) +
		jsonSafeStringEstimatedBytes(row.sender) * 2 +
		jsonSafeStringEstimatedBytes(row.recipient) * 3 +
		jsonSafeStringEstimatedBytes(row.encoding) +
		jsonSafeStringEstimatedBytes(row.reply_to) +
		jsonSafeStringEstimatedBytes(row.receipt_for)
	);
}

type MessageRow = {
	msg_id: string;
	kind: string;
	project: string;
	sender: string;
	recipient: string;
	encoding: string;
	data: string;
	uncompressed_bytes: number;
	created_at: number;
	server_sequence: number | null;
	reply_to: string | null;
	receipt_for: string | null;
	delivered_at: number | null;
};

type SequenceRow = { next_sequence: number };

type LedgerRow = {
	msg_id: string;
	project: string;
	sender: string;
	recipient: string;
	encoding: string;
	data: string;
	uncompressed_bytes: number;
	created_at: number;
	server_sequence: number;
	reply_to: string | null;
};

type AcknowledgmentRow = {
	msg_id: string;
	project: string;
	recipient: string;
	server_sequence: number;
	acknowledged_at: number;
};

type CursorRow = { last_sequence: number };

export class MessageIdConflictError extends Error {}
export class CausalParentError extends Error {}
export class UnknownMessageError extends Error {}
export class OutOfOrderAcknowledgmentError extends Error {}

export class InboxStore {
	#database: Database;
	#insert;
	#getLedger;
	#getLedgerByRef;
	#insertLedger;
	#get;
	#getPendingMessageId;
	#getAcknowledgmentById;
	#listAfterCursor;
	#listSizesAfterCursor;
	#readCursor;
	#writeCursor;
	#getAcknowledgment;
	#insertAcknowledgment;
	#delete;
	#deleteProjectMessages;
	#deleteProjectLedger;
	#deleteProject;
	#deleteProjectCursors;
	#deleteProjectAcknowledgments;
	#deleteProjectSequences;
	#nextSequence;
	#enqueue;
	#readPending;
	#acknowledge;

	constructor(databasePath: string) {
		ensureDir(path.dirname(databasePath));
		this.#database = new Database(databasePath, { create: true });
		const hadGlobalSequenceState =
			this.#database
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbox_state'",
				)
				.get() != null;
		this.#database.run("PRAGMA journal_mode = WAL");
		this.#database.run("PRAGMA synchronous = FULL");
		this.#database.run(`
			CREATE TABLE IF NOT EXISTS inbox_messages (
				msg_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL DEFAULT 'message',
				project TEXT NOT NULL,
				sender TEXT NOT NULL,
				recipient TEXT NOT NULL,
				encoding TEXT NOT NULL,
				data TEXT NOT NULL,
				uncompressed_bytes INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				server_sequence INTEGER NOT NULL,
				reply_to TEXT,
				receipt_for TEXT,
				delivered_at INTEGER
			)
		`);
		const columns = new Set(
			this.#database
				.query<{ name: string }, []>("PRAGMA table_info(inbox_messages)")
				.all()
				.map((column) => column.name),
		);
		if (!columns.has("kind")) {
			this.#database.run("ALTER TABLE inbox_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'");
		}
		if (!columns.has("server_sequence")) {
			this.#database.run("ALTER TABLE inbox_messages ADD COLUMN server_sequence INTEGER");
		}
		if (!columns.has("reply_to")) {
			this.#database.run("ALTER TABLE inbox_messages ADD COLUMN reply_to TEXT");
		}
		if (!columns.has("receipt_for")) {
			this.#database.run("ALTER TABLE inbox_messages ADD COLUMN receipt_for TEXT");
		}
		if (!columns.has("delivered_at")) {
			this.#database.run("ALTER TABLE inbox_messages ADD COLUMN delivered_at INTEGER");
		}
		this.#database.run(`
			CREATE TABLE IF NOT EXISTS inbox_sequences (
				project TEXT NOT NULL,
				recipient TEXT NOT NULL,
				next_sequence INTEGER NOT NULL,
				PRIMARY KEY(project, recipient)
			)
		`);
		this.#database.run(`
			INSERT INTO inbox_sequences(project, recipient, next_sequence)
			SELECT project, recipient, MAX(server_sequence)
			FROM inbox_messages
			WHERE server_sequence IS NOT NULL
			GROUP BY project, recipient
			ON CONFLICT(project, recipient) DO UPDATE
			SET next_sequence = MAX(next_sequence, excluded.next_sequence)
		`);
		this.#nextSequence = this.#database.query<SequenceRow, [string, string]>(`
			INSERT INTO inbox_sequences(project, recipient, next_sequence)
			VALUES (?, ?, 1)
			ON CONFLICT(project, recipient) DO UPDATE
			SET next_sequence = next_sequence + 1
			RETURNING next_sequence
		`);
		const assignSequence = this.#database.query("UPDATE inbox_messages SET server_sequence = ? WHERE rowid = ?");
		const readUnsequencedBatch = this.#database.query<
			{ rowid: number; project: string; recipient: string },
			[number]
		>(
			"SELECT rowid, project, recipient FROM inbox_messages WHERE server_sequence IS NULL ORDER BY project, recipient, created_at, rowid LIMIT ?",
		);
		for (;;) {
			const migrated = this.#database.transaction(() => {
				const rows = readUnsequencedBatch.all(LEGACY_SEQUENCE_MIGRATION_BATCH_SIZE);
				for (const row of rows) {
					assignSequence.run(this.#allocateSequence(row.project, row.recipient), row.rowid);
				}
				return rows.length;
			})();
			if (migrated < LEGACY_SEQUENCE_MIGRATION_BATCH_SIZE) break;
		}
		const ledgerDefinition = this.#database
			.query<{ sql: string | null }, []>(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_ledger'",
			)
			.get()?.sql;
		if (ledgerDefinition) {
			const existingLedgerColumns = new Set(
				this.#database
					.query<{ name: string }, []>("PRAGMA table_info(message_ledger)")
					.all()
					.map((column) => column.name),
			);
			if (!existingLedgerColumns.has("reply_to")) {
				this.#database.run("ALTER TABLE message_ledger ADD COLUMN reply_to TEXT");
			}
			if (/server_sequence\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i.test(ledgerDefinition)) {
				this.#database.transaction(() => {
					this.#database.run(`
						CREATE TABLE message_ledger_scoped (
							msg_id TEXT PRIMARY KEY,
							project TEXT NOT NULL,
							sender TEXT NOT NULL,
							recipient TEXT NOT NULL,
							encoding TEXT NOT NULL,
							data TEXT NOT NULL,
							uncompressed_bytes INTEGER NOT NULL,
							created_at INTEGER NOT NULL,
							reply_to TEXT,
							server_sequence INTEGER NOT NULL
						)
					`);
					this.#database.run(`
						INSERT INTO message_ledger_scoped(
							msg_id, project, sender, recipient, encoding, data,
							uncompressed_bytes, created_at, reply_to, server_sequence
						)
						SELECT
							msg_id, project, sender, recipient, encoding, data,
							uncompressed_bytes, created_at, reply_to, server_sequence
						FROM message_ledger
					`);
					this.#database.run("DROP TABLE message_ledger");
					this.#database.run("ALTER TABLE message_ledger_scoped RENAME TO message_ledger");
				})();
			}
		}
		this.#database.run(`
			CREATE TABLE IF NOT EXISTS message_ledger (
				msg_id TEXT PRIMARY KEY,
				project TEXT NOT NULL,
				sender TEXT NOT NULL,
				recipient TEXT NOT NULL,
				encoding TEXT NOT NULL,
				data TEXT NOT NULL,
				uncompressed_bytes INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				reply_to TEXT,
				server_sequence INTEGER NOT NULL
			)
		`);
		const ledgerColumns = new Set(
			this.#database
				.query<{ name: string }, []>("PRAGMA table_info(message_ledger)")
				.all()
				.map((column) => column.name),
		);
		if (!ledgerColumns.has("reply_to")) {
			this.#database.run("ALTER TABLE message_ledger ADD COLUMN reply_to TEXT");
		}
		this.#database.run(`
			INSERT OR IGNORE INTO message_ledger(
				msg_id, project, sender, recipient, encoding, data,
				uncompressed_bytes, created_at, server_sequence, reply_to
			)
			SELECT
				msg_id, project, sender, recipient, encoding, data,
				uncompressed_bytes, created_at, server_sequence, reply_to
			FROM inbox_messages
			WHERE kind = 'message'
		`);
		this.#database.run(`
			INSERT INTO inbox_sequences(project, recipient, next_sequence)
			SELECT project, recipient, MAX(server_sequence)
			FROM message_ledger
			GROUP BY project, recipient
			ON CONFLICT(project, recipient) DO UPDATE
			SET next_sequence = MAX(next_sequence, excluded.next_sequence)
		`);
		this.#database.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS message_ledger_stream_sequence ON message_ledger(project, recipient, server_sequence)",
		);
		this.#database.run(`
			CREATE TABLE IF NOT EXISTS inbox_cursors (
				project TEXT NOT NULL,
				recipient TEXT NOT NULL,
				last_sequence INTEGER NOT NULL,
				PRIMARY KEY(project, recipient)
			)
		`);
		this.#database.run(`
			CREATE TABLE IF NOT EXISTS inbox_acknowledgments (
				msg_id TEXT PRIMARY KEY,
				project TEXT NOT NULL,
				recipient TEXT NOT NULL,
				server_sequence INTEGER NOT NULL,
				acknowledged_at INTEGER NOT NULL
			)
		`);
		this.#database.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS inbox_acknowledgment_stream_sequence ON inbox_acknowledgments(project, recipient, server_sequence)",
		);
		this.#database.run(`
			INSERT INTO inbox_sequences(project, recipient, next_sequence)
			SELECT project, recipient, MAX(server_sequence)
			FROM inbox_acknowledgments
			GROUP BY project, recipient
			ON CONFLICT(project, recipient) DO UPDATE
			SET next_sequence = MAX(next_sequence, excluded.next_sequence)
		`);
		if (hadGlobalSequenceState) {
			this.#database.run("DELETE FROM inbox_cursors");
			this.#database.run("DROP TABLE inbox_state");
		}
		this.#database.run("DROP INDEX IF EXISTS inbox_recipient_order");
		this.#database.run("DROP INDEX IF EXISTS inbox_server_sequence");
		this.#database.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS inbox_stream_sequence ON inbox_messages(project, recipient, server_sequence)",
		);
		this.#insert = this.#database.query(
			"INSERT INTO inbox_messages(msg_id, kind, project, sender, recipient, encoding, data, uncompressed_bytes, created_at, server_sequence, reply_to, receipt_for, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.#getLedger = this.#database.query<LedgerRow, [string]>(
			"SELECT msg_id, project, sender, recipient, encoding, data, uncompressed_bytes, created_at, server_sequence, reply_to FROM message_ledger WHERE msg_id = ?",
		);
		this.#getLedgerByRef = this.#database.query<LedgerRow, [string, string, number]>(
			"SELECT msg_id, project, sender, recipient, encoding, data, uncompressed_bytes, created_at, server_sequence, reply_to FROM message_ledger WHERE project = ? AND recipient = ? AND server_sequence = ?",
		);
		this.#insertLedger = this.#database.query(
			"INSERT INTO message_ledger(msg_id, project, sender, recipient, encoding, data, uncompressed_bytes, created_at, server_sequence, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.#get = this.#database.query<MessageRow, [string, string, string]>(
			"SELECT msg_id, kind, project, sender, recipient, encoding, data, uncompressed_bytes, created_at, server_sequence, reply_to, receipt_for, delivered_at FROM inbox_messages WHERE msg_id = ? AND project = ? AND recipient = ?",
		);
		this.#getPendingMessageId = this.#database.query<{ msg_id: string }, [string]>(
			"SELECT msg_id FROM inbox_messages WHERE msg_id = ?",
		);
		this.#getAcknowledgmentById = this.#database.query<{ msg_id: string }, [string]>(
			"SELECT msg_id FROM inbox_acknowledgments WHERE msg_id = ?",
		);
		this.#listAfterCursor = this.#database.query<MessageRow, [string, string, number, number]>(
			"SELECT msg_id, kind, project, sender, recipient, encoding, data, uncompressed_bytes, created_at, server_sequence, reply_to, receipt_for, delivered_at FROM inbox_messages WHERE project = ? AND recipient = ? AND server_sequence > ? ORDER BY server_sequence LIMIT ?",
		);
		this.#listSizesAfterCursor = this.#database.query<MessageSizeRow, [string, string, number, number]>(
			"SELECT msg_id, kind, project, sender, recipient, encoding, length(CAST(data AS BLOB)) AS data_bytes, uncompressed_bytes, created_at, server_sequence, reply_to, receipt_for, delivered_at FROM inbox_messages WHERE project = ? AND recipient = ? AND server_sequence > ? ORDER BY server_sequence LIMIT ?",
		);
		this.#readCursor = this.#database.query<CursorRow, [string, string]>(
			"SELECT last_sequence FROM inbox_cursors WHERE project = ? AND recipient = ?",
		);
		this.#writeCursor = this.#database.query(
			"INSERT INTO inbox_cursors(project, recipient, last_sequence) VALUES (?, ?, ?) ON CONFLICT(project, recipient) DO UPDATE SET last_sequence = MAX(last_sequence, excluded.last_sequence)",
		);
		this.#getAcknowledgment = this.#database.query<AcknowledgmentRow, [string, string, string]>(
			"SELECT msg_id, project, recipient, server_sequence, acknowledged_at FROM inbox_acknowledgments WHERE msg_id = ? AND project = ? AND recipient = ?",
		);
		this.#insertAcknowledgment = this.#database.query(
			"INSERT INTO inbox_acknowledgments(msg_id, project, recipient, server_sequence, acknowledged_at) VALUES (?, ?, ?, ?, ?)",
		);
		this.#delete = this.#database.query(
			"DELETE FROM inbox_messages WHERE msg_id = ? AND project = ? AND recipient = ?",
		);
		this.#deleteProjectMessages = this.#database.query("DELETE FROM inbox_messages WHERE project = ?");
		this.#deleteProjectLedger = this.#database.query("DELETE FROM message_ledger WHERE project = ?");
		this.#deleteProjectCursors = this.#database.query("DELETE FROM inbox_cursors WHERE project = ?");
		this.#deleteProjectAcknowledgments = this.#database.query(
			"DELETE FROM inbox_acknowledgments WHERE project = ?",
		);
		this.#deleteProjectSequences = this.#database.query("DELETE FROM inbox_sequences WHERE project = ?");
		this.#deleteProject = this.#database.transaction((project: string) => {
			this.#deleteProjectMessages.run(project);
			this.#deleteProjectLedger.run(project);
			this.#deleteProjectCursors.run(project);
			this.#deleteProjectAcknowledgments.run(project);
			this.#deleteProjectSequences.run(project);
		});
		this.#enqueue = this.#database.transaction(
			(message: HubWireMessageDraft, validateNew: () => void): HubWireMessageEnvelope => {
				const parent = this.#resolveCausalParent(message);
				const replyTo = parent?.msg_id;
				const replyToRef = parent
					? formatMessageRef(parent.recipient, parent.server_sequence)
					: undefined;
				const existing = this.#getLedger.get(message.msgId);
				if (existing) {
					const stored = this.#messageFromLedger(existing);
					const matches =
						stored.project === message.project &&
						stored.from === message.from &&
						stored.to === message.to &&
						stored.replyTo === replyTo &&
						stored.payload.encoding === message.payload.encoding &&
						stored.payload.data === message.payload.data &&
						stored.payload.uncompressedBytes === message.payload.uncompressedBytes;
					if (!matches) throw new MessageIdConflictError(`messageId already used: ${message.msgId}`);
					return stored;
				}
				if (
					message.msgId.startsWith(RECEIPT_ID_PREFIX) ||
					this.#getPendingMessageId.get(message.msgId) ||
					this.#getAcknowledgmentById.get(message.msgId)
				) {
					throw new MessageIdConflictError(`messageId reserved: ${message.msgId}`);
				}
				validateNew();
				const serverSequence = this.#allocateSequence(message.project, message.to);
				const stored: HubWireMessageEnvelope = {
					...message,
					messageRef: formatMessageRef(message.to, serverSequence),
					replyTo,
					replyToRef,
					serverSequence,
				};
				this.#insertLedger.run(
					stored.msgId,
					stored.project,
					stored.from,
					stored.to,
					stored.payload.encoding,
					stored.payload.data,
					stored.payload.uncompressedBytes,
					stored.createdAt,
					stored.serverSequence,
					stored.replyTo ?? null,
				);
				this.#insertEnvelope(stored);
				return stored;
			},
		);
		this.#readPending = this.#database.transaction(
			(project: string, agentId: string, limit: number): HubWireInboxBatch => {
				const cursor = this.#readCursor.get(project, agentId)?.last_sequence ?? 0;
				const boundedLimit = Number.isFinite(limit)
					? Math.max(0, Math.min(Math.trunc(limit), MAX_INBOX_BATCH_MESSAGES))
					: MAX_INBOX_BATCH_MESSAGES;
				const sizeRows = this.#listSizesAfterCursor.all(project, agentId, cursor, boundedLimit);
				const messages: HubWireEnvelope[] = [];
				let estimatedBytes = 0;
				for (const sizeRow of sizeRows) {
					const rowBytes = estimatedEnvelopeBytes(sizeRow);
					if (messages.length > 0 && estimatedBytes + rowBytes > MAX_INBOX_BATCH_ESTIMATED_BYTES) break;
					const row = this.#get.get(sizeRow.msg_id, project, agentId);
					if (!row) throw new Error(`Inbox message disappeared during read: ${sizeRow.msg_id}`);
					messages.push(this.#toEnvelope(row));
					estimatedBytes += rowBytes;
				}
				return { messages, cursor };
			},
		);
		this.#acknowledge = this.#database.transaction(
			(project: string, agentId: string, messageIds: string[]): HubAckBatch => {
				let cursor = this.#readCursor.get(project, agentId)?.last_sequence ?? 0;
				const acknowledgments: HubAckBatch["acknowledgments"] = [];
				for (const messageId of messageIds) {
					const row = this.#get.get(messageId, project, agentId);
					if (!row) {
						const acknowledged = this.#getAcknowledgment.get(messageId, project, agentId);
						if (!acknowledged) throw new UnknownMessageError(`unknown message: ${messageId}`);
						acknowledgments.push({
							messageId,
							serverSequence: acknowledged.server_sequence,
							status: "already_acknowledged",
						});
						continue;
					}
					const next = this.#listAfterCursor.get(project, agentId, cursor, 1);
					if (!next || next.msg_id !== messageId) {
						throw new OutOfOrderAcknowledgmentError(
							`out-of-order acknowledgment: ${messageId}; next message is ${next?.msg_id ?? "none"}`,
						);
					}
					const message = this.#toEnvelope(row);
					const acknowledgedAt = Date.now();
					this.#delete.run(messageId, project, agentId);
					this.#insertAcknowledgment.run(
						messageId,
						project,
						agentId,
						message.serverSequence,
						acknowledgedAt,
					);
					this.#writeCursor.run(project, agentId, message.serverSequence);
					cursor = message.serverSequence;
					if (message.kind === "message") {
						const text = `Delivered msg=${message.msgId} to=${message.to}`;
						this.#insertEnvelope({
							kind: "delivery_receipt",
							msgId: `${RECEIPT_ID_PREFIX}${crypto.randomUUID()}`,
							project: message.project,
							from: message.to,
							to: message.from,
							payload: encodeTextPayload(text),
							createdAt: acknowledgedAt,
							serverSequence: this.#allocateSequence(message.project, message.from),
							receiptFor: message.msgId,
							deliveredAt: acknowledgedAt,
						});
					}
					acknowledgments.push({
						messageId,
						serverSequence: message.serverSequence,
						status: "acknowledged",
					});
				}
				return { acknowledgments, cursor };
			},
		);
	}

	#resolveCausalParent(message: HubWireMessageDraft): LedgerRow | null {
		if (message.replyTo != null && message.replyTo.trim().length === 0) {
			throw new CausalParentError("replyTo must not be blank");
		}
		if (message.replyToRef != null && message.replyToRef.trim().length === 0) {
			throw new CausalParentError("replyToRef must not be blank");
		}
		const parentById = message.replyTo ? this.#getLedger.get(message.replyTo) : null;
		if (message.replyTo && !parentById) throw new CausalParentError(`unknown replyTo: ${message.replyTo}`);

		let parentByRef: LedgerRow | null = null;
		if (message.replyToRef) {
			const reference = parseMessageRef(message.replyToRef);
			parentByRef =
				this.#getLedgerByRef.get(message.project, reference.recipient, reference.serverSequence) ?? null;
			if (!parentByRef) throw new CausalParentError(`unknown replyToRef: ${message.replyToRef}`);
		}
		if (parentById && parentByRef && parentById.msg_id !== parentByRef.msg_id) {
			throw new CausalParentError("replyTo and replyToRef identify different messages");
		}
		const parent = parentById ?? parentByRef;
		if (!parent) return null;
		const samePair =
			(parent.sender === message.from && parent.recipient === message.to) ||
			(parent.sender === message.to && parent.recipient === message.from);
		if (parent.project !== message.project || !samePair) {
			throw new CausalParentError(
				`causal parent does not match project conversation: ${message.replyToRef ?? message.replyTo}`,
			);
		}
		return parent;
	}

	#allocateSequence(project: string, recipient: string): number {
		const row = this.#nextSequence.get(project, recipient);
		if (!row || !Number.isSafeInteger(row.next_sequence) || row.next_sequence <= 0) {
			throw new Error(`failed to allocate Inbox sequence for ${recipient}@${project}`);
		}
		return row.next_sequence;
	}

	#insertEnvelope(message: HubWireEnvelope): void {
		this.#insert.run(
			message.msgId,
			message.kind,
			message.project,
			message.from,
			message.to,
			message.payload.encoding,
			message.payload.data,
			message.payload.uncompressedBytes,
			message.createdAt,
			message.serverSequence,
			message.replyTo ?? null,
			message.kind === "delivery_receipt" ? message.receiptFor : null,
			message.kind === "delivery_receipt" ? message.deliveredAt : null,
		);
	}

	#messageFromLedger(row: LedgerRow): HubWireMessageEnvelope {
		const message = this.#toEnvelope({
			...row,
			kind: "message",
			receipt_for: null,
			delivered_at: null,
		});
		if (message.kind !== "message") throw new Error(`invalid message ledger row ${row.msg_id}`);
		return message;
	}

	#toEnvelope(row: MessageRow): HubWireEnvelope {
		if (row.encoding !== "identity" && row.encoding !== "gzip+base64") {
			throw new Error(`invalid Inbox encoding for ${row.msg_id}`);
		}
		if (!Number.isSafeInteger(row.server_sequence) || row.server_sequence == null || row.server_sequence <= 0) {
			throw new Error(`invalid Inbox sequence for ${row.msg_id}`);
		}
		const payload: EncodedTextPayload = {
			encoding: row.encoding,
			data: row.data,
			uncompressedBytes: row.uncompressed_bytes,
		};
		const parent = row.reply_to ? this.#getLedger.get(row.reply_to) : null;
		if (row.reply_to && !parent) throw new Error(`missing causal parent ${row.reply_to}`);
		const base = {
			msgId: row.msg_id,
			project: row.project,
			from: row.sender,
			to: row.recipient,
			payload,
			createdAt: row.created_at,
			serverSequence: row.server_sequence,
			messageRef: formatMessageRef(row.recipient, row.server_sequence),
			replyTo: row.reply_to ?? undefined,
			replyToRef: parent ? formatMessageRef(parent.recipient, parent.server_sequence) : undefined,
		};
		if (row.kind === "message") return { ...base, kind: "message" };
		if (row.kind === "delivery_receipt" && row.receipt_for && row.delivered_at != null) {
			return {
				...base,
				kind: "delivery_receipt",
				receiptFor: row.receipt_for,
				deliveredAt: row.delivered_at,
			};
		}
		throw new Error(`invalid Inbox envelope ${row.msg_id}`);
	}

	enqueue(message: HubWireMessageDraft, validateNew: () => void): HubWireMessageEnvelope {
		return this.#enqueue(message, validateNew);
	}

	read(project: string, recipient: string, limit = 500): HubWireInboxBatch {
		return this.#readPending(project, recipient, limit);
	}

	acknowledge(project: string, recipient: string, messageIds: string[]): HubAckBatch {
		if (messageIds.length > MAX_ACK_BATCH_MESSAGES) {
			throw new Error(`acknowledgment batch exceeds ${MAX_ACK_BATCH_MESSAGES} messages`);
		}
		return this.#acknowledge(project, recipient, [...new Set(messageIds)]);
	}

	deleteProject(project: string): void {
		this.#deleteProject(project);
	}

	close(): void {
		this.#database.close();
	}
}
