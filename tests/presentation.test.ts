import { expect, test } from "bun:test";
import type {
	ExtensionRender,
	ExtensionTheme,
	MessageRenderer,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { createSurface, type Signal, signal, UiNode } from "@oh-my-pi/pi-tui";
import type { InputEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { createTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";
import { setNativeRenderingForTest } from "@oh-my-pi/pi-tui/host";
import { NativeBackend } from "@oh-my-pi/pi-tui/native/backend";
import {
	assumedHello,
	TspConnection,
} from "@oh-my-pi/pi-tui/native/connection";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { TspEvent, TspNode } from "@oh-my-pi/pi-wire";
import { A2aConsole } from "../src/console-view";
import a2aExtension from "../src/extension";
import type { MaterializedMessageView } from "../src/presentation";

const theme: ExtensionTheme = {
	...PLAIN_THEME,
	bold: String,
	italic: String,
	underline: String,
	strikethrough: String,
	inverse: String,
};

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

const workbenchWidths = new WeakMap<A2aConsole, Signal<number>>();

function workbenchRoot(view: A2aConsole, columns: number) {
	let width = workbenchWidths.get(view);
	if (!width) {
		width = signal(columns);
		workbenchWidths.set(view, width);
	} else width.set(columns);
	return view.describe(undefined, width);
}

function renderDocument(
	children: ExtensionRender | A2aConsole | undefined,
	interact?: (nodes: TspNode[], sf: string) => TspEvent,
): TspNode[] {
	if (children && typeof children === "object" && "render" in children)
		throw new Error("expected OMP UI nodes, received terminal-only rows");
	const roots: TspNode[] = [];
	const nodes: TspNode[] = [];
	const surface = createSurface(() => ({
		dock:
			children instanceof A2aConsole ? workbenchRoot(children, 100) : children,
	}));
	const driver = createTerminalDriver(
		memoryTerminal({ columns: 80, rows: 24 }).options,
	);
	const listeners = new Set<(event: InputEvent) => void>();
	driver.onInput = (listener) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	const connection = new TspConnection(driver, assumedHello(driver));
	const visit = (node: TspNode) => {
		nodes.push(node);
		for (const child of node.c ?? []) visit(child);
	};
	const backend = new NativeBackend({
		surface,
		onFrame: ({ ops }) => {
			for (const op of ops) {
				if (op[0] !== "add") continue;
				const [, , , before, node] = op;
				const index =
					before === null
						? roots.length
						: roots.findIndex(({ id }) => id === before);
				expect(index).toBeGreaterThanOrEqual(0);
				roots.splice(index, 0, node);
			}
		},
	});
	try {
		setNativeRenderingForTest(true);
		backend.start(connection);
		for (const root of roots) visit(root);
		expect(nodes.length).toBeGreaterThan(0);
		if (interact) {
			const body = JSON.stringify(interact(nodes, backend.id));
			for (const listener of listeners) {
				listener({ type: "tsp", verb: "e", params: {}, body });
			}
		}
		return nodes;
	} finally {
		backend.stop(false);
		connection.close();
		surface.dispose();
		setNativeRenderingForTest(false);
	}
}

function nativeAction(view: A2aConsole, act: string, value?: string): void {
	renderDocument(view, (nodes, sf) => {
		const click = value === undefined ? act : `${act}=${value}`;
		const button = nodes.find(({ p }) => p?.actions?.click === click);
		if (!button) throw new Error(`native action not rendered: ${click}`);
		return { ev: "action", sf, id: button.id, act, value };
	});
}

function nativeSelect(view: A2aConsole, label: string, activate = false): void {
	renderDocument(view, (nodes, sf) => {
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
	renderDocument(view, (nodes, sf) => {
		const item = nodes.find(({ k, p }) => k === "item" && p?.label === room);
		if (!item) throw new Error(`Room item not rendered: ${room}`);
		expect<unknown>(item.p?.actions?.menu).toEqual([
			{ id: `delete=${room}`, label: "Delete Room…", danger: true },
		]);
		return { ev: "action", sf, id: item.id, act: "delete", value: room };
	});
}

function nativeEdit(view: A2aConsole, value: string): void {
	renderDocument(view, (nodes, sf) => {
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

function workbenchTerminal(view: A2aConsole, columns = 100) {
	const terminal = createTestTerminal(
		() => ({ dock: workbenchRoot(view, columns) }),
		{ columns, rows: 45 },
	);
	terminal.focus(terminal.surface.dock()[0] ?? null);
	return terminal;
}

function workbenchKey(view: A2aConsole, key: string) {
	const terminal = workbenchTerminal(view);
	try {
		terminal.press(key);
	} finally {
		terminal.dispose();
	}
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
			const initialNodes = renderDocument(view);
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
			const terminal = workbenchTerminal(view);
			try {
				expect(terminal.screen().join("\n")).toContain(title);
			} finally {
				terminal.dispose();
			}
			expect(requests).toEqual([]);
			nativeSelect(view, "review");
			expect(
				renderDocument(view).some(
					({ p }) => p?.actions?.click === "join=review",
				),
			).toBe(true);
			expect(requests).toEqual([]);
			expect(
				renderDocument(view).find((node) => node.k === "input")?.p?.placeholder,
			).toBe(language === "zh" ? "搜索房间" : "Search Rooms");
			nativeAction(view, "history", "review");
			repaint = Promise.withResolvers<void>();
			await repaint.promise;
			expect(requests).toEqual([
				["review", { limit: 20, before: undefined, from: undefined }],
			]);
			expect(
				renderDocument(view).some(
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
				renderDocument(view).some(
					({ k, p }) =>
						k === "text" && p?.text === "notes.txt: local://notes.txt",
				),
			).toBe(true);
			nativeAction(view, "back-room");
			const returned = renderDocument(view);
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
	const hubUrl = signal(oldHub);
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
	const view = new A2aConsole({
		language: "en",
		snapshot: () => ({
			hubUrl: hubUrl(),
			startupHubUrl: oldHub,
			autoConnect: false,
			startup,
			rooms,
		}),
		list: async () => (hubUrl() === oldHub ? oldRooms : ["other"]),
		history: (_room, _query, signal) => {
			if (holdHistory && hubUrl() === oldHub) {
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
		redraw: () => repaint.resolve(),
		close: () => {
			throw new Error("Room actions must stay inline");
		},
	});
	try {
		await repaint.promise;
		const terminal = workbenchTerminal(view, 58);
		try {
			expect(terminal.screen().join("\n")).toContain("Available to join");
			terminal.type("rev");
			expect(terminal.screen().join("\n")).toContain("rev");
		} finally {
			terminal.dispose();
		}
		nativeEdit(view, "rev");
		nativeAction(view, "history", "review");
		nativeDeleteRoom(view, "review");
		expect(
			renderDocument(view).some(
				({ p }) => p?.actions?.click === "confirm=delete:review",
			),
		).toBe(true);
		workbenchKey(view, "enter");
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
			renderDocument(view).find((node) => node.k === "input")?.p?.text,
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
		await repaint.promise;
		expect(deleted).toEqual(["revisions"]);
		expect(
			renderDocument(view)
				.filter((node) => node.k === "text")
				.map(({ p }) => p?.spans?.map((span) => span.t).join("") ?? p?.text),
		).toContain("Deleted revisions.");
		expect(
			renderDocument(view).some(
				({ k, p }) => k === "item" && p?.label === "revisions",
			),
		).toBe(false);
		nativeSelect(view, "review", true);
		const joinInput = renderDocument(view).find((node) => node.k === "input");
		expect(joinInput?.p?.text).toBe("saved");
		nativeEdit(view, "retry");
		nativeAction(view, "confirm", "join:review");
		repaint = Promise.withResolvers<void>();
		await repaint.promise;
		const retrying = renderDocument(view);
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
			renderDocument(view).some(
				({ k, p }) =>
					k === "text" && p?.text === "Startup: saved · Auto-connect off",
			),
		).toBe(true);
		expect(
			renderDocument(view).some(
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
		hubUrl.set(newHub);
		repaint = Promise.withResolvers<void>();
		renderDocument(view);
		await repaint.promise;
		const switched = renderDocument(view);
		expect(
			switched.filter((node) => node.k === "item").map(({ p }) => p?.label),
		).toEqual(["other"]);
		expect(
			switched.some(
				(node) =>
					node.k === "text" &&
					node.p?.spans?.some(({ t }) => t === `Startup Hub: ${oldHub}`),
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
			renderDocument(view).some(
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
		workbenchKey(view, "escape");
		nativeSelect(view, "billing");
		nativeAction(view, "focus", "cfg-name");
		expect(
			renderDocument(view).find((node) => node.k === "input")?.p?.text,
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
		workbenchKey(view, "escape");
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
		const nodes = renderDocument(view);
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
	const message: Parameters<typeof inbound>[0] = {
		role: "custom",
		customType: "a2a-inbound",
		content: 'metadata={"ref":"test:1"}\ntext="original model content"',
		display: true,
		details: structuredClone(first),
		timestamp: 0,
	};
	const rendered = inbound(message, options, theme);
	if (!(rendered instanceof UiNode))
		throw new Error("expected an inbound UI node");
	const terminal = createTestTerminal(() => ({ dock: rendered }), {
		columns: 120,
		rows: 30,
	});
	try {
		const ansi = terminal.screen().join("\n");
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
		const nodes = renderDocument(rendered);
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
		terminal.dispose();
	}
});

test("registered peer and history tool views preserve roster identity and message order", () => {
	const { tools } = registeredPresentation();
	const peers = tools.get("a2a_peers")?.renderResult?.(
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
		theme,
	);
	const roster = renderDocument(peers);
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
	const history = tools.get("a2a_history")?.renderResult;
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
		theme,
	);
	const nodes = renderDocument(view);
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
	const empty = history(
		{ content: [], details: { messages: [] } },
		options,
		theme,
	);
	expect(renderDocument(empty).find((node) => node.k === "text")?.p?.text).toBe(
		"No messages.",
	);
	const error = history(
		{
			content: [{ type: "text", text: "Disconnected" }],
			details: { error: "Disconnected" },
		},
		options,
		theme,
	);
	expect(renderDocument(error).find((node) => node.k === "text")?.p?.text).toBe(
		"Disconnected",
	);
});

test("message tool native preview preserves targets, reply and attachments without claiming approval", () => {
	const { tools } = registeredPresentation();
	const tool = tools.get("a2a_message");
	const view = tool?.renderCall?.(
		{
			target: ["one", "two"],
			text: "message",
			replyTo: "test:1",
			attachments: ["local://file.txt"],
			requestUserSignature: true,
		},
		options,
		theme,
	);
	const nodes = renderDocument(view);
	const text = nodes
		.filter((node) => node.k === "text")
		.map((node) => node.p?.text);
	expect(text).toEqual([
		"To one, two · Reply to test:1 · approval requested",
		"local://file.txt",
	]);
	expect(nodes.find((node) => node.k === "md")?.p?.text).toBe("message");
	const result = tool?.renderResult?.(
		{
			content: [{ type: "text", text: "User rejected the A2A message" }],
			details: { rejected: true, reason: null },
		},
		options,
		theme,
	);
	expect(
		renderDocument(result).find((node) => node.k === "text")?.p?.text,
	).toBe("User rejected the A2A message");
});
