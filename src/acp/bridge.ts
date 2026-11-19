import { HubClient } from "../hub/client";
import { A2aRuntime, type MessageView } from "../operations";

type Accepted = { message: MessageView; signal: AbortSignal };

export type AcpBridgeOptions = {
	hubUrl: string;
	room: string;
	name: string;
	prompt: (
		text: string,
		signal: AbortSignal,
	) => Promise<{ text: string; stopReason: string }>;
	accept: (message: MessageView, signal: AbortSignal) => Promise<boolean>;
	approveReply: (
		message: MessageView,
		text: string,
		signal: AbortSignal,
	) => Promise<boolean>;
	onError?: (error: unknown) => void;
	onClose?: () => void;
};

export class AcpBridge {
	readonly #runtime: A2aRuntime;
	readonly #options: AcpBridgeOptions;
	readonly #queue: Accepted[] = [];
	#drain: Promise<void> | null = null;
	#active: AbortController | null = null;
	#closed = false;

	constructor(options: AcpBridgeOptions) {
		this.#options = options;
		const client = new HubClient(options.hubUrl);
		this.#runtime = new A2aRuntime({
			getClient: async () => client,
			events: {
				onMessage: (message, signal) => this.#enqueue(message, signal),
				onError: (error) => options.onError?.(error),
				onClose: () => {
					this.#queue.length = 0;
					this.cancel();
					options.onClose?.();
				},
			},
		});
	}

	connect() {
		if (this.#closed) throw new Error("ACP bridge is closed");
		return this.#runtime.connect(this.#options.room, this.#options.name);
	}

	cancel(): boolean {
		if (!this.#active || this.#active.signal.aborted) return false;
		this.#active.abort(new Error("ACP turn cancelled locally"));
		return true;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#queue.length = 0;
		this.cancel();
		await this.#runtime.disconnect();
		await this.#drain;
	}

	#enqueue(message: MessageView, signal: AbortSignal): void {
		if (this.#closed || !this.#runtime.isPublishedConnection(signal))
			throw new Error("ACP bridge is not connected");
		if (message.target.type !== "agents")
			throw new Error("ACP bridge accepts direct messages only");
		if (message.attachments.length)
			throw new Error("ACP bridge does not accept attachments");
		if (!message.text.trim() || Buffer.byteLength(message.text) > 65_536)
			throw new Error("ACP bridge requires between 1 and 65536 bytes of text");
		if (this.#queue.length >= 8) throw new Error("ACP bridge inbox is full");
		this.#queue.push({ message, signal });
		this.#drain ??= this.#run().finally(() => {
			this.#drain = null;
		});
	}

	async #run(): Promise<void> {
		for (let job = this.#queue.shift(); job; job = this.#queue.shift()) {
			if (this.#closed || !this.#runtime.isPublishedConnection(job.signal))
				continue;
			const active = new AbortController();
			this.#active = active;
			const signal = AbortSignal.any([job.signal, active.signal]);
			try {
				await this.#runOne(job.message, signal, job.signal);
			} catch (error) {
				if (!signal.aborted) this.#options.onError?.(error);
			} finally {
				this.#active = null;
			}
		}
	}

	async #runOne(
		message: MessageView,
		signal: AbortSignal,
		connectionToken: AbortSignal,
	): Promise<void> {
		if (!(await this.#options.accept(message, signal))) return;
		signal.throwIfAborted();
		const result = await this.#options.prompt(message.text, signal);
		signal.throwIfAborted();
		const text = result.text;
		if (result.stopReason !== "end_turn" || !text.trim()) return;
		if (!(await this.#options.approveReply(message, text, signal))) return;
		signal.throwIfAborted();
		if (!this.#runtime.isPublishedConnection(connectionToken)) return;
		if (
			!this.#runtime
				.peers()
				.some(
					(peer) =>
						peer.presenceId === message.from.presenceId &&
						peer.name === message.from.name,
				)
		)
			return;
		await this.#runtime.message(
			{
				target: [message.from.name],
				text,
				replyTo: message.messageRef,
				userApproval: { kind: "omp-ui" },
			},
			{ signal, connectionToken },
		);
	}
}
