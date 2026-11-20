const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

/** Reconnect the same Room with bounded backoff, never replaying messages. */
export class RoomReconnect {
	#timer?: ReturnType<typeof setTimeout>;
	#delayMs = INITIAL_DELAY_MS;

	get backedOff(): boolean {
		return this.#delayMs > INITIAL_DELAY_MS;
	}

	schedule(reconnect: () => void): void {
		if (this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			reconnect();
		}, this.#delayMs);
		this.#delayMs = Math.min(this.#delayMs * 2, MAX_DELAY_MS);
	}

	cancel(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	reset(): void {
		this.cancel();
		this.#delayMs = INITIAL_DELAY_MS;
	}
}

export function canReconnectRoom(error: Error): boolean {
	return !error.message.startsWith("name_in_use:");
}
