const { createInterface } = require("node:readline");
const scenario = process.argv.at(-1);
const rl = createInterface({ input: process.stdin });
let active;
let cancelled = false;
let prompts = 0;
const send = (message) =>
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const result = (id, value) => send({ id, result: value });
const update = (sessionId, sessionUpdate, text) =>
	send({
		method: "session/update",
		params: {
			sessionId,
			update: { sessionUpdate, content: { type: "text", text } },
		},
	});
const toolUpdate = (sessionId, sessionUpdate, call) =>
	send({
		method: "session/update",
		params: { sessionId, update: { sessionUpdate, ...call } },
	});
const permission = (
	details = { title: "Read a file", rawInput: { path: "/tmp/demo" } },
) =>
	send({
		id: "permission",
		method: "session/request_permission",
		params: {
			sessionId: "test",
			toolCall: {
				toolCallId: "tool",
				...details,
			},
			options: [
				{ optionId: "allow", name: "Allow once", kind: "allow_once" },
				{ optionId: "always", name: "Always allow", kind: "allow_always" },
				{ optionId: "deny", name: "Reject once", kind: "reject_once" },
			],
		},
	});
rl.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === "initialize") {
		if (
			message.params.protocolVersion !== 1 ||
			Object.keys(message.params.clientCapabilities).length !== 0
		)
			process.exit(2);
		result(message.id, { protocolVersion: scenario === "version" ? 2 : 1 });
	} else if (message.method === "session/new") {
		if (message.params.mcpServers.length !== 0) process.exit(3);
		result(message.id, { sessionId: "test" });
		if (scenario === "exit") setTimeout(() => process.exit(0), 100);
	} else if (message.method === "session/prompt") {
		if (
			message.params.sessionId !== "test" ||
			message.params.prompt[0].type !== "text"
		)
			process.exit(4);
		prompts++;
		if (scenario === "oversize") {
			process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 65));
			return;
		}
		if (scenario === "permission" || (scenario === "cancel" && prompts === 1)) {
			active = message.id;
			permission();
			return;
		}
		if (
			[
				"sparse",
				"missing",
				"oversize-tool",
				"previous-turn",
				"changed",
			].includes(scenario)
		) {
			active = message.id;
			if (scenario === "sparse" || scenario === "changed") {
				toolUpdate("test", "tool_call", {
					toolCallId: "tool",
					title: "Read a file",
					name: "read_file",
					rawInput: { path: "/tmp/old" },
				});
				toolUpdate("test", "tool_call_update", {
					toolCallId: "tool",
					rawInput: { path: "/tmp/latest" },
				});
				toolUpdate("other", "tool_call_update", {
					toolCallId: "tool",
					rawInput: { path: "/tmp/unrelated" },
				});
			} else if (scenario === "oversize-tool") {
				toolUpdate("test", "tool_call", {
					toolCallId: "tool",
					rawInput: { command: "x".repeat(4_500) },
				});
			}
			if (scenario === "previous-turn" && prompts === 1) permission();
			else
				permission(scenario === "sparse" ? { rawInput: null, name: null } : {});
			if (scenario === "changed") {
				// Keep this update in the same stdio read as the pending request.
				toolUpdate("test", "tool_call_update", {
					toolCallId: "tool",
					rawInput: { path: "/tmp/changed" },
				});
			}
			return;
		}
		update("other", "agent_message_chunk", "wrong session");
		update("test", "agent_thought_chunk", "hidden thought");
		update("test", "tool_call", "private tool text");
		const last = Buffer.from(
			`${JSON.stringify({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "test",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "答🧪" },
					},
				},
			})}\n`,
		);
		const split = last.indexOf(Buffer.from("🧪")) + 2;
		process.stdout.write(last.subarray(0, split));
		setTimeout(() => {
			process.stdout.write(last.subarray(split));
			result(message.id, { stopReason: "end_turn" });
		}, 10);
	} else if (message.method === "session/cancel") {
		cancelled = true;
	} else if (message.id === "permission") {
		const { outcome, optionId } = message.result.outcome;
		if (cancelled) {
			if (outcome !== "cancelled") process.exit(5);
			result(active, { stopReason: "cancelled" });
		} else {
			update("test", "agent_message_chunk", optionId ?? outcome);
			result(active, { stopReason: "end_turn" });
		}
	}
});
