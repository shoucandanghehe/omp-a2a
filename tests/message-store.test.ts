import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HubStore,
	MAX_HISTORY_BYTES,
	MessageIdConflictError,
	ProjectConflictError,
	UnknownProjectError,
} from "../src/hub/store";
import { encodeBinaryPayload, encodeTextPayload } from "../src/hub/payload";

const roots: string[] = [];

function appendMessage(
	store: HubStore,
	project: string,
	messageId: string,
	createdAt = 100,
) {
	return store.append({
		messageId,
		project,
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "project" },
		payload: encodeTextPayload(messageId),
		attachments: [],
		createdAt,
	});
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("messages form one immutable sequence per Project", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const store = new HubStore(join(root, "messages.sqlite"));
	store.createProject({ name: "billing" });

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

	const store = new HubStore(join(root, "messages.sqlite"), {
		legacyDatabasePath: legacyPath,
	});
	store.createProject({ name: "legacy" });
	expect(
		store.history({ project: "legacy", limit: 10 }).messages,
	).toMatchObject([
		{ messageId: "first-id", messageRef: "legacy:1", replyTo: undefined },
		{ messageId: "second-id", messageRef: "legacy:2", replyTo: "legacy:1" },
	]);
	expect(store.integrityCheck()).toBe("ok");
	store.close();

	const reopened = new HubStore(join(root, "messages.sqlite"), {
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
	const store = new HubStore(join(root, "messages.sqlite"));
	store.createProject({ name: "history" });
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
	const store = new HubStore(join(root, "messages.sqlite"));
	store.createProject({ name: "bounded" });
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

	const store = new HubStore(databasePath);
	store.createProject({ name: "migration" });
	expect(store.history({ project: "migration" }).messages).toMatchObject([
		{
			messageId: "v2-message",
			attachments: [],
		},
	]);
	store.close();
	const reopened = new HubStore(databasePath);
	expect(reopened.integrityCheck()).toBe("ok");
	expect(reopened.history({ project: "migration" }).messages).toHaveLength(1);
	reopened.close();
});

test("attachment content participates in messageId idempotency", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-attachment-idempotency-"));
	roots.push(root);
	const store = new HubStore(join(root, "messages.sqlite"));
	store.createProject({ name: "attachments" });
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

test("Project metadata persists with deterministic sorting", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-project-store-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const store = new HubStore(databasePath);
	const zeta = store.createProject({
		name: "zeta",
		displayName: "Zeta",
		description: "last Project",
		createdByCwd: "/repos/zeta",
	});
	const alpha = store.createProject({ name: "alpha" });

	expect(store.listProjects()).toEqual([alpha, zeta]);
	expect(store.getProject("zeta")).toEqual(zeta);
	expect(() => store.createProject({ name: "zeta" })).toThrow(
		ProjectConflictError,
	);
	store.close();

	const reopened = new HubStore(databasePath);
	expect(reopened.listProjects()).toEqual([alpha, zeta]);
	expect(reopened.deleteProject("missing")).toBe(false);
	reopened.close();
});

test("messages require an existing Project", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-project-required-"));
	roots.push(root);
	const store = new HubStore(join(root, "messages.sqlite"));

	expect(() => appendMessage(store, "unknown", "unknown-project")).toThrow(
		UnknownProjectError,
	);
	expect(() => store.history({ project: "unknown" })).toThrow(
		UnknownProjectError,
	);
	store.close();
});

test("Project deletion rolls back metadata, history, and sequence together", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-delete-atomic-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const store = new HubStore(databasePath);
	store.createProject({ name: "atomic" });
	appendMessage(store, "atomic", "before-failure");

	const injector = new Database(databasePath);
	injector.run(`
		CREATE TRIGGER fail_project_delete
		BEFORE DELETE ON projects
		BEGIN
			SELECT RAISE(ABORT, 'forced delete failure');
		END
	`);
	expect(() => store.deleteProject("atomic")).toThrow("forced delete failure");
	expect(store.getProject("atomic")?.name).toBe("atomic");
	expect(
		store.history({ project: "atomic" }).messages.map((message) => message.messageId),
	).toEqual(["before-failure"]);
	expect(appendMessage(store, "atomic", "after-failure").message.sequence).toBe(2);

	injector.run("DROP TRIGGER fail_project_delete");
	injector.close();
	expect(store.deleteProject("atomic")).toBe(true);
	store.close();
});

test("deleting and recreating a Project cannot expose old history", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-delete-recreate-"));
	roots.push(root);
	const store = new HubStore(join(root, "messages.sqlite"));
	store.createProject({ name: "recreated" });
	appendMessage(store, "recreated", "old-history");

	expect(store.deleteProject("recreated")).toBe(true);
	expect(store.deleteProject("recreated")).toBe(false);
	store.createProject({ name: "recreated" });
	expect(store.history({ project: "recreated" }).messages).toEqual([]);
	expect(appendMessage(store, "recreated", "new-history").message.sequence).toBe(1);
	store.close();
});
