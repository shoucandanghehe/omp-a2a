import { Database } from "bun:sqlite";
import * as path from "node:path";
import { ensureDir } from "../paths";

export class HubDataDirInUseError extends Error {}

export class HubDataLock {
	#database: Database;
	#closed = false;

	constructor(lockDatabasePath: string, dataDir: string) {
		ensureDir(path.dirname(lockDatabasePath));
		this.#database = new Database(lockDatabasePath, { create: true });
		try {
			this.#database.run("PRAGMA busy_timeout = 0");
			this.#database.run("PRAGMA locking_mode = EXCLUSIVE");
			this.#database.run("BEGIN EXCLUSIVE");
			this.#database.run("CREATE TABLE IF NOT EXISTS hub_lock (singleton INTEGER PRIMARY KEY CHECK(singleton = 1))");
		} catch (error) {
			this.#database.close();
			if (error instanceof Error && /locked|busy/i.test(error.message)) {
				throw new HubDataDirInUseError(`Hub data directory is already in use: ${dataDir}`);
			}
			throw error;
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#database.run("ROLLBACK");
		} finally {
			this.#database.close();
		}
	}
}
