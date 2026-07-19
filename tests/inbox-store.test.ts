import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InboxStore,
	OutOfOrderAcknowledgmentError,
} from "../src/hub/inbox";
import { encodeTextPayload } from "../src/hub/payload";
import type { HubWireMessageDraft } from "../src/hub/types";

let store: InboxStore | null = null;
let root: string | null = null;

afterEach(() => {
	store?.close();
	if (root) rmSync(root, { recursive: true, force: true });
	store = null;
	root = null;
});

function draft(msgId: string, text: string): HubWireMessageDraft {
	return {
		kind: "message",
		msgId,
		project: "storage",
		from: "sender",
		to: "receiver",
		payload: encodeTextPayload(text),
		createdAt: 1,
	};
}

test("storage read and acknowledgment preserve ordered state across restart", () => {
	root = mkdtempSync(join(tmpdir(), "omp-a2a-store-"));
	const databasePath = join(root, "inbox.sqlite");
	store = new InboxStore(databasePath);
	const first = store.enqueue(draft("z-first", "first"), () => {});
	const second = store.enqueue(draft("a-second", "second"), () => {});

	expect(store.read("storage", "receiver")).toEqual({ messages: [first, second], cursor: 0 });
	expect(() => store!.acknowledge("storage", "receiver", [second.msgId])).toThrow(
		OutOfOrderAcknowledgmentError,
	);
	expect(store.acknowledge("storage", "receiver", [first.msgId])).toEqual({
		acknowledgments: [
			{ messageId: first.msgId, serverSequence: 1, status: "acknowledged" },
		],
		cursor: 1,
	});
	store.close();

	store = new InboxStore(databasePath);
	expect(store.acknowledge("storage", "receiver", [first.msgId])).toEqual({
		acknowledgments: [
			{ messageId: first.msgId, serverSequence: 1, status: "already_acknowledged" },
		],
		cursor: 1,
	});
	expect(store.read("storage", "receiver")).toEqual({ messages: [second], cursor: 1 });
});
