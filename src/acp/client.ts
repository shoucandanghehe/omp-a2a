import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const MAX_FRAME = 1024 * 1024;
const MAX_TEXT = 64 * 1024;
const MAX_PERMISSIONS = 8;
const MAX_TOOL_CALLS = 32;
const MAX_PERMISSION_DETAIL = 4_096;
const START_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 300_000;
const CANCEL_TIMEOUT_MS = 5_000;

export type AcpErrorKind =
	| "startup"
	| "transport"
	| "protocol"
	| "remote"
	| "timeout"
	| "busy"
	| "cancelled"
	| "closed";

export class AcpError extends Error {
	constructor(
		public readonly kind: AcpErrorKind,
		message: string,
		public readonly code?: number,
	) {
		super(message);
		this.name = "AcpError";
	}
}

type RpcId = string | number;
type JsonObject = Record<string, unknown>;
type PermissionKind =
	| "allow_once"
	| "allow_always"
	| "reject_once"
	| "reject_always";

export type AcpPermission = {
	readonly title: string;
	readonly detail?: string;
	readonly options: readonly {
		readonly id: string;
		readonly name: string;
		readonly kind: PermissionKind;
	}[];
};

export type AcpClientOptions = {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly requestPermission?: (
		permission: AcpPermission,
		signal: AbortSignal,
	) => Promise<string | undefined>;
};

type Pending = {
	readonly method: string;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: AcpError) => void;
};

type ToolCall = {
	readonly title?: string;
	readonly name?: string;
	readonly kind?: string;
	readonly rawInput?: string | null;
	readonly locations?: string | null;
	readonly content?: string | null;
	readonly terminal: boolean;
};

type Turn = {
	readonly chunks: string[];
	readonly requests: Map<RpcId, AbortController>;
	readonly toolCalls: Map<string, ToolCall>;
	bytes: number;
	cancelled: boolean;
	cancelTimer?: ReturnType<typeof setTimeout>;
};

function object(value: unknown): JsonObject | undefined {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		// The object is intentionally narrowed only to unknown properties.
		return { ...value };
	}
}

function toolCallId(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0 && value.length <= 128) {
		return value;
	}
}

function boundedDetail(value: unknown): string | null | undefined {
	if (
		(typeof value === "string" && value.trim().length > 0) ||
		(Array.isArray(value) && value.length > 0) ||
		(value !== null &&
			typeof value === "object" &&
			Object.keys(value).length > 0)
	) {
		const serialized = JSON.stringify(value).replace(
			/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu,
			(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
		return Buffer.byteLength(serialized) <= MAX_PERMISSION_DETAIL
			? serialized
			: null;
	}
}

function mergeToolCall(
	previous: ToolCall | undefined,
	update: JsonObject,
): ToolCall {
	return {
		title:
			"title" in update
				? label(update.title, "ACP tool permission")
				: previous?.title,
		name:
			typeof update.name === "string" ? label(update.name, "") : previous?.name,
		kind: "kind" in update ? label(update.kind, "other") : previous?.kind,
		rawInput:
			update.rawInput != null
				? boundedDetail(update.rawInput)
				: previous?.rawInput,
		locations:
			"locations" in update
				? boundedDetail(update.locations)
				: previous?.locations,
		// A file diff can identify an edit when the agent supplied no raw input.
		content:
			"content" in update
				? boundedDetail(
						Array.isArray(update.content)
							? update.content.filter((entry: unknown) => {
									const diff = object(entry);
									return (
										diff?.type === "diff" &&
										typeof diff.path === "string" &&
										diff.path.length > 0 &&
										typeof diff.newText === "string" &&
										(diff.oldText === null || typeof diff.oldText === "string")
									);
								})
							: undefined,
					)
				: previous?.content,
		terminal:
			previous?.terminal === true ||
			update.status === "completed" ||
			update.status === "failed",
	};
}

function operationDetail(call: ToolCall): string | undefined {
	if (
		call.terminal ||
		call.rawInput === null ||
		call.content === null ||
		call.locations === null ||
		(!call.rawInput && !call.content)
	)
		return undefined;
	const detail = [
		call.name && `Tool: ${call.name}`,
		call.kind && `Operation: ${call.kind}`,
		call.rawInput && `Input: ${call.rawInput}`,
		call.locations && `Locations: ${call.locations}`,
		call.content && `Edits: ${call.content}`,
	]
		.filter(Boolean)
		.join("\n");
	if (Buffer.byteLength(detail) <= MAX_PERMISSION_DETAIL) return detail;
}

function permissionKind(value: unknown): value is PermissionKind {
	return (
		value === "allow_once" ||
		value === "allow_always" ||
		value === "reject_once" ||
		value === "reject_always"
	);
}

function label(value: unknown, fallback: string): string {
	return typeof value === "string"
		? value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ").slice(0, 160)
		: fallback;
}

const CANCELLED_PERMISSION = { outcome: { outcome: "cancelled" } };

/** A single bridge-owned ACP v1 session on a locally configured subprocess. */
export class AcpClient {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<number, Pending>();
	readonly #exit: Promise<void>;
	readonly #termination = Promise.withResolvers<AcpError>();
	/** Resolves once the transport becomes unusable, including an explicit close. */
	readonly terminated = this.#termination.promise;
	readonly #frame = Buffer.alloc(MAX_FRAME);
	#fragmentBytes = 0;
	#nextId = 0;
	#sessionId = "";
	#turn: Turn | undefined;
	#failure: AcpError | undefined;
	#closing: Promise<void> | undefined;

	private constructor(private readonly options: AcpClientOptions) {
		this.#child = spawn(options.command, [...options.args], {
			cwd: options.cwd,
			shell: false,
		});
		this.#exit = new Promise((resolve) =>
			this.#child.once("close", () => resolve()),
		);
		this.#child.on("error", () =>
			this.#fail(new AcpError("startup", "Could not start ACP subprocess.")),
		);
		this.#child.once("exit", () =>
			this.#fail(new AcpError("transport", "ACP subprocess exited.")),
		);
		this.#child.stdout.on("end", () =>
			this.#fail(new AcpError("transport", "ACP stdout closed.")),
		);
		this.#child.stdout.on("error", () =>
			this.#fail(new AcpError("transport", "ACP stdout failed.")),
		);
		this.#child.stdin.on("error", () =>
			this.#fail(new AcpError("transport", "ACP stdin failed.")),
		);
		this.#child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
		// Never route agent diagnostics back to an A2A peer.
		this.#child.stderr.resume();
	}

	static async start(options: AcpClientOptions): Promise<AcpClient> {
		if (options.command.trim().length === 0 || !isAbsolute(options.cwd)) {
			throw new AcpError(
				"startup",
				"ACP requires a local command and an absolute working directory.",
			);
		}
		let client: AcpClient;
		try {
			client = new AcpClient(options);
		} catch {
			throw new AcpError("startup", "Could not start ACP subprocess.");
		}
		try {
			const init = object(
				await client.#call(
					"initialize",
					{
						protocolVersion: 1,
						clientCapabilities: {},
						clientInfo: { name: "omp-a2a", version: "0.1.0" },
					},
					START_TIMEOUT_MS,
				),
			);
			if (init?.protocolVersion !== 1) {
				throw new AcpError(
					"protocol",
					"ACP subprocess did not negotiate protocol version 1.",
				);
			}
			const session = object(
				await client.#call(
					"session/new",
					{
						cwd: options.cwd,
						mcpServers: [],
					},
					START_TIMEOUT_MS,
				),
			);
			if (
				typeof session?.sessionId !== "string" ||
				session.sessionId.length === 0
			) {
				throw new AcpError(
					"protocol",
					"ACP did not return a valid session ID.",
				);
			}
			client.#sessionId = session.sessionId;
			return client;
		} catch (error) {
			await client.close();
			throw error;
		}
	}

	async prompt(
		text: string,
		signal?: AbortSignal,
	): Promise<{ readonly text: string; readonly stopReason: string }> {
		if (this.#failure) throw this.#failure;
		if (this.#turn)
			throw new AcpError("busy", "An ACP prompt is already running.");
		if (signal?.aborted)
			throw new AcpError("cancelled", "ACP prompt was cancelled.");
		if (text.length === 0 || Buffer.byteLength(text) > MAX_TEXT) {
			throw new AcpError("protocol", "ACP prompt is empty or too large.");
		}

		const turn: Turn = {
			chunks: [],
			bytes: 0,
			requests: new Map(),
			toolCalls: new Map(),
			cancelled: false,
		};
		this.#turn = turn;
		const abort = () => this.cancel();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const result = object(
				await this.#call(
					"session/prompt",
					{
						sessionId: this.#sessionId,
						prompt: [{ type: "text", text }],
					},
					PROMPT_TIMEOUT_MS,
				),
			);
			if (turn.cancelled || result?.stopReason === "cancelled") {
				throw new AcpError("cancelled", "ACP prompt was cancelled.");
			}
			if (typeof result?.stopReason !== "string") {
				const error = new AcpError(
					"protocol",
					"ACP prompt did not return a stop reason.",
				);
				this.#fail(error);
				throw error;
			}
			return { text: turn.chunks.join(""), stopReason: result.stopReason };
		} finally {
			signal?.removeEventListener("abort", abort);
			if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
			this.#cancelPermissions(turn);
			this.#turn = undefined;
		}
	}

	cancel(): void {
		const turn = this.#turn;
		if (!turn || turn.cancelled || this.#failure) return;
		turn.cancelled = true;
		this.#send({
			method: "session/cancel",
			params: { sessionId: this.#sessionId },
		});
		this.#cancelPermissions(turn);
		if (this.#failure) return;
		turn.cancelTimer = setTimeout(
			() =>
				this.#fail(
					new AcpError(
						"cancelled",
						"ACP subprocess did not finish cancellation.",
					),
				),
			CANCEL_TIMEOUT_MS,
		);
	}

	close(): Promise<void> {
		this.#closing ??= this.#close();
		return this.#closing;
	}

	async #close(): Promise<void> {
		this.cancel();
		this.#fail(new AcpError("closed", "ACP client closed."), false);
		const killTimer = setTimeout(() => this.#child.kill("SIGKILL"), 1_000);
		let doneTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.#exit,
				new Promise<void>((resolve) => {
					doneTimer = setTimeout(resolve, 2_000);
				}),
			]);
		} finally {
			clearTimeout(killTimer);
			if (doneTimer) clearTimeout(doneTimer);
		}
	}

	#fail(error: AcpError, kill = true): void {
		if (this.#failure) return;
		this.#failure = error;
		this.#termination.resolve(error);
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		if (this.#turn) this.#cancelPermissions(this.#turn);
		this.#child.stdin.end();
		if (kill) this.#child.kill("SIGKILL");
	}

	#call(
		method: string,
		params: JsonObject,
		timeoutMs: number,
	): Promise<unknown> {
		if (this.#failure) return Promise.reject(this.#failure);
		const id = ++this.#nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => this.#fail(new AcpError("timeout", `ACP ${method} timed out.`)),
				timeoutMs,
			);
			this.#pending.set(id, { method, resolve, reject, timer });
			this.#send({ id, method, params });
		});
	}

	#send(value: JsonObject): void {
		if (this.#failure) return;
		const line = `${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`;
		if (Buffer.byteLength(line) > MAX_FRAME) {
			this.#fail(
				new AcpError("protocol", "Outbound ACP frame exceeds the limit."),
			);
			return;
		}
		try {
			this.#child.stdin.write(line, (error) => {
				if (error)
					this.#fail(new AcpError("transport", "Could not write ACP frame."));
			});
		} catch {
			this.#fail(new AcpError("transport", "Could not write ACP frame."));
		}
	}

	#read(chunk: Buffer): void {
		let offset = 0;
		while (offset < chunk.length && !this.#failure) {
			const lf = chunk.indexOf(10, offset);
			const end = lf < 0 ? chunk.length : lf;
			const part = chunk.subarray(offset, end);
			if (this.#fragmentBytes + part.length > MAX_FRAME) {
				this.#fail(
					new AcpError("protocol", "Inbound ACP frame exceeds the limit."),
				);
				return;
			}
			this.#frame.set(part, this.#fragmentBytes);
			this.#fragmentBytes += part.length;
			if (lf < 0) return;
			const frame = this.#frame.toString("utf8", 0, this.#fragmentBytes);
			this.#fragmentBytes = 0;
			try {
				const parsed: unknown = JSON.parse(frame);
				const message = object(parsed);
				if (message?.jsonrpc !== "2.0") throw new Error("Invalid envelope");
				this.#receive(message);
			} catch {
				this.#fail(new AcpError("protocol", "Invalid ACP JSON-RPC frame."));
			}
			offset = lf + 1;
		}
	}

	#receive(message: JsonObject): void {
		const id = message.id;
		if (typeof message.method === "string") {
			const params = object(message.params);
			if (id === undefined) {
				if (message.method === "session/update") this.#update(params);
			} else if (
				typeof id === "string" ||
				(typeof id === "number" && Number.isFinite(id))
			) {
				if (message.method === "session/request_permission") {
					this.#requestPermission(id, params);
				} else {
					this.#send({
						id,
						error: { code: -32601, message: "Method not supported" },
					});
				}
			}
			return;
		}
		if (typeof id !== "number") return;
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		const error = object(message.error);
		if (error) {
			const code = typeof error.code === "number" ? error.code : undefined;
			pending.reject(
				new AcpError("remote", `ACP rejected ${pending.method}.`, code),
			);
		} else if ("result" in message) {
			pending.resolve(message.result);
		} else {
			const failure = new AcpError("protocol", "Invalid ACP response.");
			pending.reject(failure);
			this.#fail(failure);
		}
	}

	#update(params: JsonObject | undefined): void {
		const turn = this.#turn;
		if (!turn || turn.cancelled || params?.sessionId !== this.#sessionId)
			return;
		const update = object(params.update);
		if (
			update?.sessionUpdate === "tool_call" ||
			update?.sessionUpdate === "tool_call_update"
		) {
			const id = toolCallId(update.toolCallId);
			if (
				id &&
				(turn.toolCalls.has(id) || turn.toolCalls.size < MAX_TOOL_CALLS)
			) {
				turn.toolCalls.set(id, mergeToolCall(turn.toolCalls.get(id), update));
			}
			return;
		}
		if (update?.sessionUpdate !== "agent_message_chunk") return;
		const content = object(update.content);
		if (
			content?.type !== "text" ||
			typeof content.text !== "string" ||
			content.text.length === 0
		)
			return;
		turn.bytes += Buffer.byteLength(content.text);
		if (turn.bytes > MAX_TEXT) {
			this.#fail(
				new AcpError("protocol", "ACP response text exceeds the limit."),
			);
			return;
		}
		turn.chunks.push(content.text);
	}

	#cancelPermissions(turn: Turn): void {
		for (const [id, controller] of turn.requests) {
			controller.abort();
			this.#send({ id, result: CANCELLED_PERMISSION });
		}
		turn.requests.clear();
	}

	#requestPermission(id: RpcId, params: JsonObject | undefined): void {
		const turn = this.#turn;
		if (!turn || turn.cancelled || params?.sessionId !== this.#sessionId) {
			this.#send({ id, result: CANCELLED_PERMISSION });
			return;
		}
		if (turn.requests.has(id)) {
			this.#fail(
				new AcpError("protocol", "Duplicate ACP permission request ID."),
			);
			return;
		}
		if (
			turn.requests.size >= MAX_PERMISSIONS ||
			!Array.isArray(params.options) ||
			params.options.length > 16
		) {
			this.#send({
				id,
				error: { code: -32602, message: "Invalid permission request" },
			});
			return;
		}
		const options = params.options.flatMap((entry: unknown) => {
			const option = object(entry);
			if (
				typeof option?.optionId !== "string" ||
				option.optionId.length === 0 ||
				option.optionId.length > 128 ||
				!permissionKind(option.kind)
			) {
				return [];
			}
			return [
				{
					id: option.optionId,
					name: label(option.name, "Permission option"),
					kind: option.kind,
				},
			];
		});
		if (
			options.length !== params.options.length ||
			new Set(options.map((option) => option.id)).size !== options.length
		) {
			this.#send({
				id,
				error: { code: -32602, message: "Invalid permission options" },
			});
			return;
		}
		const reject = options.find((option) => option.kind === "reject_once");
		const callback = this.options.requestPermission;
		const controller = new AbortController();
		turn.requests.set(id, controller);
		const toolCall = object(params.toolCall);
		const callId = toolCallId(toolCall?.toolCallId);
		const call =
			callId &&
			toolCall &&
			(turn.toolCalls.has(callId) || turn.toolCalls.size < MAX_TOOL_CALLS)
				? mergeToolCall(turn.toolCalls.get(callId), toolCall)
				: undefined;
		// Record what was actually presented so any subsequent operation changes
		// can invalidate the pending decision, including updates to inline details.
		if (callId && call) turn.toolCalls.set(callId, call);
		const title = call?.title ?? "ACP tool permission";
		const detail = call && operationDetail(call);
		void Promise.resolve()
			.then(() => {
				if (!controller.signal.aborted && detail !== undefined) {
					const visibleOptions = options.map((option) => ({ ...option }));
					return callback?.(
						{ title, detail, options: visibleOptions },
						controller.signal,
					);
				}
			})
			.catch(() => undefined)
			.then((choice) => {
				if (
					!turn.requests.delete(id) ||
					this.#turn !== turn ||
					turn.cancelled ||
					this.#failure
				)
					return;
				// Persistent grants cannot be expressed through this adapter.
				const latest = callId && turn.toolCalls.get(callId);
				const current =
					detail !== undefined &&
					latest &&
					latest.title === call?.title &&
					operationDetail(latest) === detail;
				const selected =
					(current
						? options.find(
								(option) =>
									option.id === choice && option.kind === "allow_once",
							)
						: undefined) ?? reject;
				this.#send({
					id,
					result: selected
						? { outcome: { outcome: "selected", optionId: selected.id } }
						: CANCELLED_PERMISSION,
				});
			});
	}
}
