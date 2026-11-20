import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	Binding,
	type Config,
	type Connector,
	validateConfig,
} from "./binding";

export type { Config } from "./binding";
export const name = "omp-a2a";
export const inject = ["agents"];

export function createApply(connect?: Connector) {
	return function apply(ctx: Context, input: Config) {
		const config = validateConfig(input);
		const id = SessionId(config.sessionId);
		let selected: Agent | undefined;
		let binding: Binding | undefined;
		let stopped = false;
		let disposeTools: (() => Promise<void> | void) | undefined;
		let shutdown: Promise<void> | undefined;
		function stop() {
			stopped = true;
			shutdown ??= Promise.resolve().then(async () => {
				await Promise.all([binding?.close(), disposeTools?.()]);
			});
			return shutdown;
		}
		async function attach(agent: Agent) {
			if (stopped || selected || agent.session.id !== id) return;
			selected = agent;
			const next = new Binding(
				config,
				agent,
				() => ctx.agents.get(id),
				connect,
			);
			binding = next;
			const fork = agent.ctx.plugin({
				name: "omp-a2a-session-tools",
				inject: ["tools"],
				apply(scope: Context) {
					scope.tools.register(
						defineTool({
							name: "a2a_peers",
							description:
								"List current peers in this session’s configured A2A room.",
							parameters: {},
							output: {
								schema: { type: "string" },
								render: (_args, value) => [{ type: "text", text: value }],
							},
							async execute(_args, exec) {
								if (exec.agent !== agent)
									throw new Error("Tool caller is not the bound session");
								return JSON.stringify(
									next.peers().map((peer) => ({ name: peer.name })),
								);
							},
						}),
					);
					scope.tools.register(
						defineTool({
							name: "a2a_message",
							description:
								"Send selected text to current A2A peers under local tool permissions. No automatic transcript forwarding. Sender signature requests are unsupported and send nothing.",
							parameters: {
								target: {
									type: "array",
									items: { type: "string" },
									required: true,
								},
								text: { type: "string", required: true },
								replyTo: { type: "string" },
								messageId: { type: "string" },
								requestUserSignature: { type: "boolean" },
							},
							output: {
								schema: { type: "string" },
								render: (_args, value) => [{ type: "text", text: value }],
							},
							async execute(args, exec) {
								if (!exec.agent)
									throw new Error("A2A requires an exact live Agent caller");
								const result = await next.send(exec.agent, args, exec.signal);
								return JSON.stringify({
									ref: result.message.messageRef,
									replayed: result.replayed,
								});
							},
						}),
					);
				},
			});
			disposeTools = () => fork.dispose();
			try {
				await next.start();
			} catch (error) {
				if (!stopped) console.error("[omp-a2a] Hub connection failed:", error);
			}
		}
		ctx.on("agent/created", async ({ agent }) => {
			try {
				await attach(agent);
			} catch (error) {
				await stop();
				console.error("[omp-a2a] could not attach:", error);
			}
		});
		ctx.on("agent/disposed", ({ agent }) => {
			if (selected === agent) {
				void stop().catch((error) => {
					console.error("[omp-a2a] could not detach session:", error);
				});
			}
		});
		ctx.effect(() => stop);
		const existing = ctx.agents.get(id);
		if (existing) return attach(existing);
	};
}
export const apply = createApply();
