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
import { encodeTspJson, splitTspMessage } from "@oh-my-pi/pi-tui/native/encode";
import type { NativeChild } from "@oh-my-pi/pi-tui/native/node";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme";
import type { TspEvent, TspFrame, TspNode } from "@oh-my-pi/pi-wire";
import { A2aConsole } from "../src/console-view";
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

function renderDocument(
	children: readonly NativeChild[],
	interact?: (nodes: TspNode[], sf: string) => TspEvent,
): TspNode[] {
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
		let surface: string | undefined;
		for (const output of writes) {
			const message = splitTspMessage(output);
			if (message?.verb !== "f") continue;
			const frame = JSON.parse(message.body) as TspFrame;
			surface = frame.sf;
			document ??= new TspDocument(frame.sf);
			expect(document.applyFrame(frame)).toEqual([]);
		}
		if (!document || !surface)
			throw new Error("native backend did not emit a frame");
		const nodes: TspNode[] = [];
		const visit = (node: TspNode) => {
			nodes.push(node);
			for (const child of node.c ?? []) visit(child);
		};
		visit(document.snapshot());
		if (interact) {
			expect(
				backend.handleInput(encodeTspJson("e", interact(nodes, surface))),
			).toBe(true);
		}
		return nodes;
	} finally {
		backend.stop(false);
	}
}

function nativeAction(view: A2aConsole, act: string, value?: string): void {
	renderDocument([view], (nodes, sf) => {
		const click = value === undefined ? act : `${act}=${value}`;
		const button = nodes.find(({ p }) => p?.actions?.click === click);
		if (!button) throw new Error(`native action not rendered: ${click}`);
		return { ev: "action", sf, id: button.id, act, value };
	});
}

function nativeSelect(view: A2aConsole, label: string, activate = false): void {
	renderDocument([view], (nodes, sf) => {
		const list = nodes.find(
			(node) =>
				node.k === "list" &&
				node.p?.actions?.click === "select" &&
				node.c?.some((child) => child.k === "item" && child.p?.label === label),
		);
		const selection = list?.c?.find(
			(child) => child.k === "item" && child.p?.label === label,
		);
		if (!list || !selection)
			throw new Error(`native list item not rendered: ${label}`);
		if (activate) expect(list.p?.actions?.dblclick).toBe("activate");
		return {
			ev: activate ? "activate" : "select",
			sf,
			id: list.id,
			item: selection.id,
		};
	});
}

function nativeDeleteRoom(view: A2aConsole, room: string): void {
	renderDocument([view], (nodes, sf) => {
		const item = nodes.find(({ k, p }) => k === "item" && p?.label === room);
		if (!item) throw new Error(`Room item not rendered: ${room}`);
		expect<unknown>(item.p?.actions?.menu).toEqual([
			{ id: `delete=${room}`, label: "Delete Room…", danger: true },
		]);
		return { ev: "action", sf, id: item.id, act: "delete", value: room };
	});
}

function nativeEdit(view: A2aConsole, value: string): void {
	renderDocument([view], (nodes, sf) => {
		const input = nodes.find((node) => node.k === "input");
		if (!input) throw new Error("native input not rendered");
		const length = input.p?.text?.length ?? 0;
		return {
			ev: "edit",
			sf,
			id: input.id,
			from: 0,
			to: length,
			len: length,
			cursor: value.length,
			text: value,
		};
	});
}

test.each([
	["en", "A2A Room workbench", "Message history"],
	["zh", "A2A 房间工作台", "历史消息"],
] as const)(
	"the %s native workbench loads History and attachments only on demand for the selected Room",
	async (language, title, historyLabel) => {
		const requests: [
			string,
			{ limit: number; before?: string; from?: string },
		][] = [];
		const attachmentRequests: string[][] = [];
		let repaint = Promise.withResolvers<void>();
		const view = new A2aConsole({
			language,
			snapshot: () => ({
				hubUrl: "http://hub.example",
				autoConnect: true,
				startup: [],
				rooms: [
					{
						room: "billing",
						state: "connected",
						self: "api",
						peers: ["peer1", "peer2", "peer3", "peer4", "peer5", "peer6"],
					},
				],
			}),
			list: async () => ["review", "billing"],
			history: async (room, query) => {
				requests.push([room, query]);
				return {
					messages: [
						{
							ref: query.before ? "review:1" : `${room}:2`,
							from: "reviewer",
							text:
								room === "billing"
									? "billing notes"
									: "\u001b[31m**review notes**\u001b[0m",
							attachments: room === "review" ? ["notes.txt"] : [],
						},
					],
					nextBefore:
						room === "review" && !query.before ? "review:2" : undefined,
				};
			},
			attachments: async (room, ref) => {
				attachmentRequests.push([room, ref]);
				return [{ name: "notes.txt", url: "local://notes.txt" }];
			},
			join: async () => {
				throw new Error("selecting a Room must not join it");
			},
			leave: async () => {},
			create: async () => {},
			delete: async () => {},
			setStartup: () => {},
			loadSettings: () => ({ config: null }),
			listStartupRooms: async () => [],
			saveSettings: async () => {},
			redraw: () => repaint.resolve(),
			close: () => {
				throw new Error("navigation must not close the workbench");
			},
		});
		try {
			await repaint.promise;
			const initialNodes = renderDocument([view]);
			expect(
				initialNodes
					.filter(({ k }) => k === "list")
					.map(({ c }) =>
						c?.filter((node) => node.k === "item").map(({ p }) => p?.label),
					)
					.slice(0, 2),
			).toEqual([["billing"], ["review"]]);
			expect(
				initialNodes.some(
					({ k, p }) =>
						k === "item" && p?.label === "billing" && p.value === "api",
				),
			).toBe(true);
			expect(initialNodes.some(({ p }) => p?.actions?.click === "create")).toBe(
				false,
			);
			expect(
				initialNodes.some(({ k, p }) => k === "item" && p?.label === "peer6"),
			).toBe(true);
			expect(
				initialNodes.find(({ p }) => p?.actions?.click === "history=billing")?.p
					?.title,
			).toBe(historyLabel);
			expect(Bun.stripANSI(view.render(100).join("\n"))).toContain(title);
			expect(requests).toEqual([]);
			nativeSelect(view, "review");
			expect(
				renderDocument([view]).some(
					({ p }) => p?.actions?.click === "join=review",
				),
			).toBe(true);
			expect(requests).toEqual([]);
			expect(
				renderDocument([view]).find((node) => node.k === "input")?.p
					?.placeholder,
			).toBe(language === "zh" ? "搜索房间" : "Search Rooms");
			nativeAction(view, "history", "review");
			repaint = Promise.withResolvers<void>();
			await repaint.promise;
			expect(requests).toEqual([
				["review", { limit: 20, before: undefined, from: undefined }],
			]);
			expect(
				renderDocument([view]).some(
					({ k, p }) => k === "text" && p?.text === "**review notes**",
				),
			).toBe(true);
			expect(attachmentRequests).toEqual([]);
			nativeEdit(view, "reviewer");
			nativeAction(view, "filter");
			repaint = Promise.withResolvers<void>();
			await repaint.promise;
			nativeAction(view, "older");
			repaint = Promise.withResolvers<void>();
			await repaint.promise;
			expect(requests.at(-1)).toEqual([
				"review",
				{ limit: 20, before: "review:2", from: "reviewer" },
			]);
			nativeAction(view, "attachments", "review:1");
			repaint = Promise.withResolvers<void>();
			await repaint.promise;
			expect(attachmentRequests).toEqual([["review", "review:1"]]);
			expect(
				renderDocument([view]).some(
					({ k, p }) =>
						k === "text" && p?.text === "notes.txt: local://notes.txt",
				),
			).toBe(true);
			nativeAction(view, "back-room");
			const returned = renderDocument([view]);
			expect(
				returned.some(({ p }) => p?.actions?.click === "join=review"),
			).toBe(true);
			expect(requests).toHaveLength(3);
		} finally {
			view.dispose();
		}
	},
);

test("the workbench keeps Room actions inline and discards pending history when the effective Hub changes", async () => {
	const oldHub = "http://old.example";
	const newHub = "http://new.example";
	let hubUrl = oldHub;
	let rooms: {
		room: string;
		state: "connected" | "reconnecting";
		self: string;
		peers: string[];
	}[] = [];
	let startup = [{ room: "review", name: "saved" }];
	let oldRooms = ["review"];
	const stale = Promise.withResolvers<{
		messages: {
			ref: string;
			from: string;
			text: string;
			attachments: string[];
		}[];
	}>();
	let pendingHistory: AbortSignal | undefined;
	let holdHistory = false;
	const edits: [string, string | undefined][] = [];
	const deleted: string[] = [];
	const creates: string[] = [];
	const joins: [string, string][] = [];
	let repaint = Promise.withResolvers<void>();
	let ready = () => true;
	const view = new A2aConsole({
		language: "en",
		snapshot: () => ({
			hubUrl,
			startupHubUrl: oldHub,
			autoConnect: false,
			startup,
			rooms,
		}),
		list: async () => (hubUrl === oldHub ? oldRooms : ["other"]),
		history: (_room, _query, signal) => {
			if (holdHistory && hubUrl === oldHub) {
				pendingHistory = signal;
				return stale.promise;
			}
			return Promise.resolve({ messages: [] });
		},
		attachments: async () => [],
		create: async (room) => {
			creates.push(room);
			oldRooms = [...oldRooms, room];
		},
		delete: async (room) => {
			deleted.push(room);
			oldRooms = oldRooms.filter((name) => name !== room);
		},
		join: async (room, name) => {
			joins.push([room, name]);
			if (name === "conflict") throw new Error("That name is in use");
			if (name === "retry") {
				rooms = [{ room, state: "reconnecting", self: name, peers: [] }];
				throw new Error("Handshake timed out");
			}
			rooms = [{ room, state: "connected", self: name, peers: [] }];
		},
		leave: async () => {
			rooms = [];
		},
		setStartup: (room, name) => {
			edits.push([room, name]);
			startup = name ? [{ room, name }] : [];
		},
		loadSettings: () => ({ config: null }),
		listStartupRooms: async () => [],
		saveSettings: async () => {},
		redraw: () => {
			if (ready()) repaint.resolve();
		},
		close: () => {
			throw new Error("Room actions must stay inline");
		},
	});
	try {
		await repaint.promise;
		const narrow = () => Bun.stripANSI(view.render(58).join("\n"));
		expect(narrow()).toContain("Available to join");
		expect(narrow()).not.toContain("[Join…]");
		view.handleInput("\t");
		view.handleInput("\r");
		expect(narrow()).toContain("[› Join…]");
		expect(narrow()).not.toContain("Available to join");
		view.handleInput("\x1b");
		expect(narrow()).toContain("Available to join");
		view.handleInput("\x1b[Z");
		nativeEdit(view, "rev");
		nativeAction(view, "history", "review");
		nativeDeleteRoom(view, "review");
		expect(
			renderDocument([view]).some(
				({ p }) => p?.actions?.click === "confirm=delete:review",
			),
		).toBe(true);
		const confirmation = Bun.stripANSI(view.render(100).join("\n"));
		expect(confirmation).toContain(
			"Delete review and its complete message history?",
		);
		expect(confirmation).toContain("[› Cancel]");
		view.handleInput("\r");
		expect(deleted).toEqual([]);
		nativeEdit(view, "revisions");
		nativeAction(view, "create-join", "revisions");
		nativeEdit(view, "conflict");
		nativeAction(view, "confirm", "join:revisions");
		repaint = Promise.withResolvers<void>();
		await repaint.promise;
		expect(creates).toEqual(["revisions"]);
		expect(joins).toEqual([["revisions", "conflict"]]);
		expect(
			renderDocument([view]).find((node) => node.k === "input")?.p?.text,
		).toBe("conflict");
		nativeEdit(view, "live");
		nativeAction(view, "confirm", "join:revisions");
		repaint = Promise.withResolvers<void>();
		await repaint.promise;
		expect(creates).toEqual(["revisions"]);
		expect(joins).toEqual([
			["revisions", "conflict"],
			["revisions", "live"],
		]);
		nativeAction(view, "leave", "revisions");
		repaint = Promise.withResolvers<void>();
		await repaint.promise;
		nativeEdit(view, "rev");
		nativeSelect(view, "review");
		nativeDeleteRoom(view, "revisions");
		nativeAction(view, "confirm", "delete:revisions");
		repaint = Promise.withResolvers<void>();
		ready = () =>
			Bun.stripANSI(view.render(100).join("\n")).includes("Deleted revisions.");
		await repaint.promise;
		ready = () => true;
		expect(deleted).toEqual(["revisions"]);
		expect(
			renderDocument([view]).some(
				({ k, p }) => k === "item" && p?.label === "revisions",
			),
		).toBe(false);
		nativeSelect(view, "review", true);
		const joinInput = renderDocument([view]).find((node) => node.k === "input");
		expect(joinInput?.p?.text).toBe("saved");
		nativeEdit(view, "retry");
		nativeAction(view, "confirm", "join:review");
		repaint = Promise.withResolvers<void>();
		await repaint.promise;
		const retrying = renderDocument([view]);
		expect(retrying.some(({ p }) => p?.actions?.click === "leave=review")).toBe(
			true,
		);
		expect(
			retrying.some(({ k, p }) => k === "badge" && p?.text === "Reconnecting"),
		).toBe(true);
		nativeAction(view, "leave", "review");
		repaint = Promise.withResolvers<void>();
		await repaint.promise;
		nativeAction(view, "join", "review");
		nativeEdit(view, "live");
		nativeAction(view, "confirm", "join:review");
		repaint = Promise.withResolvers<void>();
		await repaint.promise;
		expect(
			renderDocument([view]).some(
				({ k, p }) =>
					k === "text" && p?.text === "Startup: saved · Auto-connect off",
			),
		).toBe(true);
		expect(
			renderDocument([view]).some(
				({ p }) => p?.actions?.click === "delete=review",
			),
		).toBe(false);
		nativeAction(view, "remove-startup", "review");
		nativeAction(view, "add-startup", "review");
		expect(edits).toEqual([
			["review", undefined],
			["review", "live"],
		]);
		holdHistory = true;
		nativeAction(view, "history", "review");
		const previousHistory = pendingHistory;
		rooms = [];
		hubUrl = newHub;
		repaint = Promise.withResolvers<void>();
		renderDocument([view]);
		await repaint.promise;
		const switched = renderDocument([view]);
		expect(
			switched.filter((node) => node.k === "item").map(({ p }) => p?.label),
		).toEqual(["other"]);
		expect(
			switched.some(
				({ k, p }) => k === "text" && p?.text === `Startup Hub: ${oldHub}`,
			),
		).toBe(true);
		expect(
			switched.some(({ p }) => p?.actions?.click === "remove-startup=other"),
		).toBe(false);
		expect(previousHistory?.aborted).toBe(true);
		stale.resolve({
			messages: [
				{ ref: "review:10", from: "old", text: "discard me", attachments: [] },
			],
		});
		await stale.promise;
		expect(
			renderDocument([view]).some(
				({ k, p }) => k === "text" && p?.text?.includes("discard me"),
			),
		).toBe(false);
	} finally {
		view.dispose();
	}
});

test("project settings drill down and stage startup Rooms in the same workbench", async () => {
	const hubUrl = "http://current.example";
	const startupHub = "http://startup.example";
	const saved: { room: string; name: string }[] = [];
	const scanned: string[] = [];
	let repaint = Promise.withResolvers<void>();
	const view = new A2aConsole({
		language: "en",
		snapshot: () => ({ hubUrl, autoConnect: true, startup: [], rooms: [] }),
		list: async () => ["billing", "review"],
		history: async () => ({ messages: [] }),
		attachments: async () => [],
		join: async () => {},
		leave: async () => {},
		create: async () => {},
		delete: async () => {},
		setStartup: () => {},
		loadSettings: () => ({
			config: { hubUrl: startupHub, rooms: [{ room: "billing", name: "old" }] },
		}),
		listStartupRooms: async (url) => {
			scanned.push(url);
			return [{ name: "docs", createdAt: 0 }];
		},
		saveSettings: async ({ rooms }) => {
			saved.push(...rooms);
		},
		redraw: () => repaint.resolve(),
		close: () => {
			throw new Error("settings must not close the workbench");
		},
	});
	try {
		await repaint.promise;
		nativeEdit(view, "rev");
		nativeAction(view, "settings");
		nativeAction(view, "cfg-startup");
		nativeSelect(view, "billing");
		nativeAction(view, "focus", "cfg-name");
		nativeEdit(view, "discard");
		view.handleInput("\x1b");
		nativeSelect(view, "billing");
		nativeAction(view, "focus", "cfg-name");
		expect(
			renderDocument([view]).find((node) => node.k === "input")?.p?.text,
		).toBe("old");
		nativeAction(view, "cfg-remove");
		nativeAction(view, "cfg-add");
		nativeAction(view, "cfg-browse");
		repaint = Promise.withResolvers<void>();
		await repaint.promise;
		expect(scanned).toEqual([startupHub]);
		nativeSelect(view, "docs");
		nativeEdit(view, "writer");
		nativeAction(view, "cfg-apply");
		expect(saved).toEqual([]);
		view.handleInput("\x1b");
		nativeAction(view, "cfg-save");
		repaint = Promise.withResolvers<void>();
		await repaint.promise;
		expect(saved).toEqual([{ room: "docs", name: "writer" }]);
		nativeAction(view, "settings");
		nativeAction(view, "cfg-startup");
		nativeAction(view, "cfg-add");
		nativeEdit(view, "discarded");
		nativeAction(view, "cfg-close");
		expect(saved).toEqual([{ room: "docs", name: "writer" }]);
		const nodes = renderDocument([view]);
		expect(nodes.some(({ p }) => p?.actions?.click === "join=review")).toBe(
			true,
		);
		expect(
			nodes.find((node) => node.k === "input")?.p?.text ??
				nodes.find(({ p }) => p?.actions?.click === "focus=search")?.p?.title,
		).toContain("rev");
	} finally {
		view.dispose();
	}
});

const first: MaterializedMessageView = {
	messageId: "first-id",
	messageRef: "test:1",
	room: "test",
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

test("registered inbound renderer keeps human context and markdown without exposing protocol metadata", () => {
	const { inbound } = registeredPresentation();
	const message: CustomMessage<MaterializedMessageView> = {
		role: "custom",
		customType: "a2a-inbound",
		content: 'metadata={"ref":"test:1"}\ntext="original model content"',
		display: true,
		details: structuredClone(first),
		timestamp: 0,
	};
	const component = new CustomMessageComponent(
		message,
		inbound as MessageRenderer,
	);
	try {
		const ansi = Bun.stripANSI(component.render(120).join("\n"));
		expect(ansi).toContain("A2A test:1 · sender → receiver");
		expect(ansi).toContain("literal peer text");
		expect(ansi).toContain("hello");
		expect(ansi).toContain("Reply to test:0");
		expect(ansi).not.toContain("Approved by sender's user");
		expect(ansi).toContain("report.txt");
		expect(ansi).toContain("local://a2a/report.txt");
		expect(ansi).not.toContain("metadata=");
		expect(ansi).not.toContain("original model content");
		expect(ansi).not.toContain("first-id");
		expect(ansi).not.toContain("sender-presence");
		expect(ansi).not.toContain("receiver-presence");
		const nodes = renderDocument([component]);
		expect(nodes.find((node) => node.k === "card")?.p?.head).toBe(
			"A2A test:1 · sender → receiver",
		);
		expect(nodes.find((node) => node.k === "card")?.p?.tone).toBe("success");
		expect(nodes.find((node) => node.k === "card")?.p?.title).toBe(
			"Approved by sender's user",
		);
		expect(nodes.find((node) => node.k === "card")?.p?.aria).toBe(
			"A2A test:1 · sender → receiver · Approved by sender's user",
		);
		expect(nodes.find((node) => node.k === "md")?.p?.text).toBe(
			"# literal peer text\n```text\nhello\n```",
		);
		expect(nodes.find((node) => node.k === "kv")).toBeUndefined();
		expect(
			nodes.filter((node) => node.k === "text").map((node) => node.p?.text),
		).toEqual(["Reply to test:0", "report.txt\nlocal://a2a/report.txt"]);
		expect(message.content).toBe(
			'metadata={"ref":"test:1"}\ntext="original model content"',
		);
		expect(message.details).toEqual(first);
	} finally {
		component.dispose();
	}
});

test("registered peer and history tool views preserve roster identity and message order", () => {
	const { tools } = registeredPresentation();
	const peers = tools.get("a2a_peers")?.describeResult?.(
		{
			content: [],
			details: {
				rooms: [
					{
						room: "test",
						self: { name: "receiver", presenceId: "receiver-presence" },
						peers: [first.from],
					},
					{
						room: "other",
						self: { name: "api", presenceId: "api-presence" },
						peers: [
							{ name: first.from.name, presenceId: "other-sender-presence" },
						],
					},
				],
			},
		},
		options,
	);
	const roster = renderDocument(peers?.body ?? []);
	expect(roster.find((node) => node.k === "table")?.p?.cols).toEqual([
		{ id: "room", head: "Room" },
		{ id: "name", head: "Name" },
		{ id: "role", head: "Role" },
	]);
	expect(roster.find((node) => node.k === "table")?.p?.rows).toEqual([
		{
			id: "receiver-presence",
			cells: { room: "test", name: "receiver", role: "You" },
		},
		{
			id: "sender-presence",
			cells: { room: "test", name: "sender", role: "Peer" },
		},
		{ id: "api-presence", cells: { room: "other", name: "api", role: "You" } },
		{
			id: "other-sender-presence",
			cells: { room: "other", name: "sender", role: "Peer" },
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
		nodes.filter((node) => node.k === "md").map((node) => node.p?.text),
	).toEqual(["# literal peer text\n```text\nhello\n```", "second"]);
	expect(nodes.find((node) => node.k === "kv")).toBeUndefined();
	expect(
		nodes.filter((node) => node.k === "text").map((node) => node.p?.text),
	).toEqual(["Reply to test:0", "report.txt\nlocal://a2a/report.txt"]);
	expect(
		nodes.filter((node) => node.k === "section").map((node) => node.p?.head),
	).toEqual([
		"test:1 · sender → receiver",
		"Attachments",
		"test:2 · sender → @all",
	]);
	const messageSections = nodes.filter(
		(node) => node.k === "section" && node.p?.head !== "Attachments",
	);
	expect(messageSections.map((node) => node.p?.tone)).toEqual([
		"success",
		undefined,
	]);
	expect(messageSections.map((node) => node.p?.title)).toEqual([
		"Approved by sender's user",
		undefined,
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
	expect(nodes.find((node) => node.k === "md")?.p?.text).toBe("message");
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
