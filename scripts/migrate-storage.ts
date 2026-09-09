#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { parseHubCliOptions } from "../src/hub/cli";
import { HubDataLock } from "../src/hub/data-lock";
import { HubStore, MESSAGE_STORAGE_VERSION } from "../src/hub/store";
import { hubLockPath, hubStoreDatabasePath } from "../src/paths";

export const LEGACY_STORAGE_VERSION = 2;

export type StorageMigrationOutcome = "migrated" | "current";

/**
 * Converts one version 2 `messages.sqlite` to the current storage version in a
 * single transaction. `ALTER TABLE ... RENAME COLUMN` leaves the stored schema
 * text identical to the canonical current DDL, so `HubStore` accepts the result
 * without a schema rebuild. Current storage is a no-op; any other version fails
 * loudly instead of converting an unknown database.
 */
export function migrateStorageV2ToV3(
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
			database.run(
				"ALTER TABLE messages RENAME COLUMN target_name TO target_names",
			);
			database.run(
				"ALTER TABLE messages RENAME COLUMN target_presence_id TO target_presence_ids",
			);
			database.run(
				"UPDATE messages SET target_kind = 'all', target_names = NULL, target_presence_ids = NULL WHERE target_kind = 'project'",
			);
			database.run(
				"UPDATE messages SET target_kind = 'agents', target_names = json_array(target_names), target_presence_ids = CASE WHEN target_presence_ids IS NULL THEN NULL ELSE json_array(target_presence_ids) END WHERE target_kind = 'agent'",
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
		const outcome = migrateStorageV2ToV3(databasePath);
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
