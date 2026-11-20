import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { encodeTextPayload } from "../../src/hub/payload";
import type { RealtimeMessage } from "../../src/hub/realtime-types";
import { RoomReconnect } from "../../src/room-reconnect";
import { Binding, type Connector, validateConfig } from "../src/binding";

const config = {
	hubUrl: "http://127.0.0.1:4173",
	room: "team",
	name: "dsh",
	sessionId: "selected",
};
const message: RealtimeMessage = {
	messageId: "m1",
	messageRef: "team:1",
	sequence: 1,
	room: "team",
	createdAt: 0,
	from: { name: "peer", presenceId: "p1" },
	target: { type: "agents", names: ["dsh"], presenceIds: ["p2"] },
	payload: encodeTextPayload("hello"),
	attachments: [],
} as unknown as RealtimeMessage;
async function setup() {
	const received: unknown[] = [];
	const sent: unknown[] = [];
	let closes = 0;
	const agent = {
		followup(value: unknown) {
			received.push(value);
		},
	} as unknown as Agent;
	let current: Agent | undefined = agent;
	let opts: Parameters<Connector>[0];
	const binding = new Binding(
		config,
		agent,
		() => current,
		async (options) => {
			opts = options;
			return {
				close: async () => {
					closes++;
				},
				peers: () => [],
				send: async (value, request) => {
					request?.signal?.throwIfAborted();
					sent.push(value);
					return { replayed: false, message, recipients: ["peer"] };
				},
			};
		},
	);
	await binding.start();
	return {
		binding,
		agent,
		received,
		sent,
		options: () => {
			assert.ok(opts);
			return opts;
		},
		closes: () => closes,
		replace: () => {
			current = {} as Agent;
		},
	};
}
test("requires explicit session and credential-free Hub origin", () => {
	assert.throws(() => validateConfig({ ...config, sessionId: "" }));
	assert.throws(() =>
		validateConfig({ ...config, hubUrl: "http://secret@example.com/" }),
	);
	assert.equal(validateConfig(config).sessionId, "selected");
});
test("inbound relay enters only borrowed Agent and preserves provenance", async () => {
	const s = await setup();
	const handler = s.options().events?.onMessage;
	assert.ok(handler);
	await handler(message);
	assert.equal(s.received.length, 1);
	const payload = s.received[0] as {
		source: { kind: string };
		content: { text: string }[];
	};
	assert.equal(payload.source.kind, "omp-a2a");
	assert.match(payload.content[0].text, /team:1/);
	assert.equal(s.sent.length, 0);
	await s.binding.close();
});
test("same id replacement rejects stale injection and sending", async () => {
	const s = await setup();
	s.replace();
	assert.throws(() => s.binding.receive(message), /no longer current/);
	await assert.rejects(
		s.binding.send(
			s.agent,
			{ target: ["peer"], text: "x" },
			new AbortController().signal,
		),
	);
	assert.equal(s.received.length + s.sent.length, 0);
	await s.binding.close();
});
test("other Agent cannot use bound send even if tool is invoked directly", async () => {
	const s = await setup();
	await assert.rejects(
		s.binding.send(
			{} as Agent,
			{ target: ["peer"], text: "x" },
			new AbortController().signal,
		),
		/caller/,
	);
	assert.equal(s.sent.length, 0);
	await s.binding.close();
});
test("approval request fails closed; ordinary reply retains reference without receipt", async () => {
	const s = await setup();
	const input = { target: ["peer"], text: "reply", replyTo: "team:1" };
	await assert.rejects(
		s.binding.send(
			s.agent,
			{ ...input, requestUserSignature: true },
			new AbortController().signal,
		),
		/nothing was sent/,
	);
	await s.binding.send(s.agent, input, new AbortController().signal);
	assert.equal(s.sent.length, 1);
	assert.equal((s.sent[0] as { replyTo?: string }).replyTo, "team:1");
	assert.equal(
		(s.sent[0] as { userApproval?: unknown }).userApproval,
		undefined,
	);
	await s.binding.close();
});
test("attachments and wrong room fail explicitly", async () => {
	const s = await setup();
	assert.throws(() => s.binding.receive({ ...message, room: "other" }));
	assert.throws(
		() =>
			s.binding.receive({
				...message,
				attachments: [{} as RealtimeMessage["attachments"][number]],
			}),
		/attachments/,
	);
	assert.equal(s.received.length, 0);
	await s.binding.close();
});
test("close is idempotent, aborts connection work, never cancels borrowed Agent", async () => {
	const s = await setup();
	await Promise.all([s.binding.close(), s.binding.close()]);
	assert.equal(s.closes(), 1);
	assert.equal(s.options().signal?.aborted, true);
	assert.throws(() => s.binding.receive(message));
});
test("pre-aborted send sends nothing", async () => {
	const s = await setup();
	await assert.rejects(
		s.binding.send(
			s.agent,
			{ target: ["peer"], text: "x" },
			AbortSignal.abort(),
		),
	);
	assert.equal(s.sent.length, 0);
	await s.binding.close();
});

test("rejects broadcasts, whitespace and oversized UTF-8 text", async () => {
	const s = await setup();
	assert.throws(
		() => s.binding.receive({ ...message, target: { type: "all" } }),
		/directly/,
	);
	for (const text of ["  ", "界".repeat(21846)]) {
		assert.throws(
			() => s.binding.receive({ ...message, payload: encodeTextPayload(text) }),
			/64 KiB/,
		);
		await assert.rejects(
			s.binding.send(
				s.agent,
				{ target: ["peer"], text },
				new AbortController().signal,
			),
			/64 KiB/,
		);
	}
	await assert.rejects(
		s.binding.send(
			s.agent,
			{ target: ["@all"], text: "x" },
			new AbortController().signal,
		),
		/Broadcast/,
	);
	assert.equal(s.sent.length + s.received.length, 0);
	await s.binding.close();
});
test("explicit allowlist denies unlisted inbound and outbound peers", async () => {
	const agent = {
		followup() {
			throw new Error("must not inject");
		},
	} as unknown as Agent;
	const binding = new Binding(
		{ ...config, allowedPeers: [] },
		agent,
		() => agent,
		async () => ({
			close: async () => {},
			peers: () => [{ name: "peer", presenceId: "p" }],
			send: async () => {
				throw new Error("must not send");
			},
		}),
	);
	await binding.start();
	assert.deepEqual(binding.peers(), []);
	assert.throws(() => binding.receive(message), /allowedPeers/);
	await assert.rejects(
		binding.send(
			agent,
			{ target: ["peer"], text: "x" },
			new AbortController().signal,
		),
		/allowedPeers/,
	);
	await binding.close();
});

test("offline tools fail explicitly without dispatching or retrying", async () => {
	const s = await setup();
	s.options().events?.onClose?.({ manual: false, code: 1006, reason: "" });
	assert.throws(() => s.binding.peers(), /Hub is offline/);
	await assert.rejects(
		s.binding.send(
			s.agent,
			{ target: ["peer"], text: "x" },
			new AbortController().signal,
		),
		/Hub is offline/,
	);
	assert.equal(s.sent.length, 0);
	await s.binding.close();
});

test("reconnect retries transport only, ignores stale callbacks and stops on disposal", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let injections = 0;
	let dispatches = 0;
	let closes = 0;
	const attempts: Parameters<Connector>[0][] = [];
	const agent = {
		followup() {
			injections++;
		},
	} as unknown as Agent;
	const binding = new Binding(
		config,
		agent,
		() => agent,
		async (options) => {
			attempts.push(options);
			if (attempts.length === 2) throw new Error("temporary error");
			return {
				peers: () => [],
				close: async () => {
					closes++;
				},
				send: (_input, request) => {
					dispatches++;
					return new Promise((_, reject) => {
						const signal = request?.signal;
						signal?.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				},
			};
		},
	);
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
	const drop = { manual: false, code: 1006, reason: "" };
	try {
		await binding.start();
		const send = binding.send(
			agent,
			{ target: ["peer"], text: "do not replay" },
			new AbortController().signal,
		);
		const rejected = assert.rejects(send, /connection closed/);
		attempts[0].events?.onClose?.(drop);
		attempts[0].events?.onClose?.(drop);
		await rejected;
		t.mock.timers.tick(499);
		assert.equal(attempts.length, 1);
		t.mock.timers.tick(1);
		await flush();
		assert.equal(attempts.length, 2);
		t.mock.timers.tick(999);
		assert.equal(attempts.length, 2);
		t.mock.timers.tick(1);
		await flush();
		assert.equal(attempts.length, 3);
		assert.equal(dispatches, 1);
		assert.equal(attempts[2].room, config.room);
		assert.equal(attempts[2].baseUrl, config.hubUrl);
		assert.equal(attempts[2].name, config.name);
		assert.throws(
			() => attempts[0].events?.onMessage?.(message),
			/not published/,
		);
		attempts[0].events?.onClose?.(drop);
		await attempts[2].events?.onMessage?.(message);
		assert.equal(injections, 1);
		// A successful handoff resets the delayed schedule to 500 ms.
		attempts[2].events?.onClose?.(drop);
		t.mock.timers.tick(500);
		await flush();
		assert.equal(attempts.length, 4);
		attempts[3].events?.onClose?.(drop);
	} finally {
		await binding.close();
	}
	t.mock.timers.tick(10_000);
	assert.equal(attempts.length, 4);
	assert.equal(closes, 0);
});

test("initial name conflict stops retrying and replacement cannot inherit a pending reconnect", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const agent = {} as Agent;
	let current: Agent | undefined = agent;
	let attempts = 0;
	const conflict = new Binding(
		config,
		agent,
		() => current,
		async () => {
			attempts++;
			throw new Error("name_in_use: dsh");
		},
	);
	await assert.rejects(conflict.start(), /name_in_use/);
	t.mock.timers.tick(10_000);
	assert.equal(attempts, 1);
	await conflict.close();
	const offline = new Binding(
		config,
		agent,
		() => current,
		async () => {
			attempts++;
			throw new Error("offline");
		},
	);
	await offline.start();
	current = {} as Agent;
	t.mock.timers.tick(10_000);
	assert.equal(attempts, 2);
	assert.throws(() => offline.peers(), /no longer current/);
	await offline.close();
});

test("shared room reconnect delay caps at ten seconds", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const reconnect = new RoomReconnect();
	let callbacks = 0;
	for (const [i, delay] of [
		500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
	].entries()) {
		reconnect.schedule(() => callbacks++);
		t.mock.timers.tick(delay - 1);
		assert.equal(callbacks, i);
		t.mock.timers.tick(1);
		assert.equal(callbacks, i + 1);
	}
});
