import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createApply } from "../src/index";

const config = {
	hubUrl: "http://127.0.0.1:4173",
	room: "team",
	name: "dsh",
	sessionId: "selected",
};
function fixture(disconnectDuringConnect = false) {
	const listeners = new Map<
		string,
		(payload: { agent: Agent }) => void | Promise<void>
	>();
	const effects: (() => void | Promise<void>)[] = [];
	const tools: unknown[] = [];
	let closes = 0;
	let connections = 0;
	let toolDisposals = 0;
	const makeAgent = (id: string) =>
		({
			session: { id },
			followup() {},
			ctx: {
				plugin(plugin: {
					apply(ctx: { tools: { register(tool: unknown): void } }): void;
				}) {
					plugin.apply({
						tools: {
							register(tool: unknown) {
								tools.push(tool);
							},
						},
					});
					return {
						dispose() {
							toolDisposals++;
						},
					};
				},
			},
		}) as unknown as Agent;
	const selected = makeAgent("selected");
	const other = makeAgent("other");
	const registry = new Map<string, Agent>();
	const ctx = {
		agents: { get: (id: string) => registry.get(id) },
		on: (
			name: string,
			callback: (payload: { agent: Agent }) => void | Promise<void>,
		) => listeners.set(name, callback),
		effect: (fn: () => () => void | Promise<void>) => effects.push(fn()),
	} as unknown as Context;
	const apply = createApply(async (options) => {
		connections++;
		if (disconnectDuringConnect) {
			options.events?.onClose?.({ manual: false, code: 1006, reason: "" });
		}
		return {
			close: async () => {
				closes++;
			},
			peers: () => [],
			send: async () => {
				throw new Error("unused");
			},
		};
	});
	return {
		apply,
		ctx,
		registry,
		selected,
		other,
		tools,
		listeners,
		effects,
		counts: () => ({ connections, closes, toolDisposals }),
	};
}
test("waits for exact configured session; ignores all others", async () => {
	const f = fixture();
	await f.apply(f.ctx, config);
	f.registry.set("other", f.other);
	await f.listeners.get("agent/created")?.({ agent: f.other });
	assert.equal(f.counts().connections, 0);
	assert.equal(f.tools.length, 0);
	f.registry.set("selected", f.selected);
	await f.listeners.get("agent/created")?.({ agent: f.selected });
	assert.equal(f.counts().connections, 1);
	assert.equal(f.tools.length, 2);
	await f.effects[0]();
	assert.equal(f.counts().closes, 1);
	assert.equal(f.counts().toolDisposals, 1);
});
test("binds pre-existing session once and never rebinds after disposal", async () => {
	const f = fixture();
	f.registry.set("selected", f.selected);
	await f.apply(f.ctx, config);
	await f.listeners.get("agent/created")?.({ agent: f.selected });
	assert.equal(f.counts().connections, 1);
	f.listeners.get("agent/disposed")?.({ agent: f.selected });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(f.counts().toolDisposals, 1);
	await f.listeners.get("agent/created")?.({ agent: f.selected });
	assert.equal(f.counts().connections, 1);
	await f.effects[0]();
});
test("other Agent disposal cannot disconnect the selected one", async () => {
	const f = fixture();
	f.registry.set("selected", f.selected);
	await f.apply(f.ctx, config);
	f.listeners.get("agent/disposed")?.({ agent: f.other });
	assert.equal(f.counts().closes, 0);
	await f.effects[0]();
});

test("keeps scoped tools if the Hub disconnects during attach", async () => {
	const f = fixture(true);
	f.registry.set("selected", f.selected);
	await f.apply(f.ctx, config);
	assert.equal(f.tools.length, 2);
	assert.deepEqual(f.counts(), { connections: 1, closes: 1, toolDisposals: 0 });
	await f.effects[0]();
	assert.equal(f.counts().toolDisposals, 1);
});
