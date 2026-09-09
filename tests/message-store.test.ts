import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBinaryPayload, encodeTextPayload } from "../src/hub/payload";
import {
	HubStore,
	MESSAGE_STORAGE_VERSION,
	MessageIdConflictError,
	ProjectConflictError,
	UnknownProjectError,
} from "../src/hub/store";

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
		target: { type: "all" },
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
	const databasePath = join(root, "messages.sqlite");
	const store = new HubStore(databasePath);
	store.createProject({ name: "billing" });

	const first = store.append({
		messageId: "message-1",
		project: "billing",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "agents", names: ["web"], presenceIds: ["presence-web"] },
		payload: encodeTextPayload("check the login contract"),
		attachments: [],
		createdAt: 100,
		userApproval: { kind: "omp-ui" },
	});
	const second = store.append({
		messageId: "message-2",
		project: "billing",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "all" },
		payload: encodeTextPayload("freeze the contract"),
		attachments: [],
		createdAt: 101,
		replyTo: first.message.messageRef,
	});
	expect(first).toMatchObject({
		replayed: false,
		message: {
			sequence: 1,
			messageRef: "billing:1",
			userApproval: { kind: "omp-ui" },
		},
	});
	expect(second).toMatchObject({
		replayed: false,
		message: { sequence: 2, messageRef: "billing:2", replyTo: "billing:1" },
	});
	expect(second.message.userApproval).toBeUndefined();
	expect(
		store
			.history({ project: "billing", limit: 10 })
			.messages.map((message) => message.messageRef),
	).toEqual(["billing:1", "billing:2"]);

	const repeated = store.append({
		messageId: "message-1",
		project: "billing",
		from: { name: "api", presenceId: "another-presence" },
		target: {
			type: "agents",
			names: ["web"],
			presenceIds: ["another-web-presence"],
		},
		payload: encodeTextPayload("check the login contract"),
		attachments: [],
		createdAt: 999,
		userApproval: { kind: "omp-ui" },
	});
	expect(repeated).toEqual({ replayed: true, message: first.message });
	expect(() =>
		store.append({
			messageId: "message-1",
			project: "billing",
			from: { name: "api", presenceId: "presence-api" },
			target: { type: "agents", names: ["web"], presenceIds: ["presence-web"] },
			payload: encodeTextPayload("check the login contract"),
			attachments: [],
			createdAt: 100,
		}),
	).toThrow(MessageIdConflictError);
	expect(() =>
		store.append({
			messageId: "message-1",
			project: "billing",
			from: { name: "api", presenceId: "presence-api" },
			target: { type: "agents", names: ["web"], presenceIds: ["presence-web"] },
			payload: encodeTextPayload("different body"),
			attachments: [],
			createdAt: 100,
			userApproval: { kind: "omp-ui" },
		}),
	).toThrow(MessageIdConflictError);

	store.close();
	const database = new Database(databasePath);
	const columns = database
		.query<{ name: string }, []>("PRAGMA table_info(messages)")
		.all()
		.map((column) => column.name);
	expect(columns).toContain("user_approved");
	expect(
		database
			.query<{ msg_id: string; user_approved: number }, []>(
				"SELECT msg_id, user_approved FROM messages ORDER BY project_sequence",
			)
			.all(),
	).toEqual([
		{ msg_id: "message-1", user_approved: 1 },
		{ msg_id: "message-2", user_approved: 0 },
	]);
	expect(() => database.run("UPDATE messages SET user_approved = 2")).toThrow();
	expect(columns).not.toContain("uncompressed_bytes");
	expect(columns).not.toContain("content_bytes");
	database.close();
});

test("current storage schema is versioned and reopens", () => {
	expect(MESSAGE_STORAGE_VERSION).toBe(3);
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-messages-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const store = new HubStore(databasePath);
	store.createProject({ name: "current" });
	store.append({
		messageId: "current-schema",
		project: "current",
		from: { name: "api", presenceId: "presence-api" },
		target: { type: "all" },
		payload: encodeTextPayload("persist the current schema"),
		attachments: [],
		createdAt: 100,
		userApproval: { kind: "omp-ui" },
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
			userApproval: { kind: "omp-ui" },
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
			target: { type: "all" },
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
	const store = new HubStore(join(root, "messages.sqlite"));
	store.createProject({ name: "large-limit" });
	for (let index = 1; index <= 501; index++) {
		store.append({
			messageId: `large-limit-${index}`,
			project: "large-limit",
			from: { name: "api", presenceId: "presence-api" },
			target: { type: "all" },
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

test("storage version mismatch fails closed without changing the database", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-unsupported-storage-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const unsupported = new Database(databasePath, { create: true });
	unsupported.run("CREATE TABLE messages (id TEXT)");
	unsupported.run(`PRAGMA user_version = ${MESSAGE_STORAGE_VERSION + 1}`);
	unsupported.close();
	const before = readFileSync(databasePath);

	expect(() => new HubStore(databasePath)).toThrow(UNSUPPORTED_STORAGE_MESSAGE);
	expect(readFileSync(databasePath)).toEqual(before);
});

test("pre-existing empty storage fails closed", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-empty-storage-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	new Database(databasePath, { create: true }).close();

	expect(() => new HubStore(databasePath)).toThrow(UNSUPPORTED_STORAGE_MESSAGE);
});

test("current storage version rejects an incomplete schema", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-invalid-storage-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const invalid = new Database(databasePath, { create: true });
	invalid.run("CREATE TABLE messages (id TEXT)");
	invalid.run(`PRAGMA user_version = ${MESSAGE_STORAGE_VERSION}`);
	invalid.close();

	expect(() => new HubStore(databasePath)).toThrow(UNSUPPORTED_STORAGE_MESSAGE);
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
		target: { type: "all" as const },
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
		store
			.history({ project: "atomic" })
			.messages.map((message) => message.messageId),
	).toEqual(["before-failure"]);
	expect(appendMessage(store, "atomic", "after-failure").message.sequence).toBe(
		2,
	);

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
	expect(
		appendMessage(store, "recreated", "new-history").message.sequence,
	).toBe(1);
	store.close();
});
