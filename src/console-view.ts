import {
	batch,
	createRoot,
	type JSXNode,
	type KeyEvent,
	type KindAttributes,
	nativeRendering,
	type PasteEvent,
	signal,
	type TextEdit,
	UiNode,
} from "@oh-my-pi/pi-tui";
import { widgetKeyMatches } from "@oh-my-pi/pi-tui/term/keymap";
import { widgetContext } from "@oh-my-pi/pi-tui/term/widgets";
import { fieldWidget } from "@oh-my-pi/pi-tui/term/widgets/editor";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TspKind, TspProps } from "@oh-my-pi/pi-wire";
import type { A2aLanguage } from "./locale";
import {
	type A2aLocalConfig,
	type A2aRoom,
	AGENT_NAME_RE,
	ROOM_NAME_RE,
} from "./types";

type RoomSnapshot = {
	room: string;
	state: "connected" | "connecting" | "reconnecting";
	self?: string;
	peers: string[];
};
type Snapshot = {
	hubUrl?: string;
	startupHubUrl?: string;
	autoConnect: boolean;
	startup: readonly { room: string; name: string }[];
	rooms: RoomSnapshot[];
};
type HistoryMessage = {
	ref: string;
	from: string;
	text: string;
	replyTo?: string;
	attachments: string[];
};
type HistoryPage = { messages: HistoryMessage[]; nextBefore?: string };
type Attachment = { name: string; url: string };

export type ConsoleOptions = {
	language: A2aLanguage;
	snapshot: () => Snapshot;
	list: (signal: AbortSignal) => Promise<string[]>;
	history: (
		room: string,
		query: { before?: string; from?: string; limit: number },
		signal: AbortSignal,
	) => Promise<HistoryPage>;
	attachments: (
		room: string,
		ref: string,
		signal: AbortSignal,
	) => Promise<Attachment[]>;
	join: (room: string, name: string) => Promise<void>;
	leave: (room: string) => Promise<void>;
	create: (room: string, signal: AbortSignal) => Promise<void>;
	delete: (room: string, signal: AbortSignal) => Promise<void>;
	setStartup: (room: string, name?: string) => void;
	loadSettings: () => { config: A2aLocalConfig | null; inheritedHub?: string };
	listStartupRooms: (hubUrl: string, signal: AbortSignal) => Promise<A2aRoom[]>;
	saveSettings: (config: ProjectDraft) => Promise<void>;
	redraw: () => void;
	close: () => void;
};

const en = {
	title: "A2A Room workbench",
	hubUnconfigured: "No Hub configured.",
	currentHub: (url: string) => `Current Hub: ${url}`,
	startupHub: (url: string) => `Startup Hub: ${url}`,
	refresh: "Refresh Rooms",
	hubOnline: "Hub online",
	hubUnavailable: "Hub unavailable",
	retry: "Retry",
	configureHub: "Set up Hub…",
	settings: "Project Settings",
	project: {
		startup: "Startup Rooms",
		hub: "Startup Hub URL",
		inherit: (url?: string) =>
			url
				? `Leave blank to use the global Hub: ${url}`
				: "Enter a Hub URL to connect.",
		auto: (enabled: boolean) => `Connect at startup: ${enabled ? "on" : "off"}`,
		openRooms: (count: number) => `Startup Rooms (${count})`,
		empty: "No startup Rooms.",
		add: "Add a Room",
		edit: "Edit startup Room",
		save: "Save Project Settings",
		saved: "Project settings saved.",
		back: "Back",
		cancel: "Cancel",
		apply: "Apply to draft",
		remove: "Remove from startup",
		duplicate: "That Room is already in the startup list.",
		browse: "Browse startup Hub Rooms",
		noMatch: "No matching Rooms on the startup Hub.",
		note: "Saving applies to future sessions. Current connections stay open.",
	},
	close: "Close",
	create: "Create Room…",
	search: "Search Rooms",
	tracked: "This session",
	discovered: "Available to join",
	status: {
		connected: "Connected",
		connecting: "Connecting",
		reconnecting: "Reconnecting",
		notJoined: "Not joined",
	},
	loadingRooms: "Loading Rooms…",
	listError: (detail: string) => `Room list unavailable: ${detail}`,
	noRooms: "No Rooms yet. Type a name to create one.",
	noMatching: "No matching Rooms.",
	join: "Join…",
	leave: "Leave",
	delete: "Delete Room…",
	roomName: "Room name",
	rosterName: "Your name in this Room",
	confirmJoin: "Join Room",
	confirmCreate: "Create Room",
	confirmCreateAndJoin: "Create and join",
	confirmDelete: "Delete permanently",
	confirmDeletion: (room: string) =>
		`Delete ${room} and its complete message history? This cannot be undone.`,
	leaveFirst: "Leave this Room before deleting it.",
	cancel: "Cancel",
	invalidRoom: "Enter a Room name.",
	invalidName: "Enter your name.",
	working: "Working…",
	joined: (name: string) => `Joined as ${name}.`,
	left: "Left the Room.",
	created: (room: string) => `Created ${room}.`,
	deleted: (room: string) => `Deleted ${room}.`,
	addStartup: "Add to startup",
	removeStartup: "Remove from startup",
	startupName: (name: string, enabled: boolean) =>
		`Startup: ${name} · Auto-connect ${enabled ? "on" : "off"}`,
	startupMissing: (enabled: boolean) =>
		`Not saved for startup · Auto-connect ${enabled ? "on" : "off"}`,
	startupNeedsName: "Join to save your name for startup.",
	currentName: (name: string) => `Current name: ${name}`,
	startupMismatch:
		"Startup is configured for another Hub. Open Project Settings to change it.",
	startupAdded: "Added to startup.",
	startupRemoved: "Removed from startup.",
	members: "Online members",
	noMembers: "No members online.",
	membersScroll: "PgUp / PgDn Scroll members",
	joinForMembers: "Join to see live members.",
	you: (name: string) => `${name} (you)`,
	history: "Message history",
	backRoom: "Back to Room",
	backList: "Back to Rooms",
	loadingHistory: "Loading messages…",
	historyError: (detail: string) => `Could not load messages: ${detail}`,
	noMessages: "No messages match this view.",
	sender: "Filter by sender",
	applyFilter: "Apply filter",
	newer: "Newer",
	older: "Older",
	attachments: "Show attachments",
	loadingAttachments: "Preparing attachments…",
	attachmentError: (detail: string) =>
		`Could not prepare attachments: ${detail}`,
	attachmentList: (names: string[]) => `Attachments: ${names.join(", ")}`,
	replyTo: (ref: string) => `Reply to ${ref}`,
	keys: "Tab / Shift+Tab Move · ↑↓ Select · Enter Open · Esc Back",
	formKeys: "Tab / Shift+Tab Move · Enter Confirm · Esc Cancel",
	scroll: "PgUp / PgDn Scroll message",
};

const consoleCopy = {
	en,
	zh: {
		title: "A2A 房间工作台",
		hubUnconfigured: "未配置 Hub。",
		currentHub: (url) => `当前 Hub：${url}`,
		startupHub: (url) => `启动 Hub：${url}`,
		refresh: "刷新房间",
		hubOnline: "Hub 在线",
		hubUnavailable: "Hub 无法连接",
		retry: "重试",
		configureHub: "设置 Hub…",
		settings: "项目设置",
		project: {
			startup: "启动房间",
			hub: "启动 Hub 地址",
			inherit: (url) =>
				url ? `留空时使用全局 Hub：${url}` : "填写 Hub 地址以连接。",
			auto: (enabled) => `启动时自动连接：${enabled ? "开启" : "关闭"}`,
			openRooms: (count) => `启动房间（${count}）`,
			empty: "暂无启动房间。",
			add: "添加房间",
			edit: "编辑启动房间",
			save: "保存项目设置",
			saved: "已保存项目设置。",
			back: "返回",
			cancel: "取消",
			apply: "应用到草稿",
			remove: "从启动列表移除",
			duplicate: "此房间已在启动列表中。",
			browse: "浏览启动 Hub 的房间",
			noMatch: "启动 Hub 没有匹配的房间。",
			note: "保存后用于下次启动，当前连接保持不变。",
		},
		close: "关闭",
		create: "创建房间…",
		search: "搜索房间",
		tracked: "本会话",
		discovered: "可加入",
		status: {
			connected: "已连接",
			connecting: "连接中",
			reconnecting: "重连中",
			notJoined: "未加入",
		},
		loadingRooms: "正在加载房间…",
		listError: (detail) => `无法获取房间列表：${detail}`,
		noRooms: "暂无房间。输入房间名即可创建。",
		noMatching: "没有匹配的房间。",
		join: "加入…",
		leave: "离开",
		delete: "删除房间…",
		roomName: "房间名",
		rosterName: "你在此房间的名称",
		confirmJoin: "加入房间",
		confirmCreate: "创建房间",
		confirmCreateAndJoin: "创建并加入",
		confirmDelete: "永久删除",
		confirmDeletion: (room) =>
			`删除 ${room} 及其全部消息历史？此操作无法撤销。`,
		leaveFirst: "请先离开此房间，再删除。",
		cancel: "取消",
		invalidRoom: "请输入房间名。",
		invalidName: "请输入你的名称。",
		working: "正在处理…",
		joined: (name) => `已用 ${name} 的名称加入。`,
		left: "已离开房间。",
		created: (room) => `已创建 ${room}。`,
		deleted: (room) => `已删除 ${room}。`,
		addStartup: "加入启动列表",
		removeStartup: "从启动列表移除",
		startupName: (name, enabled) =>
			`启动名称：${name} · 自动连接${enabled ? "已开启" : "已关闭"}`,
		startupMissing: (enabled) =>
			`未加入启动列表 · 自动连接${enabled ? "已开启" : "已关闭"}`,
		startupNeedsName: "加入房间后可保存启动名称。",
		currentName: (name) => `当前名称：${name}`,
		startupMismatch: "启动设置指向另一个 Hub。请到项目设置中修改。",
		startupAdded: "已加入启动列表。",
		startupRemoved: "已从启动列表移除。",
		members: "在线成员",
		noMembers: "没有在线成员。",
		membersScroll: "PgUp / PgDn 滚动成员列表",
		joinForMembers: "加入房间后可查看在线成员。",
		you: (name) => `${name}（你）`,
		history: "历史消息",
		backRoom: "返回房间",
		backList: "返回房间列表",
		loadingHistory: "正在加载消息…",
		historyError: (detail) => `无法加载消息：${detail}`,
		noMessages: "没有符合当前条件的消息。",
		sender: "按发送者筛选",
		applyFilter: "应用筛选",
		newer: "较新消息",
		older: "较早消息",
		attachments: "查看附件",
		loadingAttachments: "正在准备附件…",
		attachmentError: (detail) => `无法准备附件：${detail}`,
		attachmentList: (names) => `附件：${names.join("、")}`,
		replyTo: (ref) => `回复 ${ref}`,
		keys: "Tab / Shift+Tab 切换 · ↑↓ 选择 · Enter 打开 · Esc 返回",
		formKeys: "Tab / Shift+Tab 切换 · Enter 确认 · Esc 取消",
		scroll: "PgUp / PgDn 滚动消息",
	},
} satisfies Record<A2aLanguage, typeof en>;

const HISTORY_LIMIT = 20;
const DETAIL_LINES = 6;
const NARROW_WIDTH = 68;

type Request =
	| "list"
	| "history"
	| "attachments"
	| "mutation"
	| "settings-save"
	| "startup-browse";
type ProjectDraft = A2aLocalConfig & { autoConnect: boolean };
type Settings = {
	level: "project" | "startup" | "room";
	draft: ProjectDraft;
	inheritedHub?: string;
	roomIndex: number;
	editing?: number;
	choices?: A2aRoom[];
	choiceIndex: number;
	error?: string;
};
type Form =
	| { kind: "create" }
	| { kind: "join"; room: string; create?: true }
	| { kind: "delete"; room: string };
type Control = {
	id: string;
	label: string;
	value?: string;
	tone?: "accent" | "error";
};

function node<K extends TspKind>(
	kind: K,
	props: KindAttributes<TspProps<K>>,
): UiNode<K> {
	return new UiNode(kind, props);
}

function text(value: string, style?: string): UiNode<"text"> {
	return node("text", {
		...(style ? { spans: [{ t: value, s: style }] } : { text: value }),
		wrap: "word",
	});
}

type Line = { text: string; cursor: number };
type FieldId =
	| "search"
	| "sender"
	| "name"
	| "cfg-hub"
	| "cfg-room"
	| "cfg-name";

class Field {
	readonly line = signal<Line>({ text: "", cursor: 0 });
	readonly #undo: Line[] = [];

	getValue(): string {
		return this.line.peek().text;
	}

	setValue(text: string): void {
		this.#undo.length = 0;
		this.line.set({ text, cursor: text.length });
	}

	edit({ len, from, to, text, cursor }: TextEdit): boolean {
		const previous = this.line.peek();
		if (len !== previous.text.length) return false;
		const value = previous.text.slice(0, from) + text + previous.text.slice(to);
		const changed = value !== previous.text;
		if (changed) this.#undo.push(previous);
		this.line.set({ text: value, cursor });
		return changed;
	}

	undo(): boolean {
		const previous = this.#undo.pop();
		if (!previous) return false;
		this.line.set(previous);
		return true;
	}
}

// Literal text for both hosts; keep paragraphs but discard terminal controls.
function literal(value: string): string {
	return Bun.stripANSI(value.replace(/\r\n?/g, "\n")).replace(
		/\p{Cc}/gu,
		(char) => (char === "\n" || char === "\t" ? char : "�"),
	);
}

function errorText(error: unknown): string {
	return literal(error instanceof Error ? error.message : String(error));
}

export class A2aConsole {
	readonly #options: ConsoleOptions;
	readonly #copy: typeof en;
	readonly #search = new Field();
	readonly #sender = new Field();
	readonly #name = new Field();
	readonly #hubInput = new Field();
	readonly #startupRoom = new Field();
	readonly #startupName = new Field();
	readonly #revision = signal(0);
	#root?: UiNode<"col">;
	#disposeView?: () => void;
	#inputs?: Record<FieldId, UiNode<"input">>;
	#columns = () => 100;
	#project?: Settings;
	readonly #requests = new Map<Request, AbortController>();
	#focus = "search";
	#hubUrl?: string;
	#room?: string;
	#detailOpen = false;
	#showHistory = false;
	#disposed = false;
	#form?: Form;
	#formError?: string;
	#roomNames: string[] = [];
	#listError?: string;
	#feedback?: { room?: string; text: string; error?: boolean };
	#historyCursors: Array<string | undefined> = [undefined];
	#historyFrom?: string;
	#historyPage?: HistoryPage;
	#historyError?: string;
	#message?: HistoryMessage;
	readonly #links = new WeakMap<HistoryMessage, Attachment[]>();
	#attachmentError?: string;
	#detailOffset = 0;
	#detailLineCount = 0;

	constructor(options: ConsoleOptions) {
		this.#options = options;
		this.#copy = consoleCopy[options.language];
		const snapshot = options.snapshot();
		this.#hubUrl = snapshot.hubUrl;
		if (!snapshot.hubUrl) this.#focus = "settings";
		this.#room = this.#visibleRooms(snapshot)[0];
		void this.#loadRooms();
	}

	#tracked(snapshot: Snapshot): RoomSnapshot | undefined {
		return snapshot.rooms.find(({ room }) => room === this.#room);
	}

	#roomGroups(snapshot: Snapshot) {
		const tracked = snapshot.rooms.map(({ room }) => room);
		const trackedNames = new Set(tracked);
		const query = this.#search.getValue().trim().toLowerCase();
		const matches = (room: string) => room.toLowerCase().includes(query);
		return {
			tracked: tracked.filter(matches),
			discovered: this.#roomNames.filter(
				(room) => !trackedNames.has(room) && matches(room),
			),
		};
	}

	#visibleRooms(snapshot: Snapshot): string[] {
		const { tracked, discovered } = this.#roomGroups(snapshot);
		return [...tracked, ...discovered];
	}

	#createCandidate(snapshot: Snapshot): string | undefined {
		const room = this.#search.getValue().trim();
		if (
			snapshot.hubUrl &&
			!this.#requests.has("list") &&
			!this.#requests.has("mutation") &&
			this.#listError === undefined &&
			ROOM_NAME_RE.test(room) &&
			!this.#visibleRooms(snapshot).length
		)
			return room;
	}

	#startup(snapshot: Snapshot) {
		return this.#startupMismatch(snapshot)
			? undefined
			: snapshot.startup.find(({ room }) => room === this.#room);
	}

	#startupMismatch(snapshot: Snapshot): boolean {
		return (
			snapshot.startupHubUrl !== undefined &&
			snapshot.startupHubUrl !== snapshot.hubUrl
		);
	}

	#cancel(...requests: Request[]): void {
		for (const key of requests) {
			this.#requests.get(key)?.abort();
			this.#requests.delete(key);
		}
	}

	// Whenever the effective Hub changes, none of the old Hub's Room data is usable,
	// including a same-named Room or a request that completes despite cancellation.
	#snapshot(): Snapshot {
		const snapshot = this.#options.snapshot();
		if (snapshot.hubUrl !== this.#hubUrl) {
			this.#hubUrl = snapshot.hubUrl;
			this.#cancel("list", "mutation");
			this.#roomNames = [];
			this.#listError = undefined;
			this.#search.setValue("");
			this.#feedback = undefined;
			this.#form = undefined;
			this.#detailOpen = false;
			this.#showHistory = false;
			if (!this.#project) this.#focus = snapshot.hubUrl ? "search" : "settings";
			this.#room = this.#visibleRooms(snapshot)[0];
			this.#clearRoomContent();
			void this.#loadRooms();
		}
		return snapshot;
	}

	async #request<T>(
		key: Request,
		perform: (signal: AbortSignal) => Promise<T>,
		loaded: (value: T) => void,
		failed: (error: string) => void,
	): Promise<void> {
		this.#cancel(key);
		const controller = new AbortController();
		this.#requests.set(key, controller);
		try {
			const value = await perform(controller.signal);
			if (controller.signal.aborted) return;
			this.#snapshot();
			if (!controller.signal.aborted) loaded(value);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#snapshot();
			if (!controller.signal.aborted) failed(errorText(error));
		} finally {
			if (!controller.signal.aborted) {
				this.#requests.delete(key);
				this.#redraw();
			}
		}
	}

	#loadRooms(refreshHistory = false): Promise<void> {
		this.#listError = undefined;
		return this.#request(
			"list",
			this.#options.list,
			(names) => {
				this.#roomNames = names;
				const snapshot = this.#options.snapshot();
				if (
					!this.#room ||
					(!names.includes(this.#room) && !this.#tracked(snapshot))
				) {
					this.#selectRoom(this.#visibleRooms(snapshot)[0]);
				} else if (
					refreshHistory &&
					this.#showHistory &&
					!this.#requests.has("history")
				) {
					void this.#loadHistory();
				}
			},
			(error) => {
				this.#listError = error;
			},
		);
	}

	#selectRoom(room?: string): void {
		if (this.#room === room) return;
		this.#room = room;
		if (this.#form?.kind !== "create") this.#form = undefined;
		this.#showHistory = false;
		this.#clearRoomContent();
		if (!room) this.#detailOpen = false;
	}

	#clearRoomContent(): void {
		this.#detailOffset = 0;
		this.#sender.setValue("");
		this.#historyFrom = undefined;
		this.#clearHistory();
	}

	#clearHistory(): void {
		this.#cancel("history");
		this.#historyPage = undefined;
		this.#historyError = undefined;
		this.#historyCursors = [undefined];
		this.#selectMessage(undefined);
	}

	#loadHistory(cursors = this.#historyCursors): Promise<void> | undefined {
		const room = this.#room;
		if (!this.#showHistory || !room || !this.#hubUrl) return;
		this.#historyError = undefined;
		const query = {
			limit: HISTORY_LIMIT,
			before: cursors.at(-1),
			from: this.#historyFrom,
		};
		return this.#request(
			"history",
			(signal) => this.#options.history(room, query, signal),
			(page) => {
				this.#historyPage = page;
				this.#historyCursors = cursors;
				this.#selectMessage(page.messages[0]);
			},
			(error) => {
				this.#historyError = error;
			},
		);
	}

	#selectMessage(message?: HistoryMessage): void {
		if (this.#message === message) return;
		this.#cancel("attachments");
		this.#message = message;
		this.#attachmentError = undefined;
		this.#detailOffset = 0;
	}

	#loadAttachments(): Promise<void> | undefined {
		const room = this.#room;
		const message = this.#message;
		if (
			!room ||
			!message?.attachments.length ||
			this.#links.has(message) ||
			this.#requests.has("attachments")
		)
			return;
		this.#attachmentError = undefined;
		return this.#request(
			"attachments",
			(signal) => this.#options.attachments(room, message.ref, signal),
			(links) => {
				this.#links.set(message, links);
			},
			(error) => {
				this.#attachmentError = error;
			},
		);
	}

	#settings(): void {
		try {
			const { config, inheritedHub } = this.#options.loadSettings();
			this.#hubInput.setValue(config?.hubUrl ?? "");
			this.#project = {
				level: "project",
				draft: {
					rooms: [...(config?.rooms ?? [])],
					autoConnect: config?.autoConnect ?? true,
				},
				inheritedHub,
				roomIndex: 0,
				choiceIndex: 0,
			};
			this.#focus = "cfg-hub";
		} catch (error) {
			this.#feedback = { text: errorText(error), error: true };
		}
	}

	#settingsControls(settings: Settings): Control[] {
		const copy = this.#copy.project;
		switch (settings.level) {
			case "project":
				return this.#requests.has("settings-save")
					? []
					: [
							{ id: "cfg-auto", label: copy.auto(settings.draft.autoConnect) },
							{
								id: "cfg-startup",
								label: copy.openRooms(settings.draft.rooms.length),
							},
							{ id: "cfg-save", label: copy.save, tone: "accent" },
							{ id: "cfg-back", label: copy.cancel },
						];
			case "startup":
				return [
					{ id: "cfg-add", label: copy.add },
					{ id: "cfg-back", label: copy.back },
				];
			case "room":
				return [
					{ id: "cfg-apply", label: copy.apply, tone: "accent" },
					...(settings.editing !== undefined
						? [{ id: "cfg-remove", label: copy.remove }]
						: []),
					...(this.#requests.has("startup-browse")
						? []
						: [{ id: "cfg-browse", label: copy.browse }]),
					{ id: "cfg-back", label: copy.cancel },
				];
		}
	}

	#startupChoices(settings: Settings): A2aRoom[] {
		const query = this.#startupRoom.getValue().trim().toLowerCase();
		return (settings.choices ?? []).filter(
			({ name, displayName }) =>
				name.toLowerCase().includes(query) ||
				displayName?.toLowerCase().includes(query),
		);
	}

	#editStartup(settings: Settings, index?: number): void {
		settings.level = "room";
		settings.editing = index;
		settings.choices = undefined;
		settings.error = undefined;
		const entry = index === undefined ? undefined : settings.draft.rooms[index];
		this.#startupRoom.setValue(entry?.room ?? "");
		this.#startupName.setValue(entry?.name ?? "");
		this.#focus = "cfg-room";
	}

	#backFromSettings(settings: Settings): void {
		settings.error = undefined;
		switch (settings.level) {
			case "room":
				this.#cancel("startup-browse");
				settings.level = "startup";
				this.#focus = settings.draft.rooms.length ? "cfg-rooms" : "cfg-add";
				break;
			case "startup":
				settings.level = "project";
				this.#focus = "cfg-startup";
				break;
			case "project":
				this.#project = undefined;
				this.#focus = "settings";
		}
	}

	#runSettings(settings: Settings, id: string): void {
		if (this.#requests.has("settings-save")) return;
		settings.error = undefined;
		switch (id) {
			case "cfg-back":
				this.#backFromSettings(settings);
				break;
			case "cfg-auto":
				settings.draft.autoConnect = !settings.draft.autoConnect;
				break;
			case "cfg-startup":
				settings.level = "startup";
				this.#focus = settings.draft.rooms.length ? "cfg-rooms" : "cfg-add";
				break;
			case "cfg-add":
				this.#editStartup(settings);
				break;
			case "cfg-rooms":
				this.#editStartup(settings, settings.roomIndex);
				break;
			case "cfg-browse":
				void this.#request(
					"startup-browse",
					(signal) =>
						this.#options.listStartupRooms(
							this.#hubInput.getValue().trim(),
							signal,
						),
					(rooms) => {
						const other = settings.draft.rooms.filter(
							(_, index) => index !== settings.editing,
						);
						settings.choices = rooms.filter(
							({ name }) => !other.some(({ room }) => room === name),
						);
						settings.choiceIndex = 0;
						this.#focus = this.#startupChoices(settings).length
							? "cfg-choices"
							: "cfg-room";
					},
					(error) => {
						settings.error = error;
						this.#focus = "cfg-room";
					},
				);
				break;
			case "cfg-choices": {
				const choice = this.#startupChoices(settings)[settings.choiceIndex];
				if (choice) this.#startupRoom.setValue(choice.name);
				this.#focus = "cfg-name";
				break;
			}
			case "cfg-remove":
				if (settings.editing !== undefined)
					settings.draft.rooms.splice(settings.editing, 1);
				settings.roomIndex = Math.max(
					0,
					Math.min(settings.roomIndex, settings.draft.rooms.length - 1),
				);
				this.#backFromSettings(settings);
				break;
			case "cfg-apply": {
				const room = this.#startupRoom.getValue().trim();
				const name = this.#startupName.getValue().trim();
				if (!ROOM_NAME_RE.test(room)) settings.error = this.#copy.invalidRoom;
				else if (!AGENT_NAME_RE.test(name))
					settings.error = this.#copy.invalidName;
				else if (
					settings.draft.rooms.some(
						(entry, index) => entry.room === room && index !== settings.editing,
					)
				)
					settings.error = this.#copy.project.duplicate;
				if (settings.error) break;
				const index = settings.editing ?? settings.draft.rooms.length;
				settings.draft.rooms[index] = { room, name };
				settings.roomIndex = index;
				this.#backFromSettings(settings);
				break;
			}
			case "cfg-save": {
				const hubUrl = this.#hubInput.getValue().trim();
				void this.#request(
					"settings-save",
					() =>
						this.#options.saveSettings({
							...settings.draft,
							hubUrl: hubUrl || undefined,
						}),
					() => {
						this.#backFromSettings(settings);
						this.#feedback = { text: this.#copy.project.saved };
					},
					(error) => {
						settings.error = error;
						this.#focus = "cfg-save";
					},
				);
				break;
			}
		}
	}

	#close(): void {
		this.dispose();
		this.#options.close();
	}

	#openForm(form: Form, snapshot: Snapshot): void {
		if (this.#showHistory) {
			this.#showHistory = false;
			this.#clearHistory();
		}
		this.#form = form;
		this.#formError = undefined;
		this.#name.setValue(
			form.kind === "join" && !form.create
				? (this.#startup(snapshot)?.name ?? "")
				: "",
		);
		// Deletion confirmation starts on Cancel, never on the destructive button.
		this.#focus = form.kind === "delete" ? "cancel" : "name";
	}

	#dismissForm(): void {
		const form = this.#form;
		this.#focus =
			form?.kind === "delete" || (form?.kind === "join" && !form.create)
				? form.kind
				: "search";
		this.#form = undefined;
		this.#formError = undefined;
	}

	#confirm(snapshot: Snapshot): void {
		const form = this.#form;
		if (!form || !snapshot.hubUrl || this.#requests.has("mutation")) return;
		const name = this.#name.getValue().trim();
		const copy = this.#copy;
		if (form.kind !== "delete" && !name) {
			this.#formError =
				form.kind === "create" ? copy.invalidRoom : copy.invalidName;
			return;
		}
		if (
			form.kind !== "create" &&
			!(form.kind === "join" && form.create) &&
			(form.room !== this.#room || this.#tracked(snapshot))
		) {
			this.#formError =
				form.kind === "delete" ? copy.leaveFirst : copy.status.connected;
			return;
		}
		this.#formError = undefined;
		void this.#request(
			"mutation",
			async (signal) => {
				if (form.kind === "join" && form.create) {
					await this.#options.create(form.room, signal);
					signal.throwIfAborted();
					this.#roomNames = [...this.#roomNames, form.room];
					this.#selectRoom(form.room);
					this.#form = { kind: "join", room: form.room };
				}
				switch (form.kind) {
					case "create":
						await this.#options.create(name, signal);
						break;
					case "join":
						await this.#options.join(form.room, name);
						break;
					case "delete":
						await this.#options.delete(form.room, signal);
						break;
				}
			},
			() => {
				this.#dismissForm();
				switch (form.kind) {
					case "create":
						if (!this.#roomNames.includes(name))
							this.#roomNames = [...this.#roomNames, name];
						if (!this.#room) this.#selectRoom(name);
						this.#feedback = { text: copy.created(name) };
						void this.#loadRooms();
						break;
					case "join":
						this.#feedback = { room: form.room, text: copy.joined(name) };
						this.#focus = "room-list";
						break;
					case "delete":
						this.#roomNames = this.#roomNames.filter(
							(room) => room !== form.room,
						);
						this.#selectRoom(this.#visibleRooms(this.#options.snapshot())[0]);
						this.#feedback = { text: copy.deleted(form.room) };
						this.#focus = "room-list";
						void this.#loadRooms();
						break;
				}
			},
			(error) => {
				if (
					form.kind === "join" &&
					this.#options.snapshot().rooms.some(({ room }) => room === form.room)
				) {
					this.#dismissForm();
					this.#focus = "leave";
					this.#feedback = { room: form.room, text: error, error: true };
				} else {
					this.#formError = error;
				}
			},
		);
	}

	#leave(room: string): void {
		void this.#request(
			"mutation",
			() => this.#options.leave(room),
			() => {
				this.#feedback = { room, text: this.#copy.left };
				this.#focus = "join";
			},
			(error) => {
				this.#feedback = { room, text: error, error: true };
			},
		);
	}

	#changeStartup(snapshot: Snapshot, room: string, remove: boolean): void {
		if (this.#startupMismatch(snapshot)) return;
		const tracked = this.#tracked(snapshot);
		const name =
			!remove && tracked?.state === "connected" ? tracked.self : undefined;
		if (!remove && !name) return;
		try {
			this.#options.setStartup(room, name);
			this.#feedback = {
				room,
				text: remove ? this.#copy.startupRemoved : this.#copy.startupAdded,
			};
			this.#focus = remove ? "add-startup" : "remove-startup";
		} catch (error) {
			this.#feedback = { room, text: errorText(error), error: true };
		}
	}

	#headerControls(snapshot: Snapshot): Control[] {
		return [
			...(snapshot.hubUrl
				? [
						{
							id: "refresh",
							label: this.#listError ? this.#copy.retry : this.#copy.refresh,
						},
					]
				: []),
			...(snapshot.hubUrl &&
			!nativeRendering() &&
			!this.#requests.has("mutation")
				? [{ id: "create", label: this.#copy.create }]
				: []),
			{ id: "close", label: this.#copy.close },
		];
	}

	#roomControls(snapshot: Snapshot): Control[] {
		const room = this.#room;
		if (!room) return [];
		const copy = this.#copy;
		const tracked = this.#tracked(snapshot);
		const controls: Control[] = tracked
			? [{ id: "leave", label: copy.leave, value: room }]
			: [{ id: "join", label: copy.join, value: room, tone: "accent" }];
		if (!this.#startupMismatch(snapshot)) {
			if (this.#startup(snapshot))
				controls.push({
					id: "remove-startup",
					label: copy.removeStartup,
					value: room,
				});
			else if (tracked?.state === "connected" && tracked.self)
				controls.push({
					id: "add-startup",
					label: copy.addStartup,
					value: room,
				});
		}
		controls.push({ id: "history", label: copy.history, value: room });
		if (!tracked)
			controls.push({
				id: "delete",
				label: copy.delete,
				value: room,
				tone: "error",
			});
		return controls;
	}

	#formControls(): Control[] {
		const form = this.#form;
		if (!form || this.#requests.has("mutation")) return [];
		const copy = this.#copy;
		return [
			{ id: "cancel", label: copy.cancel },
			{
				id: "confirm",
				label:
					form.kind === "join"
						? form.create
							? copy.confirmCreateAndJoin
							: copy.confirmJoin
						: form.kind === "create"
							? copy.confirmCreate
							: copy.confirmDelete,
				value: form.kind === "create" ? "create" : `${form.kind}:${form.room}`,
				tone: form.kind === "delete" ? "error" : "accent",
			},
		];
	}

	#historyControls(): Control[] {
		const copy = this.#copy;
		const controls: Control[] = [
			{ id: "back-room", label: copy.backRoom },
			{ id: "filter", label: copy.applyFilter },
		];
		if (!this.#requests.has("history")) {
			if (this.#historyCursors.length > 1)
				controls.push({ id: "newer", label: copy.newer });
			if (this.#historyPage?.nextBefore)
				controls.push({ id: "older", label: copy.older });
		}
		if (
			this.#message?.attachments.length &&
			!this.#requests.has("attachments") &&
			!this.#links.has(this.#message)
		) {
			controls.push({
				id: "attachments",
				label: copy.attachments,
				value: this.#message.ref,
			});
		}
		return controls;
	}

	#controls(snapshot: Snapshot, narrow: boolean): Control[] {
		if (this.#project) {
			return [
				...this.#settingsControls(this.#project),
				...(!this.#requests.has("settings-save")
					? [{ id: "cfg-close", label: this.#copy.close }]
					: []),
			];
		}
		if (this.#form) return this.#formControls();
		const copy = this.#copy;
		const controls: Control[] = [];
		if (narrow && this.#detailOpen) {
			if (!this.#showHistory)
				controls.push({ id: "back-list", label: copy.backList });
		} else if (!this.#showHistory) {
			const candidate = this.#createCandidate(snapshot);
			if (candidate)
				controls.push({
					id: "create-join",
					label: `${copy.confirmCreateAndJoin} · ${literal(candidate)}`,
					value: candidate,
					tone: "accent",
				});
			controls.push({
				id: "settings",
				label: snapshot.hubUrl ? copy.settings : copy.configureHub,
			});
		}
		if (!narrow || this.#detailOpen) {
			if (this.#showHistory) controls.push(...this.#historyControls());
			else if (!this.#requests.has("mutation"))
				controls.push(...this.#roomControls(snapshot));
		}
		return [...controls, ...this.#headerControls(snapshot)];
	}

	#run(control: Control, snapshot: Snapshot): void {
		if (this.#project) {
			if (control.id === "cfg-close") {
				this.#cancel("startup-browse");
				this.#project = undefined;
				this.#focus = this.#showHistory ? "sender" : "search";
			} else this.#runSettings(this.#project, control.id);
			this.#redraw();
			return;
		}
		const room = this.#room;
		switch (control.id) {
			case "close":
				this.#close();
				return;
			case "settings":
				this.#settings();
				break;
			case "refresh":
				void this.#loadRooms(true);
				break;
			case "create":
				this.#openForm({ kind: "create" }, snapshot);
				break;
			case "create-join":
				if (control.value)
					this.#openForm(
						{ kind: "join", room: control.value, create: true },
						snapshot,
					);
				break;
			case "join":
				if (room) this.#openForm({ kind: "join", room }, snapshot);
				break;
			case "delete":
				if (room) this.#openForm({ kind: "delete", room }, snapshot);
				break;
			case "cancel":
				this.#dismissForm();
				break;
			case "confirm":
				this.#confirm(snapshot);
				break;
			case "leave":
				if (room) this.#leave(room);
				break;
			case "add-startup":
				if (room) this.#changeStartup(snapshot, room, false);
				break;
			case "remove-startup":
				if (room) this.#changeStartup(snapshot, room, true);
				break;
			case "history":
				this.#showHistory = true;
				this.#detailOpen = true;
				this.#detailOffset = 0;
				this.#focus = "sender";
				void this.#loadHistory();
				break;
			case "back-room":
				this.#showHistory = false;
				this.#detailOffset = 0;
				this.#focus = "history";
				this.#clearHistory();
				break;
			case "back-list":
				this.#detailOpen = false;
				this.#focus = "room-list";
				break;
			case "filter":
				this.#historyFrom = this.#sender.getValue().trim() || undefined;
				this.#clearHistory();
				void this.#loadHistory();
				break;
			case "newer":
				void this.#loadHistory(this.#historyCursors.slice(0, -1));
				break;
			case "older":
				if (this.#historyPage?.nextBefore)
					void this.#loadHistory([
						...this.#historyCursors,
						this.#historyPage.nextBefore,
					]);
				break;
			case "attachments":
				void this.#loadAttachments();
				break;
		}
		this.#redraw();
	}

	#field(id: string): Field | undefined {
		switch (id) {
			case "search":
				return this.#search;
			case "sender":
				return this.#sender;
			case "name":
				return this.#name;
			case "cfg-hub":
				return this.#hubInput;
			case "cfg-room":
				return this.#startupRoom;
			case "cfg-name":
				return this.#startupName;
		}
	}

	#edited(field: string, snapshot: Snapshot): void {
		if (this.#project) {
			this.#project.error = undefined;
			if (field === "cfg-room") this.#project.choiceIndex = 0;
			return;
		}
		if (field === "search") {
			const rooms = this.#visibleRooms(snapshot);
			if (!this.#room || !rooms.includes(this.#room))
				this.#selectRoom(rooms[0]);
		} else if (field === "name") this.#formError = undefined;
	}

	#redraw(): void {
		batch(() => {
			this.#revision.set(this.#revision.peek() + 1);
			this.#options.redraw();
		});
	}

	#focusField(id: FieldId): void {
		if (this.#disposed || this.#focus === id) return;
		this.#focus = id;
		this.#redraw();
	}

	#focusStops(
		snapshot: Snapshot,
		controls: Control[],
		narrow: boolean,
	): string[] {
		if (this.#project) {
			const entries = this.#settingsList(this.#project);
			return [
				...this.#settingsFields(this.#project),
				...(entries?.rows.length ? [entries.id] : []),
				...controls.map(({ id }) => id),
			];
		}
		if (this.#form)
			return [
				...(this.#form.kind !== "delete" && !this.#requests.has("mutation")
					? ["name"]
					: []),
				...controls.map(({ id }) => id),
			];
		const showRooms = (!narrow || !this.#detailOpen) && snapshot.hubUrl;
		return [
			...(showRooms && !this.#showHistory ? ["search"] : []),
			...(showRooms && this.#visibleRooms(snapshot).length
				? ["room-list"]
				: []),
			...(this.#showHistory
				? [
						"sender",
						...(this.#historyPage?.messages.length ? ["message-list"] : []),
					]
				: []),
			...controls.map(({ id }) => id),
		];
	}

	#onKey(key: KeyEvent): boolean {
		if (this.#disposed || key.kind === "release") return false;
		const snapshot = this.#snapshot();
		const narrow = this.#columns() < NARROW_WIDTH;
		const controls = this.#controls(snapshot, narrow);
		const run = (id: string) => {
			const control = controls.find((control) => control.id === id);
			if (control) this.#run(control, snapshot);
		};
		if (widgetKeyMatches(key, "select.cancel")) {
			if (this.#project) run("cfg-back");
			else if (this.#form) run("cancel");
			else if (this.#showHistory) run("back-room");
			else if (narrow && this.#detailOpen) run("back-list");
			else this.#close();
			return true;
		}
		const stops = this.#focusStops(snapshot, controls, narrow);
		const current = stops.indexOf(this.#focus);
		const focus = stops[current] ?? stops[0];
		if (focus === undefined) return true;
		if (key.id === "tab" || key.id === "shift+tab") {
			const delta = key.id === "tab" ? 1 : -1;
			this.#focus =
				(current < 0
					? delta === 1
						? stops[0]
						: stops.at(-1)
					: stops[(current + delta + stops.length) % stops.length]) ?? focus;
		} else if (widgetKeyMatches(key, "select.confirm")) {
			switch (focus) {
				case "search":
					if (this.#room) this.#enterRoom();
					else run("create-join");
					break;
				case "room-list":
					this.#enterRoom();
					break;
				case "sender":
					run("filter");
					break;
				case "name":
					run("confirm");
					break;
				case "message-list":
					run("attachments");
					break;
				case "cfg-hub":
					this.#focus = "cfg-auto";
					break;
				case "cfg-room":
					this.#focus = "cfg-name";
					break;
				case "cfg-name":
					run("cfg-apply");
					break;
				case "cfg-rooms":
				case "cfg-choices":
					if (this.#project) this.#runSettings(this.#project, focus);
					break;
				default:
					run(focus);
					return true;
			}
		} else if (
			widgetKeyMatches(key, "select.up") ||
			widgetKeyMatches(key, "select.down")
		) {
			const delta = widgetKeyMatches(key, "select.up") ? -1 : 1;
			if (this.#project && (focus === "cfg-rooms" || focus === "cfg-choices")) {
				const entries = this.#settingsList(this.#project);
				if (entries?.rows.length) {
					const index = Math.max(
						0,
						Math.min(entries.rows.length - 1, entries.index + delta),
					);
					if (focus === "cfg-rooms") this.#project.roomIndex = index;
					else this.#project.choiceIndex = index;
				}
			} else if (focus === "search" || focus === "room-list") {
				const rooms = this.#visibleRooms(snapshot);
				const index = this.#room ? rooms.indexOf(this.#room) : -1;
				const room =
					rooms[Math.min(rooms.length - 1, Math.max(0, index + delta))];
				if (room) {
					this.#selectRoom(room);
					this.#focus = "room-list";
				}
			} else if (focus === "sender" || focus === "message-list") {
				const messages = this.#historyPage?.messages ?? [];
				const index = this.#message ? messages.indexOf(this.#message) : -1;
				const message =
					messages[Math.min(messages.length - 1, Math.max(0, index + delta))];
				if (message) {
					this.#selectMessage(message);
					this.#focus = "message-list";
				}
			} else if (!this.#field(focus)) {
				this.#focus =
					stops[(stops.indexOf(focus) + delta + stops.length) % stops.length] ??
					focus;
			}
		} else if (
			!this.#project &&
			!this.#form &&
			(widgetKeyMatches(key, "select.pageUp") ||
				widgetKeyMatches(key, "select.pageDown"))
		) {
			const delta = widgetKeyMatches(key, "select.pageUp")
				? -DETAIL_LINES
				: DETAIL_LINES;
			this.#detailOffset = Math.max(
				0,
				Math.min(
					this.#detailOffset + delta,
					this.#detailLineCount - DETAIL_LINES,
				),
			);
		} else {
			// custom() hands the keys to the root, not its input descendants.
			// Let the SDK field widget handle editing, selection, and the keymap.
			const input = this.#inputs?.[focus as FieldId];
			return input
				? fieldWidget.key?.(input, key, this.#fieldContext(input)) === true
				: false;
		}
		this.#redraw();
		return true;
	}

	#button({ id, label, value, tone }: Control, face = label): UiNode<"button"> {
		const action = value === undefined ? id : `${id}=${value}`;
		return node("button", {
			key: id === "focus" ? `focus-${value}` : id,
			text: face,
			title: label,
			aria: label,
			size: "sm",
			on: this.#focus === id,
			variant:
				tone === "error" ? "danger" : tone === "accent" ? "primary" : "default",
			actions: { click: action },
			onAction: (act, event) => {
				if (
					this.#disposed ||
					(act !== action && (act !== id || event.value !== value))
				)
					return;
				const snapshot = this.#snapshot();
				if (id === "focus") {
					const fields = this.#project
						? this.#settingsFields(this.#project)
						: [this.#showHistory ? "sender" : "name"];
					const field = fields.find((field) => field === value);
					if (field) this.#focusField(field as FieldId);
					return;
				}
				const current = this.#controls(
					snapshot,
					this.#columns() < NARROW_WIDTH,
				).find((entry) => entry.id === id && entry.value === value);
				if (current) this.#run(current, snapshot);
				else if (id === "close") this.#close();
			},
		});
	}

	#describeInput(id: FieldId): JSXNode {
		const input = this.#inputs?.[id];
		if (!input) return;
		if (id === "search" || this.#focus === id) return input;
		const label = input.props().title ?? "";
		const value = this.#field(id)?.line().text;
		return this.#button({
			id: "focus",
			value: id,
			label: value ? `${label}: ${literal(value)}` : label,
		});
	}

	#fieldContext(input: UiNode<"input">) {
		return widgetContext([input], { focus: () => {}, pageRows: DETAIL_LINES });
	}

	#onPaste(paste: PasteEvent): boolean {
		if (this.#disposed) return false;
		const snapshot = this.#snapshot();
		const narrow = this.#columns() < NARROW_WIDTH;
		const stops = this.#focusStops(
			snapshot,
			this.#controls(snapshot, narrow),
			narrow,
		);
		const focus = stops.includes(this.#focus) ? this.#focus : stops[0];
		const input = this.#inputs?.[focus as FieldId];
		return input
			? fieldWidget.paste?.(input, paste, this.#fieldContext(input)) === true
			: false;
	}

	#createInput(
		id: FieldId,
		field: Field,
		label: () => string,
	): UiNode<"input"> {
		const edited = (edit?: TextEdit) => {
			if (this.#disposed) return;
			const snapshot = this.#snapshot();
			const changed = edit ? field.edit(edit) : field.undo();
			if (changed) this.#edited(id, snapshot);
			if (changed || this.#focus !== id) {
				this.#focus = id;
				this.#redraw();
			}
		};
		return node("input", {
			key: `${id}-input`,
			role: "omp.a2a.input",
			title: label,
			aria: label,
			text: () => field.line().text,
			cursor: () => field.line().cursor,
			placeholder: label,
			grow: 1,
			term: () => {
				this.#revision();
				return this.#focus === id
					? undefined
					: { caret: "none", caretEnd: "none" };
			},
			onEdit: edited,
			onUndo: () => edited(),
			onFocus: () => this.#focusField(id),
		});
	}

	#enterRoom(): void {
		if (!this.#room) return;
		this.#detailOpen = true;
		this.#focus = this.#showHistory
			? "sender"
			: this.#tracked(this.#options.snapshot())
				? "history"
				: "join";
	}

	#status(room?: RoomSnapshot): string {
		return this.#copy.status[room?.state ?? "notJoined"];
	}

	#emptyRoomList(snapshot: Snapshot): string | undefined {
		if (
			!snapshot.hubUrl ||
			this.#listError ||
			this.#visibleRooms(snapshot).length
		)
			return;
		if (this.#requests.has("list")) return this.#copy.loadingRooms;
		return this.#roomNames.length || snapshot.rooms.length
			? this.#copy.noMatching
			: this.#copy.noRooms;
	}

	#members(tracked?: RoomSnapshot): string[] {
		const copy = this.#copy;
		if (tracked?.state !== "connected") return [];
		return [
			...(tracked.self ? [copy.you(literal(tracked.self))] : []),
			...tracked.peers.map(literal),
		];
	}

	#startupLabel(snapshot: Snapshot): string {
		if (this.#startupMismatch(snapshot)) return this.#copy.startupMismatch;
		const record = this.#startup(snapshot);
		return record
			? this.#copy.startupName(literal(record.name), snapshot.autoConnect)
			: this.#copy.startupMissing(snapshot.autoConnect);
	}

	#feedbackFor(room?: string) {
		return this.#feedback?.room === room ? this.#feedback : undefined;
	}

	#messageLines(message: HistoryMessage): string[] {
		const copy = this.#copy;
		const links = this.#links.get(message);
		return [
			...(message.replyTo ? [copy.replyTo(literal(message.replyTo))] : []),
			literal(message.text),
			...(links
				? links.map(({ name, url }) => `${literal(name)}: ${literal(url)}`)
				: message.attachments.length
					? [copy.attachmentList(message.attachments.map(literal))]
					: []),
			...(this.#requests.has("attachments") ? [copy.loadingAttachments] : []),
			...(this.#attachmentError
				? [copy.attachmentError(this.#attachmentError)]
				: []),
		];
	}

	#historyNotice(): string | undefined {
		if (this.#requests.has("history")) return this.#copy.loadingHistory;
		if (this.#historyError) return this.#copy.historyError(this.#historyError);
		if (this.#historyPage?.messages.length === 0) return this.#copy.noMessages;
	}

	#describeHistory(width: number): JSXNode {
		const [back, ...controls] = this.#historyControls();
		const messages = this.#historyPage?.messages ?? [];
		const notice = this.#historyNotice();
		const message = this.#message;
		const selectMessage = (ref: string) => {
			this.#snapshot();
			if (this.#disposed || !this.#showHistory || this.#project || this.#form)
				return;
			const next = this.#historyPage?.messages.find(
				(entry) => entry.ref === ref,
			);
			if (!next) return;
			this.#selectMessage(next);
			this.#focus = "message-list";
			this.#redraw();
		};
		const lines = message ? this.#messageLines(message) : [];
		const wrapped = nativeRendering()
			? lines
			: lines.flatMap((line) => wrap(line, width));
		this.#detailLineCount = wrapped.length;
		const offset = Math.min(
			this.#detailOffset,
			Math.max(0, wrapped.length - DETAIL_LINES),
		);
		return [
			back && this.#room && this.#button(back, `‹ ${literal(this.#room)}`),
			text(this.#copy.history, "strong"),
			this.#describeInput("sender"),
			this.#buttons(controls),
			notice && text(notice),
			messages.length > 0 &&
				node("list", {
					key: "message-list",
					selected: message?.ref ?? null,
					max: { lines: 5 },
					actions: { click: "select" },
					onSelect: selectMessage,
					children: this.#listWindow(
						messages,
						message ? messages.indexOf(message) : -1,
						5,
					).map(({ ref, from }) =>
						node("item", {
							key: ref,
							label: literal(from),
							detail: literal(ref),
						}),
					),
				}),
			message &&
				node("section", {
					key: "message",
					head: `${literal(message.ref)} · ${literal(message.from)}`,
					children: [
						...(nativeRendering()
							? wrapped
							: wrapped.slice(offset, offset + DETAIL_LINES)
						).map((line) =>
							node("text", {
								text: line,
								wrap: "word",
								actions: { menu: ["copy"] },
							}),
						),
						!nativeRendering() &&
							wrapped.length > DETAIL_LINES &&
							text(this.#copy.scroll, "muted"),
					],
				}),
		];
	}

	#describeForm(form: Form): JSXNode {
		const copy = this.#copy;
		const label =
			form.kind === "create"
				? copy.confirmCreate
				: form.kind === "join"
					? `${form.create ? copy.confirmCreateAndJoin : copy.confirmJoin} · ${literal(form.room)}`
					: copy.confirmDeletion(literal(form.room));
		const busy = this.#requests.has("mutation");
		return [
			text(label, form.kind === "delete" ? "error" : "strong"),
			!busy && form.kind !== "delete" && this.#describeInput("name"),
			busy && node("spinner", { label: copy.working }),
			this.#formError && text(this.#formError, "error"),
			this.#buttons(this.#formControls()),
		];
	}

	#hubLines(snapshot: Snapshot): string[] {
		const copy = this.#copy;
		return [
			snapshot.hubUrl
				? copy.currentHub(literal(snapshot.hubUrl))
				: copy.hubUnconfigured,
			...(snapshot.startupHubUrl && this.#startupMismatch(snapshot)
				? [copy.startupHub(literal(snapshot.startupHubUrl))]
				: []),
		];
	}

	#settingsFields(settings: Settings): FieldId[] {
		if (this.#requests.has("settings-save")) return [];
		if (settings.level === "project") return ["cfg-hub"];
		if (settings.level === "room") return ["cfg-room", "cfg-name"];
		return [];
	}

	#settingsList(settings: Settings) {
		if (settings.level === "startup")
			return {
				id: "cfg-rooms",
				rows: settings.draft.rooms,
				index: settings.roomIndex,
				empty: this.#copy.project.empty,
			};
		if (settings.level === "room" && settings.choices)
			return {
				id: "cfg-choices",
				rows: this.#startupChoices(settings).map(({ name, displayName }) => ({
					room: name,
					name: displayName,
				})),
				index: settings.choiceIndex,
				empty: this.#copy.project.noMatch,
			};
	}

	#settingsHeading(settings: Settings): string {
		const copy = this.#copy;
		if (settings.level === "project") return copy.settings;
		const path = `${copy.settings} › ${copy.project.startup}`;
		if (settings.level === "startup") return path;
		return `${path} › ${settings.editing === undefined ? copy.project.add : copy.project.edit}`;
	}

	#describeSettings(settings: Settings): JSXNode {
		const copy = this.#copy;
		const entries = this.#settingsList(settings);
		const select = (room: string) => {
			if (this.#disposed || this.#project !== settings) return;
			const current = this.#settingsList(settings);
			if (!entries || entries.id !== current?.id) return;
			const index = current.rows.findIndex((entry) => entry.room === room);
			if (index < 0) return;
			if (entries.id === "cfg-rooms") settings.roomIndex = index;
			else settings.choiceIndex = index;
			this.#runSettings(settings, entries.id);
			this.#redraw();
		};
		return [
			node("row", {
				gap: "sm",
				align: "center",
				children: [
					text(this.#settingsHeading(settings), "strong"),
					!this.#requests.has("settings-save") &&
						this.#button({ id: "cfg-close", label: copy.close }, "×"),
				],
			}),
			settings.level === "project" && [
				text(copy.project.note),
				text(copy.project.inherit(settings.inheritedHub)),
			],
			this.#settingsFields(settings).map((id) => this.#describeInput(id)),
			entries &&
				node("list", {
					key: entries.id,
					selected: entries.rows[entries.index]?.room ?? null,
					max: { lines: 6 },
					empty: entries.empty,
					actions: { click: "select" },
					onSelect: select,
					children: this.#listWindow(entries.rows, entries.index, 6).map(
						({ room, name }) =>
							node("item", {
								key: room,
								label: literal(room),
								detail: name ? literal(name) : undefined,
							}),
					),
				}),
			settings.error && text(settings.error, "error"),
			this.#requests.has("settings-save") &&
				node("spinner", { label: copy.working }),
			this.#requests.has("startup-browse") &&
				node("spinner", { label: copy.loadingRooms }),
			this.#buttons(this.#settingsControls(settings)),
		];
	}

	#buttons(controls: Control[]): JSXNode {
		const children = controls.map((control) => this.#button(control));
		return nativeRendering()
			? node("row", { gap: "sm", wrap: true, children })
			: node("col", { children });
	}

	#listWindow<T>(
		entries: readonly T[],
		index: number,
		count: number,
	): readonly T[] {
		if (nativeRendering()) return entries;
		// The terminal list painter clamps from the front; keep the selection in view.
		const start = Math.max(0, Math.min(index - 1, entries.length - count));
		return entries.slice(start, start + count);
	}

	#describeRoomList(
		snapshot: Snapshot,
		controls: Control[],
		split: boolean,
	): UiNode<"col"> {
		const copy = this.#copy;
		const groups = this.#roomGroups(snapshot);
		const empty = this.#emptyRoomList(snapshot);
		const enabled =
			!this.#project && !this.#form && !this.#requests.has("mutation");
		const select = (name: string, activate = false) => {
			const current = this.#snapshot();
			if (
				this.#disposed ||
				this.#form ||
				this.#project ||
				this.#requests.has("mutation") ||
				!this.#visibleRooms(current).includes(name)
			)
				return;
			this.#selectRoom(name);
			this.#focus = this.#showHistory ? "sender" : "search";
			if (this.#columns() < NARROW_WIDTH) this.#enterRoom();
			if (activate && !this.#tracked(current))
				this.#openForm({ kind: "join", room: name }, current);
			this.#redraw();
		};
		return node("col", {
			key: "rooms",
			basis: split
				? nativeRendering()
					? 0.34
					: Math.floor(this.#columns() / 3)
				: undefined,
			children: [
				snapshot.hubUrl &&
					(this.#project || this.#showHistory
						? text(literal(this.#search.getValue()) || copy.search, "muted")
						: this.#describeInput("search")),
				...(["tracked", "discovered"] as const).flatMap((group) => {
					const names = groups[group];
					if (!names.length) return [];
					const selected =
						this.#room && names.includes(this.#room) ? this.#room : null;
					const canDelete = enabled && group === "discovered";
					return [
						text(
							copy[group],
							this.#focus === "room-list" && selected ? "accent" : "muted",
						),
						node("list", {
							key: `${group}-list`,
							selected,
							max: { lines: 6 },
							actions: enabled
								? {
										click: "select",
										...(canDelete ? { dblclick: "activate" } : {}),
									}
								: undefined,
							onSelect: (name) => {
								if (enabled) select(name);
							},
							onActivate: (name) => {
								if (canDelete) select(name, true);
							},
							children: this.#listWindow(
								names,
								selected ? names.indexOf(selected) : -1,
								5,
							).map((name) => {
								const room = snapshot.rooms.find(
									(entry) => entry.room === name,
								);
								const deleteAction = `delete=${name}`;
								const menu = [
									{ id: deleteAction, label: copy.delete, danger: true },
								];
								return node("item", {
									key: name,
									label: literal(name),
									value:
										room?.state === "connected" && room.self
											? literal(room.self)
											: room && this.#status(room),
									actions: canDelete ? { menu, hold: menu } : undefined,
									onAction: (act, event) => {
										if (
											!canDelete ||
											this.#disposed ||
											(act !== deleteAction &&
												(act !== "delete" || event.value !== name))
										)
											return;
										const current = this.#snapshot();
										if (
											this.#form ||
											this.#project ||
											this.#requests.has("mutation") ||
											!this.#roomGroups(current).discovered.includes(name)
										)
											return;
										this.#selectRoom(name);
										this.#openForm({ kind: "delete", room: name }, current);
										this.#redraw();
									},
								});
							}),
						}),
					];
				}),
				this.#listError !== undefined
					? text(copy.listError(this.#listError), "error")
					: empty && !controls.some(({ id }) => id === "create-join")
						? text(empty)
						: undefined,
				...controls
					.filter(({ id }) => id === "settings" || id === "create-join")
					.map((control) => this.#button(control)),
			],
		});
	}

	#describeRoom(
		snapshot: Snapshot,
		room: string,
		controls: Control[],
	): JSXNode {
		const copy = this.#copy;
		const tracked = this.#tracked(snapshot);
		const members = this.#members(tracked);
		const feedback = this.#feedbackFor(room);
		this.#detailLineCount = members.length;
		const offset = Math.min(
			this.#detailOffset,
			Math.max(0, members.length - DETAIL_LINES),
		);
		const roster = nativeRendering()
			? members
			: members.slice(offset, offset + DETAIL_LINES);
		return [
			node("row", {
				gap: "sm",
				wrap: true,
				children: [
					text(literal(room), "strong"),
					node("badge", {
						text: this.#status(tracked),
						tone:
							tracked?.state === "connected"
								? "success"
								: tracked
									? "pending"
									: "muted",
					}),
				],
			}),
			tracked?.state === "connected" &&
				tracked.self &&
				text(copy.currentName(literal(tracked.self)), "muted"),
			text(this.#startupLabel(snapshot)),
			!this.#startupMismatch(snapshot) &&
				!this.#startup(snapshot) &&
				!tracked?.self &&
				text(copy.startupNeedsName, "muted"),
			feedback && text(feedback.text, feedback.error ? "error" : "success"),
			this.#requests.has("mutation") &&
				node("spinner", { label: copy.working }),
			this.#buttons(controls),
			text(
				members.length ? `${copy.members} · ${members.length}` : copy.members,
				"strong",
			),
			node("list", {
				key: "members-list",
				max: { lines: DETAIL_LINES },
				empty:
					tracked?.state === "connected" ? copy.noMembers : copy.joinForMembers,
				children: roster.map((name) =>
					node("item", { key: name, label: name }),
				),
			}),
			!nativeRendering() &&
				members.length > DETAIL_LINES &&
				text(copy.membersScroll, "muted"),
		];
	}

	#describeBody(): JSXNode {
		const snapshot = this.#snapshot();
		const columns = this.#columns();
		const narrow = columns < NARROW_WIDTH;
		const copy = this.#copy;
		const controls = this.#controls(snapshot, narrow);
		const feedback = this.#feedbackFor();
		const showRooms =
			!this.#form && (!narrow || (!this.#detailOpen && !this.#project));
		const showOverview = this.#room && (!narrow || this.#detailOpen);
		const showDetail =
			this.#form || this.#project || this.#showHistory || showOverview;
		const split = showRooms && Boolean(showDetail);
		const detailWidth = Math.max(
			1,
			columns - (split ? Math.floor(columns / 3) + 3 : 0),
		);
		const detail = this.#form
			? this.#describeForm(this.#form)
			: this.#project
				? this.#describeSettings(this.#project)
				: this.#showHistory
					? this.#describeHistory(detailWidth)
					: showOverview && this.#room
						? this.#describeRoom(
								snapshot,
								this.#room,
								controls.filter(({ id }) =>
									[
										"back-list",
										"join",
										"leave",
										"add-startup",
										"remove-startup",
										"history",
										"delete",
									].includes(id),
								),
							)
						: undefined;
		const rooms =
			showRooms && this.#describeRoomList(snapshot, controls, split);
		const headerButtons = [
			...controls
				.filter(({ id }) => id === "refresh" || id === "create")
				.map((control) => this.#button(control)),
			this.#button({ id: "close", label: copy.close }, "×"),
		];
		return [
			node("row", {
				gap: "sm",
				wrap: true,
				children: [
					text(copy.title, "strong"),
					snapshot.hubUrl &&
						(this.#requests.has("list")
							? node("spinner", { label: copy.loadingRooms })
							: node("badge", {
									text:
										this.#listError === undefined
											? copy.hubOnline
											: copy.hubUnavailable,
									tone: this.#listError === undefined ? "success" : "error",
								})),
					nativeRendering() && headerButtons,
				],
			}),
			!nativeRendering() && node("row", { gap: "sm", children: headerButtons }),
			this.#hubLines(snapshot).map((line) => text(line, "muted")),
			feedback &&
				!this.#project &&
				text(feedback.text, feedback.error ? "error" : "success"),
			node("rule", {}),
			split
				? node("row", {
						gap: "lg",
						align: "start",
						children: [
							rooms,
							node("col", {
								key: "detail",
								grow: 1,
								basis: nativeRendering() ? 0.55 : 0,
								children: detail,
							}),
						],
					})
				: [rooms, detail],
			text(this.#form ? copy.formKeys : copy.keys, "muted"),
		];
	}

	describe(revision?: () => unknown, columns?: () => number): UiNode<"col"> {
		if (this.#root) return this.#root;
		if (columns) this.#columns = columns;
		return createRoot((dispose) => {
			this.#disposeView = dispose;
			const copy = this.#copy;
			this.#inputs = {
				search: this.#createInput("search", this.#search, () => copy.search),
				sender: this.#createInput("sender", this.#sender, () => copy.sender),
				name: this.#createInput("name", this.#name, () => {
					this.#revision();
					return this.#form?.kind === "join" ? copy.rosterName : copy.roomName;
				}),
				"cfg-hub": this.#createInput(
					"cfg-hub",
					this.#hubInput,
					() => copy.project.hub,
				),
				"cfg-room": this.#createInput(
					"cfg-room",
					this.#startupRoom,
					() => copy.roomName,
				),
				"cfg-name": this.#createInput(
					"cfg-name",
					this.#startupName,
					() => copy.rosterName,
				),
			};
			this.#root = node("col", {
				key: "a2a-workbench",
				onKey: (key) => this.#onKey(key),
				onPaste: (paste) => this.#onPaste(paste),
				children: () => {
					this.#revision();
					revision?.();
					return this.#describeBody();
				},
			});
			return this.#root;
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const controller of this.#requests.values()) controller.abort();
		this.#requests.clear();
		this.#disposeView?.();
	}
}
