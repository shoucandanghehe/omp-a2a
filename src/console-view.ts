import type { Component, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import * as tui from "@oh-my-pi/pi-tui";
import type { A2aLanguage } from "./locale";
import {
	type A2aLocalConfig,
	type A2aRoom,
	AGENT_NAME_RE,
	ROOM_NAME_RE,
} from "./types";

// Older ANSI hosts omit the native builders. Only describe() uses them.
const { col, item, list, node, row, span, text } = tui;
const { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } =
	tui;
type TextInput = InstanceType<typeof Input>;

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
	createAndJoin: (room: string) => `Create and join ${room}…`,
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
	selectRoom: "Select a Room to see its details.",
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
	startupToggle: "Join at startup",
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
	position: (index: number, count: number) => ` (${index}/${count})`,
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
		createAndJoin: (room) => `创建并加入 ${room}…`,
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
		selectRoom: "选择房间以查看详情。",
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
		startupToggle: "启动时加入",
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
		position: (index, count) => `（${index}/${count}）`,
		keys: "Tab / Shift+Tab 切换 · ↑↓ 选择 · Enter 打开 · Esc 返回",
		formKeys: "Tab / Shift+Tab 切换 · Enter 确认 · Esc 取消",
		scroll: "PgUp / PgDn 滚动消息",
	},
} satisfies Record<A2aLanguage, typeof en>;

const HISTORY_LIMIT = 20;
const ANSI_DETAIL_LINES = 6;
const ANSI_NARROW_WIDTH = 68;

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

export class A2aConsole implements Component {
	readonly nativeOverlay = { role: "omp.overlay.a2a", size: "lg" } as const;
	readonly #options: ConsoleOptions;
	readonly #copy: typeof en;
	readonly #search = new Input();
	readonly #sender = new Input();
	readonly #name = new Input();
	readonly #hubInput = new Input();
	readonly #startupRoom = new Input();
	readonly #startupName = new Input();
	#project?: Settings;
	readonly #requests = new Map<Request, AbortController>();
	#focus = "search";
	#hubUrl?: string;
	#room?: string;
	#narrow = false;
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
		this.#search.placeholder = this.#copy.search;
		this.#search.prompt = `${this.#copy.search}: `;
		this.#sender.placeholder = this.#copy.sender;
		this.#sender.prompt = `${this.#copy.sender}: `;
		this.#hubInput.placeholder = this.#copy.project.hub;
		this.#startupRoom.placeholder = this.#copy.roomName;
		this.#startupName.placeholder = this.#copy.rosterName;
		for (const input of [this.#hubInput, this.#startupRoom, this.#startupName])
			input.prompt = `${input.placeholder}: `;
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
			if (!this.#project) this.#focus = "search";
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
				this.#options.redraw();
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
		this.#name.placeholder =
			form.kind === "join" ? this.#copy.rosterName : this.#copy.roomName;
		this.#name.prompt = `${this.#name.placeholder}: `;
		this.#name.setValue(
			form.kind === "join" && !form.create
				? (this.#startup(snapshot)?.name ?? "")
				: "",
		);
		// Deletion confirmation starts on Cancel, never on the destructive button.
		this.#focus = form.kind === "delete" ? "cancel" : "name";
	}

	#dismissForm(): void {
		this.#focus = this.#form?.kind ?? "room-list";
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
			{ id: "refresh", label: this.#copy.refresh },
			...(snapshot.hubUrl && !this.#requests.has("mutation")
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
		if (this.#project) return this.#settingsControls(this.#project);
		if (this.#form) return this.#formControls();
		const controls =
			narrow && this.#detailOpen
				? []
				: [
						...this.#headerControls(snapshot),
						{ id: "settings", label: this.#copy.settings },
					];
		if (!(narrow && !this.#detailOpen)) {
			if (narrow && !this.#showHistory)
				controls.push({ id: "back-list", label: this.#copy.backList });
			if (this.#showHistory) controls.push(...this.#historyControls());
			else if (!this.#requests.has("mutation"))
				controls.push(...this.#roomControls(snapshot));
		}
		return controls;
	}

	#run(control: Control, snapshot: Snapshot): void {
		if (this.#project) {
			this.#runSettings(this.#project, control.id);
			this.#options.redraw();
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
		this.#options.redraw();
	}

	#input(field: string): TextInput | undefined {
		switch (field) {
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

	#focusStops(
		snapshot: Snapshot,
		controls: Control[],
		narrow = this.#narrow,
	): string[] {
		if (this.#project) {
			const fields = this.#settingsFields(this.#project).map(([id]) => id);
			const entries = this.#settingsList(this.#project);
			return [
				...fields,
				...(entries?.rows.length ? [entries.id] : []),
				...controls.map(({ id }) => id),
			];
		}
		if (this.#form) {
			return [
				...(this.#form.kind !== "delete" && !this.#requests.has("mutation")
					? ["name"]
					: []),
				...controls.map(({ id }) => id),
			];
		}
		const showList = !narrow || !this.#detailOpen;
		return [
			...(showList && snapshot.hubUrl
				? [
						"search",
						...(this.#visibleRooms(snapshot).length ? ["room-list"] : []),
					]
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

	#enterRoom(): void {
		if (!this.#room) return;
		this.#detailOpen = true;
		this.#focus = this.#showHistory
			? "sender"
			: this.#tracked(this.#options.snapshot())
				? "history"
				: "join";
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		const snapshot = this.#snapshot();
		const controls = this.#controls(snapshot, this.#narrow);
		const run = (id: string) => {
			const control = controls.find((control) => control.id === id);
			if (control) this.#run(control, snapshot);
		};
		if (matchesKey(data, "escape")) {
			if (this.#project) run("cfg-back");
			else if (this.#form) run("cancel");
			else if (this.#showHistory) run("back-room");
			else if (this.#narrow && this.#detailOpen) run("back-list");
			else this.#close();
			return;
		}
		const stops = this.#focusStops(snapshot, controls);
		const current = stops.indexOf(this.#focus);
		const focus = stops[current] ?? stops[0];
		if (!focus) return;
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			const delta = matchesKey(data, "tab") ? 1 : -1;
			this.#focus =
				current === -1
					? ((delta === 1 ? stops[0] : stops.at(-1)) ?? focus)
					: (stops[(current + delta + stops.length) % stops.length] ?? focus);
		} else if (matchesKey(data, "enter")) {
			if (focus === "search" || focus === "room-list") this.#enterRoom();
			else if (focus === "sender") run("filter");
			else if (focus === "name") run("confirm");
			else if (focus === "message-list") run("attachments");
			else if (this.#project) {
				if (focus === "cfg-hub") this.#focus = "cfg-auto";
				else if (focus === "cfg-room") this.#focus = "cfg-name";
				else if (focus === "cfg-name") run("cfg-apply");
				else if (focus === "cfg-rooms" || focus === "cfg-choices")
					this.#runSettings(this.#project, focus);
				else run(focus);
			} else run(focus);
		} else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const delta = matchesKey(data, "up") ? -1 : 1;
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
				if (room) this.#selectRoom(room);
				this.#focus = "room-list";
			} else if (focus === "sender" || focus === "message-list") {
				const messages = this.#historyPage?.messages ?? [];
				const index = this.#message ? messages.indexOf(this.#message) : -1;
				const message =
					messages[Math.min(messages.length - 1, Math.max(0, index + delta))];
				if (message) this.#selectMessage(message);
				this.#focus = "message-list";
			} else if (!this.#input(focus)) {
				this.#focus =
					stops[(stops.indexOf(focus) + delta + stops.length) % stops.length] ??
					focus;
			}
		} else if (
			!this.#project &&
			!this.#form &&
			this.#room &&
			(matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))
		) {
			const delta = matchesKey(data, "pageUp")
				? -ANSI_DETAIL_LINES
				: ANSI_DETAIL_LINES;
			this.#detailOffset = Math.max(
				0,
				Math.min(
					this.#detailOffset + delta,
					this.#detailLineCount - ANSI_DETAIL_LINES,
				),
			);
		} else {
			const field =
				snapshot.hubUrl &&
				!this.#project &&
				!this.#form &&
				!this.#showHistory &&
				tui.isNativeRendering?.()
					? "search"
					: focus;
			const input = this.#input(field);
			if (!input) return;
			input.handleInput(data);
			this.#edited(field, snapshot);
		}
		this.#options.redraw();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed) return;
		const snapshot = this.#snapshot();
		const key = event.key.slice(event.key.lastIndexOf("/") + 1);
		if (event.type === "edit" || event.type === "undo") {
			if (
				key === "search-input" &&
				!this.#project &&
				!this.#form &&
				!this.#showHistory
			)
				this.#focus = "search";
			if (key !== `${this.#focus}-input`) return;
			this.#input(this.#focus)?.handleNativeEvent(event);
			this.#edited(this.#focus, snapshot);
		} else if (
			(event.type === "select" || event.type === "activate") &&
			!this.#form
		) {
			if (this.#project) {
				const entries = this.#settingsList(this.#project);
				if (!entries || key !== entries.id) return;
				const index = entries.rows.findIndex(({ room }) => room === event.item);
				if (index === -1) return;
				if (entries.id === "cfg-rooms") this.#project.roomIndex = index;
				else this.#project.choiceIndex = index;
				this.#runSettings(this.#project, entries.id);
				this.#options.redraw();
				return;
			}
			const { tracked, discovered } = this.#roomGroups(snapshot);
			if (
				(key === "tracked-list" && tracked.includes(event.item)) ||
				(key === "discovered-list" && discovered.includes(event.item))
			) {
				this.#selectRoom(event.item);
				this.#focus = this.#showHistory ? "sender" : "search";
				if (
					event.type === "activate" &&
					key === "discovered-list" &&
					!this.#requests.has("mutation")
				)
					this.#openForm({ kind: "join", room: event.item }, snapshot);
			} else if (key === "message-list" && this.#showHistory) {
				const message = this.#historyPage?.messages.find(
					({ ref }) => ref === event.item,
				);
				if (message) this.#selectMessage(message);
				this.#focus = "message-list";
			} else return;
		} else if (event.type === "action") {
			if (event.act === "close" && key === "close") {
				this.#close();
				return;
			}
			if (this.#project && event.act === "cfg-close" && key === "cfg-close") {
				if (this.#requests.has("settings-save")) return;
				this.#cancel("startup-browse");
				this.#project = undefined;
				this.#focus = this.#showHistory ? "sender" : "search";
				this.#options.redraw();
				return;
			}
			if (!this.#form && !this.#project && !this.#requests.has("mutation")) {
				if (
					event.act === "create-join" &&
					event.value &&
					event.value === this.#createCandidate(snapshot)
				) {
					this.#openForm(
						{ kind: "join", room: event.value, create: true },
						snapshot,
					);
					this.#options.redraw();
					return;
				}
				if (
					event.act === "delete" &&
					event.value &&
					key === event.value &&
					this.#roomGroups(snapshot).discovered.includes(event.value)
				) {
					this.#selectRoom(event.value);
					this.#openForm({ kind: "delete", room: event.value }, snapshot);
					this.#options.redraw();
					return;
				}
			}
			const control = this.#controls(snapshot, false).find(
				({ id, value }) => id === event.act && value === event.value,
			);
			if (control) {
				this.#run(control, snapshot);
				return;
			}
			if (
				event.act !== "focus" ||
				!event.value ||
				!this.#input(event.value) ||
				!this.#focusStops(
					snapshot,
					this.#controls(snapshot, false),
					false,
				).includes(event.value)
			)
				return;
			this.#focus = event.value;
		} else return;
		this.#options.redraw();
	}

	#button(
		{ id, label, value, tone }: Control,
		fullRow = false,
		face = label,
	): NativeNode {
		return node(
			"row",
			{
				role: "omp.btn",
				gap: "xs",
				align: "center",
				...(fullRow ? { min: { w: 1 }, justify: "between" as const } : {}),
				actions: { click: value === undefined ? id : `${id}=${value}` },
				title: label,
				aria: label,
				tone: this.#focus === id && tone !== "error" ? "accent" : tone,
			},
			[text(face), ...(fullRow ? [text([span("›", "muted")])] : [])],
			value === undefined || id !== "focus" ? id : `focus-${value}`,
		);
	}

	#describeInput(
		field: string,
		input: TextInput,
		suspended = false,
	): NativeNode {
		if (suspended)
			return text([span(input.getValue() || input.placeholder || "", "muted")]);
		// The host focuses the first native input in a component. Room search is
		// the only input on its page; the startup editor can switch between two.
		if (field !== "search" && this.#focus !== field)
			return this.#button({
				id: "focus",
				value: field,
				label: input.getValue()
					? `${input.prompt}${literal(input.getValue())}`
					: (input.placeholder ?? ""),
			});
		return node(
			"input",
			{
				role: "omp.a2a.input",
				text: input.getValue(),
				cursor: input.getCursor(),
				placeholder: input.placeholder,
				grow: 1,
			},
			undefined,
			`${field}-input`,
		);
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

	#describeHistory(): NativeNode[] {
		const [back, ...controls] = this.#historyControls();
		const messages = this.#historyPage?.messages ?? [];
		const notice = this.#historyNotice();
		const message = this.#message;
		return [
			...(back && this.#room
				? [this.#button(back, false, `‹ ${literal(this.#room)}`)]
				: []),
			text([span(this.#copy.history, "strong")]),
			row(
				[
					...(!this.#form ? [this.#describeInput("sender", this.#sender)] : []),
					...controls.map((control) => this.#button(control)),
				],
				{ gap: "sm", wrap: true },
			),
			...(notice ? [text(notice, { wrap: "word" })] : []),
			...(messages.length
				? [
						list(
							messages.map(({ ref, from }) =>
								item(ref, { label: literal(from), detail: literal(ref) }),
							),
							{
								selected: message?.ref,
								max: { lines: 5 },
								actions: { click: "select" },
							},
							"message-list",
						),
					]
				: []),
			...(message
				? [
						node(
							"section",
							{ head: `${literal(message.ref)} · ${literal(message.from)}` },
							this.#messageLines(message).map((line) =>
								text(line, { wrap: "word", actions: { menu: ["copy"] } }),
							),
							"message",
						),
					]
				: []),
		];
	}

	#describeForm(): NativeNode | undefined {
		const form = this.#form;
		if (!form) return;
		const copy = this.#copy;
		const label =
			form.kind === "create"
				? copy.confirmCreate
				: form.kind === "join"
					? `${form.create ? copy.confirmCreateAndJoin : copy.confirmJoin} · ${literal(form.room)}`
					: copy.confirmDeletion(literal(form.room));
		const busy = this.#requests.has("mutation");
		return col(
			[
				text([span(label, form.kind === "delete" ? "error" : "strong")], {
					wrap: "word",
				}),
				...(!busy && form.kind !== "delete"
					? [this.#describeInput("name", this.#name)]
					: []),
				...(busy ? [node("spinner", { label: copy.working })] : []),
				...(this.#formError
					? [text([span(this.#formError, "error")], { wrap: "word" })]
					: []),
				row(
					this.#formControls().map((control) => this.#button(control)),
					{ gap: "sm", wrap: true },
				),
			],
			{ gap: "xs" },
		);
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

	#settingsFields(settings: Settings): [string, TextInput][] {
		if (this.#requests.has("settings-save")) return [];
		if (settings.level === "project") return [["cfg-hub", this.#hubInput]];
		if (settings.level === "room")
			return [
				["cfg-room", this.#startupRoom],
				["cfg-name", this.#startupName],
			];
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

	#describeSettings(settings: Settings): NativeNode[] {
		const copy = this.#copy;
		const entries = this.#settingsList(settings);
		return [
			row(
				[
					text([span(this.#settingsHeading(settings), "strong")], {
						grow: 1,
						wrap: "word",
					}),
					...(!this.#requests.has("settings-save")
						? [this.#button({ id: "cfg-close", label: copy.close }, false, "×")]
						: []),
				],
				{ align: "center", gap: "sm" },
			),
			...(settings.level === "project"
				? [
						text(copy.project.note, { wrap: "word" }),
						text(copy.project.inherit(settings.inheritedHub), { wrap: "word" }),
					]
				: []),
			...this.#settingsFields(settings).flatMap(([id, input]) =>
				this.#focus === id
					? [text(input.placeholder ?? ""), this.#describeInput(id, input)]
					: [this.#describeInput(id, input)],
			),
			...(entries?.rows.length
				? [
						list(
							entries.rows.map(({ room, name }) =>
								item(room, {
									label: literal(room),
									detail: name ? literal(name) : undefined,
								}),
							),
							{
								selected: entries.rows[entries.index]?.room,
								max: { lines: 6 },
								actions: { click: "select" },
							},
							entries.id,
						),
					]
				: entries
					? [text(entries.empty)]
					: []),
			...(settings.error
				? [text([span(settings.error, "error")], { wrap: "word" })]
				: []),
			...(this.#requests.has("settings-save")
				? [node("spinner", { label: copy.working })]
				: []),
			...(this.#requests.has("startup-browse")
				? [node("spinner", { label: copy.loadingRooms })]
				: []),
			row(
				this.#settingsControls(settings).map((control) =>
					this.#button(control),
				),
				{ gap: "sm", wrap: true },
			),
		];
	}

	describe(): NativeNode {
		const copy = this.#copy;
		const snapshot = this.#snapshot();
		const groups = this.#roomGroups(snapshot);
		const tracked = this.#tracked(snapshot);
		const empty = this.#emptyRoomList(snapshot);
		const form = this.#describeForm();
		const globalFeedback = this.#feedbackFor();
		const roomFeedback = this.#room ? this.#feedbackFor(this.#room) : undefined;
		const candidate = this.#createCandidate(snapshot);
		const members = this.#members(tracked);
		const memberEmpty =
			tracked?.state === "connected" ? copy.noMembers : copy.joinForMembers;
		const browsing = !this.#form && !this.#project;
		const master = col(
			[
				...(snapshot.hubUrl
					? [
							this.#describeInput(
								"search",
								this.#search,
								!browsing || this.#showHistory,
							),
						]
					: [text(copy.hubUnconfigured, { wrap: "word" })]),
				...(["tracked", "discovered"] as const).flatMap((group) =>
					groups[group].length
						? [
								text([span(copy[group], "muted")]),
								list(
									groups[group].map((name) => {
										const room = snapshot.rooms.find(
											({ room }) => room === name,
										);
										const menu =
											browsing &&
											group === "discovered" &&
											!this.#requests.has("mutation")
												? [
														{
															id: `delete=${name}`,
															label: copy.delete,
															danger: true,
														},
													]
												: undefined;
										return item(name, {
											label: literal(name),
											value: room
												? room.self && room.state === "connected"
													? literal(room.self)
													: this.#status(room)
												: undefined,
											// @ts-expect-error The 18.8 SDK predates the host's labeled menu entries.
											actions: menu && { menu },
										});
									}),
									{
										selected:
											this.#room && groups[group].includes(this.#room)
												? this.#room
												: undefined,
										max: { lines: 6 },
										actions: browsing
											? {
													click: "select",
													...(group === "discovered"
														? { dblclick: "activate" }
														: {}),
												}
											: undefined,
									},
									`${group}-list`,
								),
							]
						: [],
				),
				...(browsing && snapshot.hubUrl && this.#listError !== undefined
					? [
							text([span(copy.listError(this.#listError), "error")], {
								wrap: "word",
							}),
							this.#button({ id: "refresh", label: copy.retry }),
						]
					: empty && !candidate
						? [text(empty, { wrap: "word" })]
						: []),
				...(browsing && candidate
					? [
							this.#button(
								{
									id: "create-join",
									label: copy.createAndJoin(literal(candidate)),
									value: candidate,
									tone: "accent",
								},
								true,
							),
						]
					: []),
				node("rule"),
				this.#project || !browsing
					? text([span(copy.settings, "muted")])
					: this.#button(
							{
								id: "settings",
								label: snapshot.hubUrl ? copy.settings : copy.configureHub,
							},
							true,
						),
			],
			{ basis: 0.3, min: { w: "20ch" }, gap: "xs" },
		);
		const roomControls =
			this.#form || this.#showHistory || this.#requests.has("mutation")
				? []
				: this.#roomControls(snapshot);
		const overview = [
			...(snapshot.startupHubUrl && this.#startupMismatch(snapshot)
				? [
						text(copy.startupHub(literal(snapshot.startupHubUrl)), {
							wrap: "word",
						}),
					]
				: this.#startup(snapshot)
					? [text(this.#startupLabel(snapshot), { wrap: "word" })]
					: []),
			text([
				span(copy.members, "strong"),
				...(members.length ? [span(`  ${members.length}`, "muted")] : []),
			]),
			list(
				members.map((name) => item(name, { label: name })),
				{ max: { lines: 6 }, empty: memberEmpty },
				"members-list",
			),
			...roomControls
				.filter(({ id }) => id === "history")
				.map((control) => this.#button(control, true)),
		];
		const detail = this.#project
			? this.#describeSettings(this.#project)
			: this.#showHistory
				? this.#describeHistory()
				: this.#room
					? [
							row(
								[
									text([span(literal(this.#room), "strong")]),
									node("badge", {
										text: this.#status(tracked),
										tone:
											tracked?.state === "connected"
												? "success"
												: tracked
													? "pending"
													: "muted",
									}),
									node("spacer", { grow: 1 }),
									...roomControls
										.filter(
											({ id }) =>
												id === "add-startup" || id === "remove-startup",
										)
										.map((control) =>
											this.#button(
												control,
												false,
												`${control.id === "remove-startup" ? "✓ " : ""}${copy.startupToggle}`,
											),
										),
									...roomControls
										.filter(({ id }) => id === "join" || id === "leave")
										.map((control) => this.#button(control)),
								],
								{ gap: "sm", wrap: true },
							),
							...(tracked?.state === "connected" && tracked.self
								? [
										text([
											span(copy.currentName(literal(tracked.self)), "muted"),
										]),
									]
								: []),
							...(roomFeedback
								? [
										text(
											[
												span(
													roomFeedback.text,
													roomFeedback.error ? "error" : "success",
												),
											],
											{ wrap: "word" },
										),
									]
								: []),
							...(this.#requests.has("mutation") && !this.#form
								? [node("spinner", { label: copy.working })]
								: []),
							...(form && this.#form?.kind !== "create" ? [form] : []),
							...(!form ? overview : []),
						]
					: form && this.#form?.kind !== "create"
						? [form]
						: snapshot.hubUrl && !empty
							? [text(copy.selectRoom, { wrap: "word" })]
							: [];
		return col(
			[
				row(
					[
						text([span("A2A", "strong")]),
						...(snapshot.hubUrl
							? [
									text([span(literal(snapshot.hubUrl), "muted")]),
									...(this.#requests.has("list")
										? [node("spinner", { label: copy.loadingRooms })]
										: [
												node("badge", {
													text:
														this.#listError === undefined
															? copy.hubOnline
															: copy.hubUnavailable,
													tone:
														this.#listError === undefined ? "success" : "error",
												}),
											]),
								]
							: []),
						node("spacer", { grow: 1 }),
						this.#button({ id: "close", label: copy.close }, false, "×"),
					],
					{ gap: "sm", align: "center", wrap: true },
				),
				...(globalFeedback && !this.#project
					? [
							text(
								[
									span(
										globalFeedback.text,
										globalFeedback.error ? "error" : "success",
									),
								],
								{ wrap: "word" },
							),
						]
					: []),
				...(form && this.#form?.kind === "create" ? [form] : []),
				node("rule"),
				row(
					[
						master,
						...(detail.length
							? [
									col(detail, {
										min: { w: "30ch" },
										grow: 1,
										basis: 0.55,
										gap: "sm",
										align: "stretch",
									}),
								]
							: []),
					],
					{ align: "start", gap: "lg", wrap: true },
				),
			],
			{ gap: "sm" },
		);
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#narrow = width < ANSI_NARROW_WIDTH;
		const copy = this.#copy;
		const snapshot = this.#snapshot();
		const controls = this.#controls(snapshot, this.#narrow);
		const stops = this.#focusStops(snapshot, controls);
		const focus = stops.includes(this.#focus) ? this.#focus : stops[0];
		const lines = [copy.title];
		const wrap = (line: string) => lines.push(...wrapTextWithAnsi(line, width));
		for (const line of this.#hubLines(snapshot)) wrap(line);
		const buttons = (entries: Control[]) => {
			if (entries.length)
				wrap(
					entries
						.map(({ id, label }) =>
							id === focus ? `[› ${label}]` : `[${label}]`,
						)
						.join("  "),
				);
		};
		const field = (id: string, input: TextInput) => {
			input.focused = focus === id;
			if (input.focused) lines.push(...input.render(width));
			else wrap(`${input.prompt}${literal(input.getValue())}`);
		};
		if (this.#project) {
			const settings = this.#project;
			wrap(this.#settingsHeading(settings));
			if (settings.level === "project") {
				wrap(copy.project.note);
				wrap(copy.project.inherit(settings.inheritedHub));
			}
			for (const [id, input] of this.#settingsFields(settings))
				field(id, input);
			const entries = this.#settingsList(settings);
			if (entries?.rows.length) {
				const start = Math.max(
					0,
					Math.min(entries.index - 1, entries.rows.length - 4),
				);
				for (const { room, name } of entries.rows.slice(start, start + 4)) {
					const marker =
						entries.rows[entries.index]?.room === room ? "› " : "  ";
					wrap(`${marker}${literal(room)}${name ? ` · ${literal(name)}` : ""}`);
				}
			} else if (entries) wrap(entries.empty);
			if (settings.error) wrap(settings.error);
			if (this.#requests.has("settings-save")) wrap(copy.working);
			if (this.#requests.has("startup-browse")) wrap(copy.loadingRooms);
			buttons(controls);
			wrap(copy.keys);
			return lines.map((line) => truncateToWidth(line, width));
		}
		const globalFeedback = this.#feedbackFor();
		if (this.#listError !== undefined) wrap(copy.listError(this.#listError));
		if (globalFeedback) wrap(globalFeedback.text);
		if (this.#form) {
			const form = this.#form;
			if (form.kind === "delete")
				wrap(copy.confirmDeletion(literal(form.room)));
			else {
				wrap(
					form.kind === "join"
						? `${copy.confirmJoin} · ${literal(form.room)}`
						: copy.confirmCreate,
				);
				if (!this.#requests.has("mutation")) field("name", this.#name);
			}
			if (this.#requests.has("mutation")) wrap(copy.working);
			if (this.#formError) wrap(this.#formError);
			buttons(controls);
			wrap(copy.formKeys);
			return lines.map((line) => truncateToWidth(line, width));
		}
		if (!this.#narrow || !this.#detailOpen) {
			buttons(this.#headerControls(snapshot));
			if (snapshot.hubUrl) field("search", this.#search);
			const groups = this.#roomGroups(snapshot);
			for (const group of ["tracked", "discovered"] as const) {
				const names = groups[group];
				if (!names.length) continue;
				lines.push(`${focus === "room-list" ? "› " : ""}${copy[group]}`);
				const first = Math.max(0, names.indexOf(this.#room ?? "") - 1);
				for (const name of names.slice(first, first + 3))
					lines.push(
						`${name === this.#room ? ">" : " "} ${literal(name)} · ${this.#status(snapshot.rooms.find(({ room }) => room === name))}`,
					);
			}
			const empty = this.#emptyRoomList(snapshot);
			if (empty) wrap(empty);
			buttons(controls.filter(({ id }) => id === "settings"));
		} else buttons(controls.filter(({ id }) => id === "back-list"));
		if (this.#room && (!this.#narrow || this.#detailOpen)) {
			const tracked = this.#tracked(snapshot);
			wrap(
				`${literal(this.#room)} · ${this.#showHistory ? copy.history : this.#status(tracked)}`,
			);
			const feedback = this.#feedbackFor(this.#room);
			if (feedback) wrap(feedback.text);
			if (this.#showHistory) {
				field("sender", this.#sender);
				buttons(this.#historyControls());
				const notice = this.#historyNotice();
				if (notice) wrap(notice);
				if (this.#message) {
					const messages = this.#historyPage?.messages ?? [];
					wrap(
						`${focus === "message-list" ? "› " : ""}${literal(this.#message.ref)} · ${literal(this.#message.from)}${copy.position(messages.indexOf(this.#message) + 1, messages.length)}`,
					);
					const body = this.#messageLines(this.#message).flatMap((line) =>
						wrapTextWithAnsi(line, width),
					);
					this.#detailLineCount = body.length;
					lines.push(
						...body.slice(
							this.#detailOffset,
							this.#detailOffset + ANSI_DETAIL_LINES,
						),
					);
					if (body.length > ANSI_DETAIL_LINES) wrap(copy.scroll);
				}
			} else {
				if (this.#requests.has("mutation")) wrap(copy.working);
				const roomControls = this.#requests.has("mutation")
					? []
					: this.#roomControls(snapshot);
				buttons(
					roomControls.filter(({ id }) => id === "join" || id === "leave"),
				);
				wrap(this.#startupLabel(snapshot));
				buttons(
					roomControls.filter(
						({ id }) => id === "add-startup" || id === "remove-startup",
					),
				);
				if (
					!this.#startupMismatch(snapshot) &&
					!this.#startup(snapshot) &&
					!tracked?.self
				)
					wrap(copy.startupNeedsName);
				const members = this.#members(tracked);
				wrap(
					members.length ? `${copy.members} · ${members.length}` : copy.members,
				);
				const roster = (
					members.length
						? members
						: [
								tracked?.state === "connected"
									? copy.noMembers
									: copy.joinForMembers,
							]
				).flatMap((name) => wrapTextWithAnsi(name, width));
				this.#detailLineCount = roster.length;
				const offset = Math.min(
					this.#detailOffset,
					Math.max(0, roster.length - ANSI_DETAIL_LINES),
				);
				lines.push(...roster.slice(offset, offset + ANSI_DETAIL_LINES));
				if (roster.length > ANSI_DETAIL_LINES) wrap(copy.membersScroll);
				if (roomControls.some(({ id }) => id === "history")) {
					const label = truncateToWidth(
						focus === "history" ? `› ${copy.history}` : copy.history,
						Math.max(0, width - 1),
					);
					lines.push(
						`${label}${" ".repeat(Math.max(0, width - visibleWidth(label) - 1))}›`,
					);
				}
				buttons(roomControls.filter(({ id }) => id === "delete"));
			}
		}
		wrap(copy.keys);
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.#search.invalidate();
		this.#sender.invalidate();
		this.#name.invalidate();
		this.#hubInput.invalidate();
		this.#startupRoom.invalidate();
		this.#startupName.invalidate();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const controller of this.#requests.values()) controller.abort();
		this.#requests.clear();
	}
}
