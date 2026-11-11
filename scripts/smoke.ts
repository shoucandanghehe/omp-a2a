import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HubStore } from "../src/hub/store";
import { hubStoreDatabasePath } from "../src/paths";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-a2a-store-smoke-"));
const databasePath = hubStoreDatabasePath(dataDir);
let store: HubStore | null = null;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERT: ${message}`);
}

try {
	store = new HubStore(databasePath);
	console.log("\n== persistent SQLite Rooms ==");
	store.createRoom({ name: "billing" });
	store.createRoom({ name: "search" });
	assert(
		store
			.listRooms()
			.map((room) => room.name)
			.join(",") === "billing,search",
		"Rooms persist in sorted order",
	);
	store.close();
	store = null;
	store = new HubStore(databasePath);
	assert(store.getRoom("billing")?.name === "billing", "Room reopens");
	assert(store.deleteRoom("billing"), "existing Room deletes");
	assert(!store.deleteRoom("billing"), "Room deletion is idempotent");
	assert(store.listRooms()[0]?.name === "search", "unrelated Room remains");
	console.log("\n== PASS ==");
	console.log("SQLite Room store smoke OK");
} finally {
	store?.close();
	fs.rmSync(dataDir, { recursive: true, force: true });
}
