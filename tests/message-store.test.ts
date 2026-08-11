import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HubStore,
	MAX_HISTORY_BYTES,
	MESSAGE_STORAGE_VERSION,
	MessageIdConflictError,
	ProjectConflictError,
	UnknownProjectError,
} from "../src/hub/store";
import { encodeBinaryPayload, encodeTextPayload } from "../src/hub/payload";

const roots: string[] = [];
const UNSUPPORTED_STORAGE_MESSAGE =
	"unsupported pre-release storage; start with an empty data directory";

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
		replayed: false,
		message: { sequence: 1, messageRef: "billing:1" },
	});
	expect(second).toMatchObject({
		replayed: false,
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
	expect(repeated).toEqual({ replayed: true, message: first.message });
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

test("current storage schema is versioned and reopens", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const store = new HubStore(databasePath);
	store.createProject({ name: "current" });
	store.append({
		messageId: "current-schema",
		project: "current",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "project" },
		payload: encodeTextPayload("persist the current schema"),
		attachments: [],
		createdAt: 100,
	});
	store.close();

	const database = new Database(databasePath);
	expect(
		database.query<{ user_version: number }, []>("PRAGMA user_version").get()
			?.user_version,
	).toBe(MESSAGE_STORAGE_VERSION);
	database.close();

	const reopened = new HubStore(databasePath);
	expect(reopened.history({ project: "current" }).messages).toMatchObject([
		{
			messageId: "current-schema",
			messageRef: "current:1",
			attachments: [],
		},
	]);
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

test("storage version mismatch fails closed without changing the database", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-unsupported-storage-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const unsupported = new Database(databasePath, { create: true });
	unsupported.run("CREATE TABLE messages (id TEXT)");
	unsupported.run(`PRAGMA user_version = ${MESSAGE_STORAGE_VERSION + 1}`);
	unsupported.close();
	const before = readFileSync(databasePath);

	expect(() => new HubStore(databasePath)).toThrow(
		UNSUPPORTED_STORAGE_MESSAGE,
	);
	expect(readFileSync(databasePath)).toEqual(before);
});

test("pre-existing empty storage fails closed", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-empty-storage-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	new Database(databasePath, { create: true }).close();

	expect(() => new HubStore(databasePath)).toThrow(
		UNSUPPORTED_STORAGE_MESSAGE,
	);
});


test("current storage version rejects an incomplete schema", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-invalid-storage-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const invalid = new Database(databasePath, { create: true });
	invalid.run("CREATE TABLE messages (id TEXT)");
	invalid.run(`PRAGMA user_version = ${MESSAGE_STORAGE_VERSION}`);
	invalid.close();

	expect(() => new HubStore(databasePath)).toThrow(
		UNSUPPORTED_STORAGE_MESSAGE,
	);
});

test("current storage version rejects unexpected schema objects", () => {
	const unexpectedObjects = [
		{
			type: "table",
			sql: "CREATE TABLE unexpected_table (id INTEGER)",
		},
		{
			type: "index",
			sql: "CREATE INDEX unexpected_index ON messages(created_at)",
		},
		{
			type: "trigger",
			sql: "CREATE TRIGGER unexpected_trigger AFTER INSERT ON messages BEGIN SELECT 1; END",
		},
		{
			type: "view",
			sql: "CREATE VIEW unexpected_view AS SELECT project FROM messages",
		},
	];
	const outcomes: Array<{
		type: string;
		accepted: boolean;
		error?: string;
	}> = [];

	for (const unexpected of unexpectedObjects) {
		const root = mkdtempSync(join(tmpdir(), "omp-a2a-extra-schema-"));
		roots.push(root);
		const databasePath = join(root, "messages.sqlite");
		const current = new HubStore(databasePath);
		current.close();
		const database = new Database(databasePath);
		database.run(unexpected.sql);
		database.close();

		try {
			const reopened = new HubStore(databasePath);
			reopened.close();
			outcomes.push({ type: unexpected.type, accepted: true });
		} catch (error) {
			outcomes.push({
				type: unexpected.type,
				accepted: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	expect(outcomes).toEqual([
		{
			type: "table",
			accepted: false,
			error: UNSUPPORTED_STORAGE_MESSAGE,
		},
		{
			type: "index",
			accepted: false,
			error: UNSUPPORTED_STORAGE_MESSAGE,
		},
		{
			type: "trigger",
			accepted: false,
			error: UNSUPPORTED_STORAGE_MESSAGE,
		},
		{
			type: "view",
			accepted: false,
			error: UNSUPPORTED_STORAGE_MESSAGE,
		},
	]);

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
	).toEqual({ replayed: true, message: first.message });
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
