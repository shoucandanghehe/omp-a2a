import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../src/hub/client";
import { startHubServer } from "../src/hub/server";
import { RoomConnections } from "../src/room-connections";

test("a new join waits for earlier removal of its Room without blocking other Rooms", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-a2a-room-connections-"));
	const hub = await startHubServer({ host: "127.0.0.1", port: 0, dataDir });
	const client = new HubClient(hub.listenUrl);
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<HubClient>();
	const connected: string[] = [];
	let clientRequests = 0;
	const rooms = new RoomConnections({
		getClient: async () => {
			clientRequests += 1;
			if (clientRequests > 1) return client;
			started.resolve();
			return await release.promise;
		},
		events: { onConnected: (room) => connected.push(room) },
	});

	try {
		await client.createRoom({ name: "alpha" });
		await client.createRoom({ name: "beta" });
		const obsolete = rooms.connect("alpha", "worker", hub.listenUrl);
		await started.promise;
		const removed = rooms.disconnect("alpha");
		expect(rooms.get("alpha")).toBeUndefined();

		const rejoin = rooms.connect("alpha", "worker", hub.listenUrl);
		const sibling = rooms.connect("beta", "worker", hub.listenUrl);
		const nextTurn = Promise.withResolvers<void>();
		setImmediate(nextTurn.resolve);
		await nextTurn.promise;
		expect(clientRequests).toBe(2);
		await sibling;
		expect(rooms.get("beta")?.connected).toBe(true);
		expect(rooms.get("alpha")?.connected).toBe(false);
		expect(connected).toEqual(["beta"]);

		release.resolve(client);
		expect(await removed).toBe(true);
		await Promise.all([rejoin, obsolete]);
		expect(rooms.get("alpha")?.connected).toBe(true);
		expect(connected).toEqual(["beta", "alpha"]);
	} finally {
		release.resolve(client);
		await rooms.disconnect();
		await hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
