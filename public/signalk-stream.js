/**
 * Minimal Signal K stream subscription for the webapp: listens to the
 * passive day/night mode delta and nothing else.
 *
 * Spec §2 compliance: the subscription carries a `minRate` floor
 * (theme changes are rare), reconnection uses exponential backoff, and
 * connection state changes are surfaced via an optional `onStatus`
 * callback.
 *
 * @file signalk-stream.js
 */

const MODE_PATH = "vessels.self.environment.mode";

/** Minimum update interval requested (ms). */
const MIN_RATE_MS = 5000;

/** Reconnect backoff bounds (ms). */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;

/**
 * Exponential reconnect delay for a failed connection attempt.
 *
 * @param {number} attempt - Failed attempts since the last open (0-based)
 * @returns {number} Delay in ms, doubling per attempt, capped at
 *   {@link BACKOFF_MAX_MS}
 */
function backoffDelay(attempt) {
	return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

class SignalKStream {
	/**
	 * @param {(path: string, value: unknown) => void} onValue
	 * @param {(status: "connecting"|"open"|"offline") => void} [onStatus]
	 */
	constructor(onValue, onStatus) {
		/** @type {((path: string, value: unknown) => void)|null} */
		this.onValue = onValue;
		/** @type {((status: string) => void)|null} */
		this.onStatus = onStatus;
		/** @type {WebSocket|null} */
		this.socket = null;
		/** @type {number|null} */
		this.reconnectTimer = null;
		/** @type {boolean} */
		this.closed = false;
		/** @type {number} Failed attempts since the last open. */
		this.attempts = 0;
	}

	connect() {
		if (this.closed) return;
		this.onStatus?.("connecting");
		const proto = window.location.protocol === "https:" ? "wss" : "ws";
		const socket = new WebSocket(
			`${proto}://${window.location.host}/signalk/v1/stream?subscribe=none`,
		);
		this.socket = socket;

		socket.addEventListener("open", () => {
			this.attempts = 0;
			this.onStatus?.("open");
			socket.send(
				JSON.stringify({
					context: "vessels.self",
					subscribe: [{ path: MODE_PATH, minRate: MIN_RATE_MS }],
				}),
			);
		});

		socket.addEventListener("message", (event) => {
			let data;
			try {
				data = JSON.parse(event.data);
			} catch {
				return;
			}
			for (const update of data.updates || []) {
				for (const value of update.values || []) {
					this.onValue?.(value.path, value.value);
				}
			}
		});

		socket.addEventListener("close", () => {
			if (this.closed) return;
			this.onStatus?.("offline");
			// Exponential backoff: 1s, 2s, 4s … capped at 30s, reset on open.
			const delay = backoffDelay(this.attempts);
			this.attempts += 1;
			this.reconnectTimer = setTimeout(() => this.connect(), delay);
		});

		socket.addEventListener("error", () => {
			socket.close();
		});
	}

	close() {
		this.closed = true;
		if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
		this.socket?.close();
	}
}

export { backoffDelay, MODE_PATH, SignalKStream };
