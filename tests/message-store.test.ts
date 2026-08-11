import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageIdConflictError, MessageStore } from "../src/hub/messages";
import { encodeBinaryPayload, encodeTextPayload } from "../src/hub/payload";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("messages form one immutable sequence per Project", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const store = new MessageStore(databasePath);

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
	expect(repeated).toEqual({ inserted: false, message: first.message });
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
	const database = new Database(databasePath);
	const columns = database
		.query<{ name: string }, []>("PRAGMA table_info(messages)")
		.all()
		.map((column) => column.name);
	expect(columns).not.toContain("uncompressed_bytes");
	expect(columns).not.toContain("content_bytes");
	database.close();
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
	legacy.close();

	const store = new MessageStore(join(root, "messages.sqlite"), {
		legacyDatabasePath: legacyPath,
	});
	expect(
		store.history({ project: "legacy", limit: 10 }).messages,
	).toMatchObject([
		{ messageId: "first-id", messageRef: "legacy:1", replyTo: undefined },
		{ messageId: "second-id", messageRef: "legacy:2", replyTo: "legacy:1" },
	]);
	expect(store.integrityCheck()).toBe("ok");
	store.close();

	const reopened = new MessageStore(join(root, "messages.sqlite"), {
		legacyDatabasePath: legacyPath,
	});
	expect(
		reopened.history({ project: "legacy", limit: 10 }).messages,
	).toHaveLength(2);
	reopened.close();
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

test("history keeps its default page and accepts explicit large limits", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const store = new MessageStore(join(root, "messages.sqlite"));
	for (let index = 1; index <= 501; index++) {
		store.append({
			messageId: `large-limit-${index}`,
			project: "large-limit",
			from: { name: "api", presenceId: "presence-api" },
			target: { type: "project" },
			payload: encodeTextPayload(`message ${index}`),
			attachments: [],
			createdAt: index,
		});
	}
	const defaultPage = store.history({ project: "large-limit" }).messages;
	expect(defaultPage).toHaveLength(50);
	expect(defaultPage[0]?.messageRef).toBe("large-limit:452");
	expect(
		store.history({ project: "large-limit", limit: 501 }).messages,
	).toHaveLength(501);
	expect(() => store.history({ project: "large-limit", limit: 0 })).toThrow(
		"positive integer",
	);
	expect(() => store.history({ project: "large-limit", limit: 1.5 })).toThrow(
		"positive integer",
	);
	store.close();
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
	).toEqual({ inserted: false, message: first.message });
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
