import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_HISTORY_BYTES,
	MessageIdConflictError,
	MessageStore,
} from "../src/hub/messages";
import { encodeTextPayload } from "../src/hub/payload";

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
		createdAt: 100,
	});
	const second = store.append({
		messageId: "message-2",
		project: "billing",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "project" },
		payload: encodeTextPayload("freeze the contract"),
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
