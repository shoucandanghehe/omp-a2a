import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CausalParentError,
	InboxStore,
	LEGACY_SEQUENCE_MIGRATION_BATCH_SIZE,
	MAX_ACK_BATCH_MESSAGES,
	MAX_INBOX_BATCH_ESTIMATED_BYTES,
	MessageIdConflictError,
	RECEIPT_ID_PREFIX,
	OutOfOrderAcknowledgmentError,
} from "../src/hub/inbox";
import { encodeTextPayload } from "../src/hub/payload";
import type { HubWireMessageDraft } from "../src/hub/types";

let store: InboxStore | null = null;
let root: string | null = null;

afterEach(() => {
	store?.close();
	if (root) rmSync(root, { recursive: true, force: true });
	store = null;
	root = null;
});

function draft(msgId: string, text: string): HubWireMessageDraft {
	return {
		kind: "message",
		msgId,
		project: "storage",
		from: "sender",
		to: "receiver",
		payload: encodeTextPayload(text),
		createdAt: 1,
	};
}

test("storage read and acknowledgment preserve ordered state across restart", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	const databasePath = join(root, "inbox.sqlite");
	store = new InboxStore(databasePath);
	const first = store.enqueue(draft("z-first", "first"), () => {});
	const second = store.enqueue(draft("a-second", "second"), () => {});

	expect(store.read("storage", "receiver")).toEqual({ messages: [first, second], cursor: 0 });
	expect(() => store!.acknowledge("storage", "receiver", [second.msgId])).toThrow(
		OutOfOrderAcknowledgmentError,
	);
	expect(store.acknowledge("storage", "receiver", [first.msgId])).toEqual({
		acknowledgments: [
			{ messageId: first.msgId, serverSequence: 1, status: "acknowledged" },
		],
		cursor: 1,
	});
	store.close();

	store = new InboxStore(databasePath);
	expect(store.acknowledge("storage", "receiver", [first.msgId])).toEqual({
		acknowledgments: [
			{ messageId: first.msgId, serverSequence: 1, status: "already_acknowledged" },
		],
		cursor: 1,
	});
	expect(store.read("storage", "receiver")).toEqual({ messages: [second], cursor: 1 });
});

test("read stops at the estimated byte boundary and continues in FIFO order", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	store = new InboxStore(join(root, "inbox.sqlite"));
	const messages = Array.from({ length: 43 }, (_, index) =>
		store!.enqueue(draft(`message-${index}`, "x".repeat(32 * 1024 - 1)), () => {}),
	);

	const firstPage = store.read("storage", "receiver");
	expect(firstPage.messages.length).toBeGreaterThan(0);
	expect(firstPage.messages.length).toBeLessThan(messages.length);
	expect(firstPage.messages.map((message) => message.msgId)).toEqual(
		messages.slice(0, firstPage.messages.length).map((message) => message.msgId),
	);

	store.acknowledge(
		"storage",
		"receiver",
		firstPage.messages.map((message) => message.msgId),
	);
	expect(store.read("storage", "receiver").messages.map((message) => message.msgId)).toEqual(
		messages.slice(firstPage.messages.length).map((message) => message.msgId),
	);
});

test("read budgets JSON escaping for whitespace-padded gzip payloads", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	store = new InboxStore(join(root, "inbox.sqlite"));
	const compressed = encodeTextPayload("x".repeat(40 * 1024));
	if (compressed.encoding !== "gzip+base64") throw new Error("fixture did not use gzip");
	const paddedPayload = {
		...compressed,
		data: `${compressed.data}${"\n".repeat(Math.floor(MAX_INBOX_BATCH_ESTIMATED_BYTES / 8))}`,
	};
	const first = store.enqueue({ ...draft("padded-first", ""), payload: paddedPayload }, () => {});
	store.enqueue({ ...draft("padded-second", ""), payload: paddedPayload }, () => {});

	expect(store.read("storage", "receiver").messages).toEqual([first]);
});

test("read returns an oversize first row for forward progress", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	store = new InboxStore(join(root, "inbox.sqlite"));
	const oversizeText = "x".repeat(Math.ceil(MAX_INBOX_BATCH_ESTIMATED_BYTES / 6));
	const oversize = store.enqueue(
		{
			...draft("oversize", ""),
			payload: {
				encoding: "identity",
				data: oversizeText,
				uncompressedBytes: Buffer.byteLength(oversizeText),
			},
		},
		() => {},
	);
	const later = store.enqueue(draft("later", "later"), () => {});

	expect(store.read("storage", "receiver").messages).toEqual([oversize]);
	store.acknowledge("storage", "receiver", [oversize.msgId]);
	expect(store.read("storage", "receiver").messages).toEqual([later]);
});

test("acknowledgment deduplicates message IDs before transactional processing", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	store = new InboxStore(join(root, "inbox.sqlite"));
	const message = store.enqueue(draft("duplicate-ack", "hello"), () => {});

	expect(store.acknowledge("storage", "receiver", [message.msgId, message.msgId])).toEqual({
		acknowledgments: [
			{ messageId: message.msgId, serverSequence: message.serverSequence, status: "acknowledged" },
		],
		cursor: message.serverSequence,
	});
	expect(store.read("storage", "sender").messages).toHaveLength(1);
});

test("acknowledgment rejects a raw batch over the count cap", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	store = new InboxStore(join(root, "inbox.sqlite"));

	expect(() =>
		store!.acknowledge(
			"storage",
			"receiver",
			Array.from({ length: MAX_ACK_BATCH_MESSAGES + 1 }, () => "duplicate"),
		),
	).toThrow(`acknowledgment batch exceeds ${MAX_ACK_BATCH_MESSAGES} messages`);
});

test("normal message retries remain idempotent before receipt ID reservation", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	store = new InboxStore(join(root, "inbox.sqlite"));
	const message = draft("normal-retry", "same payload");

	const first = store.enqueue(message, () => {});
	store.acknowledge("storage", "receiver", [first.msgId]);
	expect(store.enqueue(message, () => {})).toEqual(first);
	expect(store.read("storage", "receiver").messages).toEqual([]);
});

test("receipt IDs stay reserved while pending and after acknowledgment", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	const databasePath = join(root, "inbox.sqlite");
	store = new InboxStore(databasePath);
	const message = store.enqueue(draft("receipt-source", "deliver me"), () => {});
	store.acknowledge("storage", "receiver", [message.msgId]);
	const generatedReceipt = store.read("storage", "sender").messages[0]!;
	expect(generatedReceipt.kind).toBe("delivery_receipt");
	expect(generatedReceipt.msgId.startsWith(RECEIPT_ID_PREFIX)).toBe(true);

	store.close();
	const database = new Database(databasePath);
	const legacyReceiptId = "legacy-receipt-id";
	database
		.query("UPDATE inbox_messages SET msg_id = ? WHERE msg_id = ?")
		.run(legacyReceiptId, generatedReceipt.msgId);
	database.close();
	store = new InboxStore(databasePath);

	expect(() => store!.enqueue(draft(legacyReceiptId, "reuse pending receipt"), () => {})).toThrow(
		MessageIdConflictError,
	);
	store.acknowledge("storage", "sender", [legacyReceiptId]);
	expect(() => store!.enqueue(draft(legacyReceiptId, "reuse acknowledged receipt"), () => {})).toThrow(
		MessageIdConflictError,
	);
});

test("reserved receipt prefix is unavailable to normal messages", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	store = new InboxStore(join(root, "inbox.sqlite"));

	expect(() => store!.enqueue(draft(`${RECEIPT_ID_PREFIX}user-selected`, "no"), () => {})).toThrow(
		MessageIdConflictError,
	);
});

test("blank causal fields are rejected at the InboxStore boundary", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	store = new InboxStore(join(root, "inbox.sqlite"));

	expect(() => store!.enqueue({ ...draft("blank-reply", "no"), replyTo: " \t\n" }, () => {})).toThrow(
		CausalParentError,
	);
	expect(() =>
		store!.enqueue({ ...draft("blank-ref", "no"), replyToRef: " \t\n" }, () => {}),
	).toThrow(CausalParentError);
});

test("legacy sequence migration batches NULL rows in exact FIFO order", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	const databasePath = join(root, "inbox.sqlite");
	const database = new Database(databasePath, { create: true });
	database.run(`
		CREATE TABLE inbox_messages (
			msg_id TEXT PRIMARY KEY,
			kind TEXT NOT NULL DEFAULT 'message',
			project TEXT NOT NULL,
			sender TEXT NOT NULL,
			recipient TEXT NOT NULL,
			encoding TEXT NOT NULL,
			data TEXT NOT NULL,
			uncompressed_bytes INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			server_sequence INTEGER,
			reply_to TEXT,
			receipt_for TEXT,
			delivered_at INTEGER
		)
	`);
	const insert = database.query(
		"INSERT INTO inbox_messages(msg_id, project, sender, recipient, encoding, data, uncompressed_bytes, created_at, server_sequence) VALUES (?, ?, ?, ?, 'identity', ?, ?, ?, ?)",
	);
	const legacyCount = LEGACY_SEQUENCE_MIGRATION_BATCH_SIZE + 3;
	for (let index = 0; index < legacyCount; index += 1) {
		const text = `legacy-${index}`;
		insert.run(text, "storage", "sender", "receiver", text, text.length, Math.floor(index / 2), null);
	}
	insert.run("already-sequenced", "storage", "sender", "other", "assigned", 8, 0, 9);
	database.close();

	store = new InboxStore(databasePath);
	expect(
		store
			.read("storage", "receiver", legacyCount)
			.messages.map((message) => [message.msgId, message.serverSequence]),
	).toEqual(Array.from({ length: legacyCount }, (_, index) => [`legacy-${index}`, index + 1]));
	expect(store.read("storage", "other").messages[0]).toMatchObject({
		msgId: "already-sequenced",
		serverSequence: 9,
	});
});
