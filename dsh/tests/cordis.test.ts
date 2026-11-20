import assert from "node:assert/strict";
import { test } from "node:test";
import { Context, Service } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createScope } from "@deepseek-ai/dsh-scope";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import type { Connector } from "../src/binding";
import { createApply } from "../src/index";

test("real Cordis keeps the same scoped tools across Hub disconnect and removes them on unload", async () => {
	const ctx = new Context();
	const agents = new Map<string, Agent>();
	class Agents extends Service {
		constructor(c: Context) {
			super(c, "agents");
		}
		get(id: string) {
			return agents.get(id);
		}
	}
	class Prompts extends Service {
		constructor(c: Context) {
			super(c, "systemPrompt");
		}
		tools() {
			return () => {};
		}
	}
	const services = ctx.plugin({
		name: "test-services",
		async apply(c: Context) {
			await c.plugin(Agents);
			await c.plugin(Prompts);
			await c.plugin(ToolsService, {});
		},
	});
	await services;
	const selected = {
		session: { id: "selected" },
		followup() {},
	} as unknown as Agent;
	const other = { session: { id: "other" }, followup() {} } as unknown as Agent;
	let selectedScope: ReturnType<typeof createScope>;
	let otherScope: ReturnType<typeof createScope>;
	const scopes = ctx.plugin({
		name: "test-scopes",
		apply(c: Context) {
			selectedScope = createScope(c, selected);
			otherScope = createScope(c, other);
			Object.assign(selected, { ctx: selectedScope.ctx });
			Object.assign(other, { ctx: otherScope.ctx });
			agents.set("selected", selected);
			agents.set("other", other);
		},
	});
	await scopes;
	let closed = 0;
	let disconnect: NonNullable<Parameters<Connector>[0]["events"]>["onClose"];
	const adapter = ctx.plugin(
		{
			name: "test-adapter",
			inject: ["agents"],
			apply: createApply(async (options) => {
				disconnect = options.events?.onClose;
				return {
					close: async () => {
						closed++;
					},
					peers: () => [],
					send: async () => {
						throw new Error("unused");
					},
				};
			}),
		},
		{
			hubUrl: "http://127.0.0.1:4173",
			room: "team",
			name: "dsh",
			sessionId: "selected",
		},
	);
	try {
		await adapter;
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(
			ctx.tools
				.definitions(selected)
				.map((tool) => tool.name)
				.sort(),
			["a2a_message", "a2a_peers"],
		);
		assert.equal(ctx.tools.definitions(other).length, 0);
		assert.equal(ctx.tools.definitions().length, 0);
		const online = ctx.tools.schemas(selected);
		assert.ok(disconnect);
		disconnect({ manual: false, code: 1006, reason: "" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(ctx.tools.schemas(selected), online);
		assert.equal(ctx.tools.definitions(other).length, 0);
		assert.equal(closed, 0);
		await adapter.dispose();
		assert.equal(ctx.tools.definitions(selected).length, 0);
		assert.equal(closed, 0);
	} finally {
		await adapter.dispose();
		await scopes.dispose();
		await services.dispose();
	}
});
