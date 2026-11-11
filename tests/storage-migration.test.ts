import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LEGACY_STORAGE_VERSION,
	migrateStorageV3ToV4,
} from "../scripts/migrate-storage";
import { HubStore } from "../src/hub/store";

const V3_SCHEMA = [
	`CREATE TABLE projects (
		name TEXT PRIMARY KEY,
		display_name TEXT,
		description TEXT,
		created_at INTEGER NOT NULL,
		created_by_cwd TEXT
	)`,
	`CREATE TABLE project_sequences (
		project TEXT PRIMARY KEY NOT NULL,
		next_sequence INTEGER NOT NULL
	)`,
	`CREATE TABLE messages (
		project TEXT NOT NULL,
		project_sequence INTEGER NOT NULL,
		msg_id TEXT NOT NULL UNIQUE,
		sender_name TEXT NOT NULL,
		sender_presence_id TEXT NOT NULL,
		target_kind TEXT NOT NULL,
		target_names TEXT,
		target_presence_ids TEXT,
		encoding TEXT NOT NULL,
		data TEXT NOT NULL,
		attachments TEXT NOT NULL,
		user_approved INTEGER NOT NULL CHECK (user_approved IN (0, 1)),
		created_at INTEGER NOT NULL,
		reply_to_sequence INTEGER,
		PRIMARY KEY(project, project_sequence)
	)`,
	"CREATE INDEX messages_project_sender ON messages(project, sender_name, project_sequence)",
];

const V4_SCHEMA = [
	{
		type: "index",
		name: "messages_room_sender",
		sql: "CREATE INDEX messages_room_sender ON messages(room, sender_name, room_sequence)",
	},
	{
		type: "table",
		name: "messages",
		sql: `CREATE TABLE messages (
			room TEXT NOT NULL,
			room_sequence INTEGER NOT NULL,
			msg_id TEXT NOT NULL UNIQUE,
			sender_name TEXT NOT NULL,
			sender_presence_id TEXT NOT NULL,
			target_kind TEXT NOT NULL,
			target_names TEXT,
			target_presence_ids TEXT,
			encoding TEXT NOT NULL,
			data TEXT NOT NULL,
			attachments TEXT NOT NULL,
			user_approved INTEGER NOT NULL CHECK (user_approved IN (0, 1)),
			created_at INTEGER NOT NULL,
			reply_to_sequence INTEGER,
			PRIMARY KEY(room, room_sequence)
		)`,
	},
	{
		type: "table",
		name: "room_sequences",
		sql: `CREATE TABLE room_sequences (
			room TEXT PRIMARY KEY NOT NULL,
			next_sequence INTEGER NOT NULL
		)`,
	},
	{
		type: "table",
		name: "rooms",
		sql: `CREATE TABLE rooms (
			name TEXT PRIMARY KEY,
			display_name TEXT,
			description TEXT,
			created_at INTEGER NOT NULL,
			created_by_cwd TEXT
		)`,
	},
];

const roots: string[] = [];

const attachments =
	'[{"name":"evidence.bin","payload":{"encoding":"base64","data":"AAEC/w=="}}]';
const messages = [
	[
		"billing",
		1,
		"legacy-direct",
		"api",
		"presence-api",
		"agents",
		'["web","test"]',
		'["presence-web","presence-test"]',
		"identity",
		"legacy body\nwith unicode: 房间",
		attachments,
		1,
		101,
		null,
	],
	[
		"billing",
		2,
		"legacy-broadcast",
		"web",
		"presence-web",
		"all",
		null,
		null,
		"identity",
		"broadcast body",
		"[]",
		0,
		102,
		1,
	],
	[
		"billing",
		3,
		"legacy-unresolved",
		"api",
		"presence-api",
		"agents",
		'["test"]',
		null,
		"identity",
		"unresolved body",
		"[]",
		0,
		103,
		null,
	],
	[
		"search",
		1,
		"other-room",
		"test",
		"presence-test",
		"all",
		null,
		null,
		"identity",
		"another Room",
		attachments,
		1,
		104,
		null,
	],
];

function normalizeSchema(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

function readSchema(database: Database) {
	return database
		.query<{ type: string; name: string; sql: string }, []>(
			"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
		)
		.all()
		.map((row) => ({ ...row, sql: normalizeSchema(row.sql) }));
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** Builds the exact schema written by a version 3 Hub, without current HubStore. */
function createV3Database(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-a2a-storage-migration-"));
	roots.push(root);
	const databasePath = join(root, "messages.sqlite");
	const database = new Database(databasePath);
	database.transaction(() => {
		for (const sql of V3_SCHEMA) database.run(sql);
		database.run(`PRAGMA user_version = ${LEGACY_STORAGE_VERSION}`);
		database.run(
			"INSERT INTO projects VALUES ('billing', 'Billing Room', 'Persistent history', 1, '/repo')",
		);
		database.run("INSERT INTO projects VALUES ('search', NULL, NULL, 2, NULL)");
		database.run(
			"INSERT INTO project_sequences VALUES ('billing', 8), ('search', 2)",
		);
		const insert = database.query(`
			INSERT INTO messages(
				project, project_sequence, msg_id, sender_name, sender_presence_id,
				target_kind, target_names, target_presence_ids, encoding, data,
				attachments, user_approved, created_at, reply_to_sequence
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const row of messages) insert.run(...row);
	})();
	database.close();
	return databasePath;
}

test("version 3 storage migrates to exact version 4 schema with every value preserved", () => {
	const databasePath = createV3Database();

	expect(migrateStorageV3ToV4(databasePath)).toBe("migrated");

	const database = new Database(databasePath);
	expect(database.query("PRAGMA user_version").get()).toEqual({
		user_version: 4,
	});
	expect(readSchema(database)).toEqual(
		V4_SCHEMA.map((row) => ({ ...row, sql: normalizeSchema(row.sql) })),
	);
	expect<unknown>(
		database.query("SELECT * FROM rooms ORDER BY name").values(),
	).toEqual([
		["billing", "Billing Room", "Persistent history", 1, "/repo"],
		["search", null, null, 2, null],
	]);
	expect<unknown>(
		database.query("SELECT * FROM room_sequences ORDER BY room").values(),
	).toEqual([
		["billing", 8],
		["search", 2],
	]);
	expect<unknown>(
		database
			.query("SELECT * FROM messages ORDER BY room, room_sequence")
			.values(),
	).toEqual(messages);
	database.close();

	const store = new HubStore(databasePath);
	const history = store.history({ room: "billing", limit: 10 }).messages;
	expect(history.map((message) => message.messageId)).toEqual([
		"legacy-direct",
		"legacy-broadcast",
		"legacy-unresolved",
	]);
	expect(history[0]?.target).toEqual({
		type: "agents",
		names: ["web", "test"],
		presenceIds: ["presence-web", "presence-test"],
	});
	expect(history[0]?.attachments).toEqual(JSON.parse(attachments));
	expect(history[0]?.userApproval).toEqual({ kind: "omp-ui" });
	expect(history[1]?.target).toEqual({ type: "all" });
	expect(history[1]?.replyTo).toBe("billing:1");
	expect(history[2]?.target).toEqual({ type: "agents", names: ["test"] });
	expect(store.listRooms()).toEqual([
		{
			name: "billing",
			displayName: "Billing Room",
			description: "Persistent history",
			createdAt: 1,
			createdByCwd: "/repo",
		},
		{ name: "search", createdAt: 2 },
	]);
	store.close();
});

test("migration is a no-op on current storage on the second run", () => {
	const databasePath = createV3Database();

	expect(migrateStorageV3ToV4(databasePath)).toBe("migrated");
	expect(migrateStorageV3ToV4(databasePath)).toBe("current");

	const database = new Database(databasePath);
	expect<unknown>(
		database
			.query("SELECT * FROM messages ORDER BY room, room_sequence")
			.values(),
	).toEqual(messages);
	database.close();
});

test("unknown storage versions fail loudly without converting", () => {
	const databasePath = createV3Database();
	const database = new Database(databasePath);
	database.run("PRAGMA user_version = 1");
	const schemaBefore = readSchema(database);
	database.close();

	expect(() => migrateStorageV3ToV4(databasePath)).toThrow(
		"unsupported storage version 1",
	);
	const unchanged = new Database(databasePath);
	expect(unchanged.query("PRAGMA user_version").get()).toEqual({
		user_version: 1,
	});
	expect(readSchema(unchanged)).toEqual(schemaBefore);
	expect<unknown>(
		unchanged
			.query("SELECT * FROM messages ORDER BY project, project_sequence")
			.values(),
	).toEqual(messages);
	unchanged.close();
});
