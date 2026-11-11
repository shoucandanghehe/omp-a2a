#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { parseHubCliOptions } from "../src/hub/cli";
import { HubDataLock } from "../src/hub/data-lock";
import { HubStore, MESSAGE_STORAGE_VERSION } from "../src/hub/store";
import { hubLockPath, hubStoreDatabasePath } from "../src/paths";

export const LEGACY_STORAGE_VERSION = 3;

export type StorageMigrationOutcome = "migrated" | "current";

/**
 * Converts one version 3 `messages.sqlite` to the current storage version in a
 * single transaction. Rebuilding the tables preserves canonical schema text:
 * SQLite quotes renamed table names, which the exact-schema guard rejects.
 * Current storage is a no-op; any other version fails loudly.
 */
export function migrateStorageV3ToV4(
	databasePath: string,
): StorageMigrationOutcome {
	if (!existsSync(databasePath))
		throw new Error(`storage database not found: ${databasePath}`);
	const database = new Database(databasePath);
	try {
		const version =
			database.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version ?? 0;
		if (version === MESSAGE_STORAGE_VERSION) return "current";
		if (version !== LEGACY_STORAGE_VERSION) {
			throw new Error(
				`unsupported storage version ${version}; expected ${LEGACY_STORAGE_VERSION} (migrate) or ${MESSAGE_STORAGE_VERSION} (current)`,
			);
		}
		database.transaction(() => {
			database.run(`
				CREATE TABLE rooms (
					name TEXT PRIMARY KEY,
					display_name TEXT,
					description TEXT,
					created_at INTEGER NOT NULL,
					created_by_cwd TEXT
				)
			`);
			database.run(`
				INSERT INTO rooms(name, display_name, description, created_at, created_by_cwd)
				SELECT name, display_name, description, created_at, created_by_cwd FROM projects
			`);
			database.run(`
				CREATE TABLE room_sequences (
					room TEXT PRIMARY KEY NOT NULL,
					next_sequence INTEGER NOT NULL
				)
			`);
			database.run(`
				INSERT INTO room_sequences(room, next_sequence)
				SELECT project, next_sequence FROM project_sequences
			`);
			database.run("ALTER TABLE messages RENAME TO legacy_messages");
			database.run(`
				CREATE TABLE messages (
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
				)
			`);
			database.run(`
				INSERT INTO messages(
					room, room_sequence, msg_id, sender_name, sender_presence_id,
					target_kind, target_names, target_presence_ids, encoding, data,
					attachments, user_approved, created_at, reply_to_sequence
				)
				SELECT project, project_sequence, msg_id, sender_name, sender_presence_id,
					target_kind, target_names, target_presence_ids, encoding, data,
					attachments, user_approved, created_at, reply_to_sequence
				FROM legacy_messages
			`);
			database.run("DROP TABLE legacy_messages");
			database.run("DROP TABLE project_sequences");
			database.run("DROP TABLE projects");
			database.run(
				"CREATE INDEX messages_room_sender ON messages(room, sender_name, room_sequence)",
			);
			database.run(`PRAGMA user_version = ${MESSAGE_STORAGE_VERSION}`);
		})();
		return "migrated";
	} finally {
		database.close();
	}
}

async function run(): Promise<void> {
	const dataDir = path.resolve(
		parseHubCliOptions(process.argv.slice(2)).dataDir,
	);
	const databasePath = hubStoreDatabasePath(dataDir);
	if (!existsSync(databasePath)) {
		console.log(
			JSON.stringify({
				ok: true,
				dataDir,
				databasePath,
				outcome: "absent",
				storageVersion: MESSAGE_STORAGE_VERSION,
			}),
		);
		return;
	}
	const lock = new HubDataLock(hubLockPath(dataDir), dataDir);
	try {
		const outcome = migrateStorageV3ToV4(databasePath);
		// Reopen through the canonical store so the guard proves the result.
		if (outcome === "migrated") new HubStore(databasePath).close();
		console.log(
			JSON.stringify({
				ok: true,
				dataDir,
				databasePath,
				outcome,
				storageVersion: MESSAGE_STORAGE_VERSION,
			}),
		);
	} finally {
		lock.close();
	}
}

if (import.meta.main) {
	run().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
