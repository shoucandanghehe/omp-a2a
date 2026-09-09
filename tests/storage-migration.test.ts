import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LEGACY_STORAGE_VERSION,
	migrateStorageV2ToV3,
} from "../scripts/migrate-storage";
import { encodeTextPayload } from "../src/hub/payload";
import { HubStore } from "../src/hub/store";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/**
 * Reproduces a real version 2 database. Version 2 differs from the current
 * schema only by the two message target column names, so reverting them yields
 * the exact stored schema text a version 2 Hub wrote.
 */
function createV2Database(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-storage-migration-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	new HubStore(databasePath).close();
	const database = new Database(databasePath);
	database.transaction(() => {
		database.run(
			"ALTER TABLE messages RENAME COLUMN target_names TO target_name",
		);
		database.run(
			"ALTER TABLE messages RENAME COLUMN target_presence_ids TO target_presence_id",
		);
		database.run(`PRAGMA user_version = ${LEGACY_STORAGE_VERSION}`);
	})();
	database.run(
		"INSERT INTO projects(name, created_at, created_by_cwd) VALUES ('billing', 1, '/repo')",
	);
	database.run(
		"INSERT INTO project_sequences(project, next_sequence) VALUES ('billing', 4)",
	);
	const insert = database.query(`
		INSERT INTO messages(
			project, project_sequence, msg_id, sender_name, sender_presence_id,
			target_kind, target_name, target_presence_id, encoding, data,
			attachments, user_approved, created_at, reply_to_sequence
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const payload = encodeTextPayload("legacy body");
	const row = (
		sequence: number,
		messageId: string,
		targetKind: string,
		targetName: string | null,
		targetPresenceId: string | null,
		userApproved: number,
		replyToSequence: number | null,
	) => [
		"billing",
		sequence,
		messageId,
		"api",
		"presence-api",
		targetKind,
		targetName,
		targetPresenceId,
		payload.encoding,
		payload.data,
		"[]",
		userApproved,
		100 + sequence,
		replyToSequence,
	];
	insert.run(
		...row(1, "legacy-direct", "agent", "web", "presence-web", 1, null),
	);
	insert.run(...row(2, "legacy-broadcast", "project", null, null, 0, 1));
	insert.run(...row(3, "legacy-unresolved", "agent", "test", null, 0, null));
	database.close();
	return databasePath;
}

test("version 2 storage migrates to the current schema with preserved history", () => {
	const databasePath = createV2Database();

	expect(migrateStorageV2ToV3(databasePath)).toBe("migrated");

	const store = new HubStore(databasePath);
	const messages = store.history({ project: "billing", limit: 10 }).messages;
	expect(messages.map((message) => message.messageId)).toEqual([
		"legacy-direct",
		"legacy-broadcast",
		"legacy-unresolved",
	]);
	expect(messages[0]?.target).toEqual({
		type: "agents",
		names: ["web"],
		presenceIds: ["presence-web"],
	});
	expect(messages[1]?.target).toEqual({ type: "all" });
	expect(messages[2]?.target).toEqual({ type: "agents", names: ["test"] });
	expect(messages[0]?.userApproval).toEqual({ kind: "omp-ui" });
	expect(messages[1]?.replyTo).toBe("billing:1");
	expect(messages.map((message) => message.sequence)).toEqual([1, 2, 3]);
	expect(store.listProjects()).toEqual([
		{ name: "billing", createdAt: 1, createdByCwd: "/repo" },
	]);
	store.close();
});

test("migration is a no-op on current storage", () => {
	const databasePath = createV2Database();

	expect(migrateStorageV2ToV3(databasePath)).toBe("migrated");
	expect(migrateStorageV2ToV3(databasePath)).toBe("current");

	const store = new HubStore(databasePath);
	expect(
		store.history({ project: "billing", limit: 10 }).messages,
	).toHaveLength(3);
	store.close();
});

test("unknown storage versions fail loudly without converting", () => {
	const databasePath = createV2Database();
	const database = new Database(databasePath);
	database.run("PRAGMA user_version = 1");
	database.close();

	expect(() => migrateStorageV2ToV3(databasePath)).toThrow(
		"unsupported storage version 1",
	);
});
