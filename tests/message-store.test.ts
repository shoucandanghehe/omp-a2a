import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_HISTORY_BYTES,
	MAX_HISTORY_RESPONSE_BYTES,
	MessageIdConflictError,
	MessageStore,
} from "../src/hub/messages";
import {
	encodeBinaryPayload,
	encodeTextPayload,
	MAX_TEXT_BYTES,
} from "../src/hub/payload";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("messages form one immutable sequence per Project", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const store = new MessageStore(join(root, "messages.sqlite"));

	const first = store.append({
		messageId: "message-1",
		project: "billing",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "agent", name: "web", presenceId: "presence-web" },
		payload: encodeTextPayload("check the login contract"),
		attachments: [],
		createdAt: 100,
	});
	const second = store.append({
		messageId: "message-2",
		project: "billing",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "project" },
		payload: encodeTextPayload("freeze the contract"),
		attachments: [],
		createdAt: 101,
		replyTo: first.message.messageRef,
	});

	expect(first).toMatchObject({
		inserted: true,
		message: { sequence: 1, messageRef: "billing:1" },
	});
	expect(second).toMatchObject({
		inserted: true,
		message: { sequence: 2, messageRef: "billing:2", replyTo: "billing:1" },
	});
	expect(
		store
			.history({ project: "billing", limit: 10 })
			.messages.map((message) => message.messageRef),
	).toEqual(["billing:1", "billing:2"]);

	const repeated = store.append({
		messageId: "message-1",
		project: "billing",
		from: { name: "api", presenceId: "another-presence" },
		target: { type: "agent", name: "web", presenceId: "another-web-presence" },
		payload: encodeTextPayload("check the login contract"),
		attachments: [],
		createdAt: 999,
	});
	expect(repeated).toMatchObject({
		inserted: false,
		message: first.message,
		recipients: [{ name: "web", presenceId: "presence-web" }],
	});
	expect(() =>
		store.append({
			messageId: "message-1",
			project: "billing",
			from: { name: "api", presenceId: "presence-api" },
			target: { type: "agent", name: "web", presenceId: "presence-web" },
			payload: encodeTextPayload("different body"),
			attachments: [],
			createdAt: 100,
		}),
	).toThrow(MessageIdConflictError);

	store.close();
});

test("legacy message ledger migrates once into Project history", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const legacyPath = join(root, "inbox.sqlite");
	const legacy = new Database(legacyPath, { create: true });
	legacy.run(`
		CREATE TABLE message_ledger (
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
	const insert = legacy.query(
		"INSERT INTO message_ledger(msg_id, project, sender, recipient, encoding, data, uncompressed_bytes, created_at, reply_to, server_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	insert.run(
		"second-id",
		"legacy",
		"web",
		"api",
		"identity",
		"second",
		6,
		200,
		"first-id",
		1,
	);
	insert.run(
		"first-id",
		"legacy",
		"api",
		"web",
		"identity",
		"first",
		5,
		100,
		null,
		1,
	);
	for (let index = 0; index < 130; index++) {
		const value = `batch-${index.toString().padStart(3, "0")}`;
		insert.run(
			value,
			"legacy",
			"api",
			"web",
			"identity",
			value,
			value.length,
			300 + index,
			null,
			1,
		);
	}
	insert.run(
		"receipt:quarterly-report",
		"legacy",
		"api",
		"web",
		"identity",
		"ordinary receipt-prefixed message",
		33,
		500,
		null,
		1,
	);
	legacy.close();

	const store = new MessageStore(join(root, "messages.sqlite"), {
		legacyDatabasePath: legacyPath,
	});
	const migrated = store.history({ project: "legacy", limit: 500 }).messages;
	expect(migrated).toHaveLength(133);
	expect(migrated.slice(0, 2)).toMatchObject([
		{ messageId: "first-id", messageRef: "legacy:1", replyTo: undefined },
		{ messageId: "second-id", messageRef: "legacy:2", replyTo: "legacy:1" },
	]);
	expect(migrated.at(-1)).toMatchObject({
		messageId: "receipt:quarterly-report",
		messageRef: "legacy:133",
	});
	expect(store.integrityCheck()).toBe("ok");
	store.deleteProject("legacy");
	store.close();

	const reopened = new MessageStore(join(root, "messages.sqlite"), {
		legacyDatabasePath: legacyPath,
	});
	expect(
		reopened.history({ project: "legacy", limit: 500 }).messages,
	).toHaveLength(0);
	reopened.close();
});

test("empty existing pre-marker databases do not replay retained legacy rows", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const legacyPath = join(root, "inbox.sqlite");
	const existing = new MessageStore(databasePath);
	existing.append({
		messageId: "existing-id",
		project: "upgrade",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "agent", name: "web", presenceId: "presence-web" },
		payload: encodeTextPayload("existing"),
		attachments: [],
		createdAt: 1,
	});
	existing.deleteProject("upgrade");
	existing.close();
	const previousSchema = new Database(databasePath);
	previousSchema.run("DROP TABLE message_store_metadata");
	previousSchema.close();

	const legacy = new Database(legacyPath, { create: true });
	legacy.run(`
		CREATE TABLE message_ledger (
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
	legacy
		.query("INSERT INTO message_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(
			"existing-id",
			"upgrade",
			"api",
			"web",
			"identity",
			"existing",
			8,
			1,
			null,
			1,
		);
	legacy.close();

	const upgraded = new MessageStore(databasePath, {
		legacyDatabasePath: legacyPath,
	});
	expect(
		upgraded.history({ project: "upgrade", limit: 10 }).messages,
	).toHaveLength(0);
	upgraded.close();
});

test("failed legacy migration rolls back atomically and can retry once", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const legacyPath = join(root, "inbox.sqlite");
	const databasePath = join(root, "messages.sqlite");
	const legacy = new Database(legacyPath, { create: true });
	legacy.run(`
		CREATE TABLE message_ledger (
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
	const insert = legacy.query(
		"INSERT INTO message_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	insert.run(
		"child",
		"rollback",
		"api",
		"web",
		"identity",
		"child",
		5,
		2,
		"parent",
		1,
	);
	expect(
		() =>
			new MessageStore(databasePath, {
				legacyDatabasePath: legacyPath,
			}),
	).toThrow("missing parent");
	const inspected = new Database(databasePath);
	expect(
		inspected.query<{ count: number }, []>("SELECT COUNT(*) count FROM messages")
			.get()?.count,
	).toBe(0);
	inspected.close();
	insert.run(
		"parent",
		"rollback",
		"web",
		"api",
		"identity",
		"parent",
		6,
		1,
		null,
		1,
	);
	legacy.close();

	const recovered = new MessageStore(databasePath, {
		legacyDatabasePath: legacyPath,
	});
	expect(
		recovered
			.history({ project: "rollback", limit: 10 })
			.messages.map((message) => message.messageId),
	).toEqual(["parent", "child"]);
	recovered.close();
});

test("blank replies and invalid history limits do not consume sequence", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const store = new MessageStore(join(root, "messages.sqlite"));
	const draft = {
		project: "validation",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "project" as const },
		payload: encodeTextPayload("body"),
		attachments: [],
		createdAt: 1,
	};

	expect(() =>
		store.append({ ...draft, messageId: "blank-reply", replyTo: " \t" }),
	).toThrow("replyTo must not be blank");
	for (const limit of [0, 501, 1.5, Number.NaN]) {
		expect(() => store.history({ project: "validation", limit })).toThrow(
			"history limit must be an integer",
		);
	}
	expect(
		store.append({ ...draft, messageId: "valid-after-rejections" }).message
			.messageRef,
	).toBe("validation:1");
	store.close();
});

test("history uses stable Project cursors and sender filters", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const store = new MessageStore(join(root, "messages.sqlite"));
	for (const [index, from] of ["api", "web", "api"].entries()) {
		store.append({
			messageId: `history-${index + 1}`,
			project: "history",
			from: { name: from, presenceId: `presence-${from}` },
			target: { type: "project" },
			payload: encodeTextPayload(`message ${index + 1}`),
			attachments: [],
			createdAt: index + 1,
		});
	}

	expect(
		store
			.history({ project: "history", limit: 2 })
			.messages.map((message) => message.messageRef),
	).toEqual(["history:2", "history:3"]);
	expect(
		store
			.history({ project: "history", before: "history:3", limit: 2 })
			.messages.map((message) => message.messageRef),
	).toEqual(["history:1", "history:2"]);
	expect(
		store
			.history({ project: "history", after: "history:1", limit: 1 })
			.messages.map((message) => message.messageRef),
	).toEqual(["history:2"]);
	expect(
		store
			.history({ project: "history", from: "api" })
			.messages.map((message) => message.messageRef),
	).toEqual(["history:1", "history:3"]);
	store.close();
});

test("history response has an explicit decoded-byte bound", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const store = new MessageStore(join(root, "messages.sqlite"));
	const text = "x".repeat(MAX_HISTORY_BYTES / 2);
	for (let index = 1; index <= 3; index++) {
		store.append({
			messageId: `bounded-${index}`,
			project: "bounded",
			from: { name: "api", presenceId: "presence-api" },
			target: { type: "project" },
			payload: encodeTextPayload(text),
			attachments: [],
			createdAt: index,
		});
	}
	expect(
		store
			.history({ project: "bounded", limit: 10 })
			.messages.map((message) => message.messageRef),
	).toEqual(["bounded:2", "bounded:3"]);
	store.close();
});

test("protocol v2 message databases migrate with empty attachments", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-v2-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const previous = new Database(databasePath, { create: true });
	previous.run(`
		CREATE TABLE messages (
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
			created_at INTEGER NOT NULL,
			reply_to_sequence INTEGER,
			PRIMARY KEY(project, project_sequence)
		)
	`);
	previous
		.query(
			"INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"migration",
			1,
			"v2-message",
			"api",
			"presence-api",
			"project",
			null,
			null,
			"identity",
			"persisted before attachments",
			28,
			100,
			null,
		);
	previous.close();

	const store = new MessageStore(databasePath);
	expect(store.history({ project: "migration" }).messages).toMatchObject([
		{
			messageId: "v2-message",
			attachments: [],
		},
	]);
	store.close();
	const reopened = new MessageStore(databasePath);
	expect(reopened.integrityCheck()).toBe("ok");
	expect(reopened.history({ project: "migration" }).messages).toHaveLength(1);
	reopened.close();
});

test("attachment content participates in messageId idempotency", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-attachment-idempotency-"));
	roots.push(root);
	const store = new MessageStore(join(root, "messages.sqlite"));
	const draft = {
		messageId: "attachment-idempotency",
		project: "attachments",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "project" as const },
		payload: encodeTextPayload("training contract"),
		attachments: [
			{
				name: "handoff.md",
				payload: encodeBinaryPayload(
					Buffer.from("# Handoff\nseed=20\n", "utf8"),
				),
			},
		],
		createdAt: 100,
	};
	const first = store.append(draft);
	expect(
		store.append({
			...draft,
			from: { name: "api", presenceId: "replacement-presence" },
			createdAt: 200,
		}),
	).toEqual({ inserted: false, message: first.message, recipients: [] });
	expect(() =>
		store.append({
			...draft,
			attachments: [
				{
					name: "handoff.md",
					payload: encodeBinaryPayload(
						Buffer.from("# Handoff\nseed=21\n", "utf8"),
					),
				},
			],
		}),
	).toThrow(MessageIdConflictError);
	store.close();
});

test("history bounds serialized bytes and advances through every legal row", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const store = new MessageStore(join(root, "messages.sqlite"));
	const escaped = "\0".repeat(30_000);
	for (let index = 1; index <= 40; index++) {
		store.append({
			messageId: `escaped-${index}`,
			project: "escaped",
			from: { name: "api", presenceId: "presence-api" },
			target: { type: "project" },
			payload: encodeTextPayload(escaped),
			attachments: [],
			createdAt: index,
		});
	}

	const page = store.history({ project: "escaped", limit: 500 });
	expect(page.messages.length).toBeGreaterThan(0);
	expect(page.messages.length).toBeLessThan(40);
	expect(page.messages.at(-1)?.messageRef).toBe("escaped:40");
	expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
		MAX_HISTORY_RESPONSE_BYTES,
	);
	const firstReference = page.messages[0]?.messageRef;
	if (!firstReference) throw new Error("bounded history page was empty");
	const previous = store.history({
		project: "escaped",
		before: firstReference,
		limit: 500,
	});
	expect(previous.messages.length).toBeGreaterThan(0);
	expect(previous.messages.at(-1)?.sequence).toBeLessThan(
		page.messages[0]!.sequence,
	);

	const randomText = Buffer.allocUnsafe(MAX_TEXT_BYTES);
	let state = 0x12345678;
	for (let index = 0; index < randomText.length; index++) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		randomText[index] = 32 + (state % 95);
	}
	store.append({
		messageId: "maximum-single",
		project: "maximum",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "project" },
		payload: encodeTextPayload(randomText.toString("ascii")),
		attachments: [],
		createdAt: 1,
	});
	const maximumPage = store.history({ project: "maximum", limit: 1 });
	expect(maximumPage.messages).toHaveLength(1);
	expect(Buffer.byteLength(JSON.stringify(maximumPage))).toBeLessThanOrEqual(
		MAX_HISTORY_RESPONSE_BYTES,
	);
	store.close();
});
