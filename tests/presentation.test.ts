import { expect, test } from "bun:test";
import type {
	MessageRenderer,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import type { CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import {
	assumedTspHello,
	NativeBackend,
} from "@oh-my-pi/pi-tui/native/backend";
import { splitTspMessage } from "@oh-my-pi/pi-tui/native/encode";
import type { NativeChild } from "@oh-my-pi/pi-tui/native/node";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme";
import type { TspFrame, TspNode } from "@oh-my-pi/pi-wire";
import a2aExtension from "../src/extension";
import type { MaterializedMessageView } from "../src/presentation";

ensureThemeSync();

function registeredPresentation() {
	const tools = new Map<string, ToolDefinition>();
	let inbound: MessageRenderer<MaterializedMessageView> | undefined;
	a2aExtension({
		arktype: (definition: unknown) => definition,
		setLabel() {},
		on() {},
		registerCommand() {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer(
			name: string,
			renderer: MessageRenderer<MaterializedMessageView>,
		) {
			if (name === "a2a-inbound") inbound = renderer;
		},
	} as never);
	if (!inbound) throw new Error("inbound renderer was not registered");
	return { tools, inbound };
}

function renderDocument(children: readonly NativeChild[]): TspNode[] {
	const writes: string[] = [];
	const terminal = {
		columns: 80,
		rows: 24,
		write(data: string) {
			writes.push(data);
		},
	} as Terminal;
	const backend = new NativeBackend(
		{
			terminal,
			describeSurface: () => ({ main: children, dock: [] }),
			overlays: () => [],
			focused: () => null,
			focusFromPointer() {},
			requestRender() {},
			appearanceChanged() {},
			motionChanged() {},
			invalidate() {},
		},
		assumedTspHello(terminal),
	);
	try {
		backend.start();
		expect(backend.fallbackCount).toBe(0);
		let document: TspDocument | undefined;
		for (const output of writes) {
			const message = splitTspMessage(output);
			if (message?.verb !== "f") continue;
			const frame = JSON.parse(message.body) as TspFrame;
			document ??= new TspDocument(frame.sf);
			expect(document.applyFrame(frame)).toEqual([]);
		}
		if (!document) throw new Error("native backend did not emit a frame");
		const nodes: TspNode[] = [];
		const visit = (node: TspNode) => {
			nodes.push(node);
			for (const child of node.c ?? []) visit(child);
		};
		visit(document.snapshot());
		return nodes;
	} finally {
		backend.stop(false);
	}
}

const first: MaterializedMessageView = {
	messageId: "first-id",
	messageRef: "test:1",
	project: "test",
	sequence: 1,
	from: { name: "sender", presenceId: "sender-presence" },
	target: {
		type: "agents",
		names: ["receiver"],
		presenceIds: ["receiver-presence"],
	},
	text: "# literal peer text\n```text\nhello\n```",
	createdAt: 0,
	replyTo: "test:0",
	userApproval: { kind: "omp-ui" },
	attachments: [{ name: "report.txt", url: "local://a2a/report.txt" }],
};

const options = { expanded: false, isPartial: false };

test("registered inbound renderer emits structured TSP without changing ANSI or model content", () => {
	const { inbound } = registeredPresentation();
	const message: CustomMessage<MaterializedMessageView> = {
		role: "custom",
		customType: "a2a-inbound",
		content: 'metadata={"ref":"test:1"}\ntext="original model content"',
		display: true,
		details: first,
		timestamp: 0,
	};
	const component = new CustomMessageComponent(
		message,
		inbound as MessageRenderer,
	);
	const fallback = new CustomMessageComponent(message);
	try {
		expect(component.render(80)).toEqual(fallback.render(80));
		const nodes = renderDocument([component]);
		expect(nodes.find((node) => node.k === "card")?.p?.head).toBe(
			"A2A test:1 · sender → receiver",
		);
		expect(nodes.find((node) => node.k === "code")?.p).toEqual({
			text: "# literal peer text\n```text\nhello\n```",
			lang: "text",
		});
		expect(nodes.find((node) => node.k === "kv")?.p?.items).toEqual([
			{ k: "Project", v: "test" },
			{ k: "Message ID", v: "first-id" },
			{ k: "Sequence", v: "1" },
			{ k: "Sender presence", v: "sender-presence" },
			{ k: "Time", v: "1970-01-01T00:00:00.000Z" },
			{ k: "Sender user approval", v: "confirmed" },
			{ k: "Recipient presences", v: "receiver-presence" },
			{ k: "Reply to", v: "test:0" },
		]);
		expect(nodes.find((node) => node.k === "text")?.p?.text).toBe(
			"report.txt\nlocal://a2a/report.txt",
		);
		expect(message.content).toBe(
			'metadata={"ref":"test:1"}\ntext="original model content"',
		);
	} finally {
		component.dispose();
		fallback.dispose();
	}
});

test("registered peer and history tool views preserve roster identity and message order", () => {
	const { tools } = registeredPresentation();
	const peers = tools.get("a2a_peers")?.describeResult?.(
		{
			content: [],
			details: {
				self: { name: "receiver", presenceId: "receiver-presence" },
				peers: [first.from],
			},
		},
		options,
	);
	const roster = renderDocument(peers?.body ?? []);
	expect(roster.find((node) => node.k === "table")?.p?.rows).toEqual([
		{
			id: "receiver-presence",
			cells: { name: "receiver", role: "You", presence: "receiver-presence" },
		},
		{
			id: "sender-presence",
			cells: { name: "sender", role: "Peer", presence: "sender-presence" },
		},
	]);
	const history = tools.get("a2a_history")?.describeResult;
	if (!history) throw new Error("history renderer was not registered");
	const second: MaterializedMessageView = {
		...first,
		messageId: "second-id",
		messageRef: "test:2",
		sequence: 2,
		target: { type: "all" },
		text: "second",
		attachments: [],
		userApproval: undefined,
		replyTo: undefined,
	};
	const view = history(
		{ content: [], details: { messages: [first, second] } },
		options,
	);
	const nodes = renderDocument(view?.body ?? []);
	expect(
		nodes.filter((node) => node.k === "code").map((node) => node.p?.text),
	).toEqual(["# literal peer text\n```text\nhello\n```", "second"]);
	expect(
		nodes.filter((node) => node.k === "section").map((node) => node.p?.head),
	).toEqual([
		"test:1 · sender → receiver",
		"Attachments",
		"test:2 · sender → @all",
	]);
	expect(
		history({ content: [], details: { messages: [] } }, options)?.body,
	).toEqual([{ k: "text", p: { text: "No messages." } }]);
	expect(
		history(
			{
				content: [{ type: "text", text: "Disconnected" }],
				details: { error: "Disconnected" },
			},
			options,
		),
	).toBeUndefined();
});

test("message tool native preview preserves targets, reply and attachments without claiming approval", () => {
	const { tools } = registeredPresentation();
	const tool = tools.get("a2a_message");
	const view = tool?.describeCall?.(
		{
			target: ["one", "two"],
			text: "message",
			replyTo: "test:1",
			attachments: ["local://file.txt"],
			requestUserSignature: true,
		},
		options,
	);
	expect(view?.tool).toEqual({
		title: "A2A Message",
		target: "one, two",
		meta: ["Reply to test:1"],
		note: "approval requested",
	});
	const nodes = renderDocument(view?.body ?? []);
	expect(nodes.find((node) => node.k === "code")?.p?.text).toBe("message");
	expect(nodes.find((node) => node.k === "text")?.p?.text).toBe(
		"local://file.txt",
	);
	const result = tool?.describeResult?.(
		{
			content: [{ type: "text", text: "User rejected the A2A message" }],
			details: { rejected: true, reason: null },
			isError: true,
		},
		options,
	);
	expect(result?.body).toEqual([
		{ k: "text", p: { text: "User rejected the A2A message" } },
	]);
});
