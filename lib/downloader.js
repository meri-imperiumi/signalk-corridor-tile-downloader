/**
 * Background tile download queue.
 *
 * Consumes a corridor tile list with a single-worker async loop that:
 *
 * - throttles HTTP requests (`throttleMs` between requests)
 * - skips tiles already present in the store (no wasted bandwidth)
 * - validates tile bodies: rate-limit placeholders return HTTP 200 with
 *   tiny payloads; anything under MIN_TILE_BYTES is discarded and
 *   counted as a failure, never inserted (SPEC Addendum 2)
 * - escalates the throttle on HTTP 429/503: instantly 5 minutes,
 *   doubling on subsequent failures up to 30 minutes, resetting after
 *   a successful fetch (SPEC Addendum 2)
 * - retries transient failures (HTTP 5xx, network errors, timeouts)
 *   with exponential backoff; fails fast on permanent errors (404,
 *   undersized bodies)
 * - monitors vessel connectivity via `getInternetState()` (the
 *   `network.internet.state` path published by signalk-internet) and
 *   suspends indefinitely — polling every 10 s — while the state is
 *   `offline` or (without the metered override) `metered` (SPEC
 *   Addendum 3)
 * - aborts promptly on `cancel()`: the in-flight fetch is aborted and
 *   the throttling sleep wakes early
 *
 * The loop owns no raw timers: the injectable sleep function is
 * responsible for early wake-ups, so `stop()` in the plugin only needs
 * to flip the cancel flag and abort the controller.
 *
 * @file lib/downloader.js
 */

/** Tiles smaller than this are rate-limit placeholders, not charts. */
const MIN_TILE_BYTES = 500;

/** First throttle penalty after a 429/503 response (5 minutes). */
const RATE_LIMIT_PENALTY_BASE_MS = 5 * 60 * 1000;

/** Penalty ceiling (30 minutes). */
const RATE_LIMIT_PENALTY_MAX_MS = 30 * 60 * 1000;

/** A hard-blocked server eventually fails the tile instead of retrying forever. */
const MAX_RATE_LIMIT_WAITS = 10;

/** Circuit-breaker re-check interval while suspended (10 seconds). */
const SUSPEND_POLL_MS = 10000;

/** Default per-attempt timeout for a single tile request. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

const DEFAULT_MAX_RETRIES = 5;

/**
 * Interruptible sleep used between throttled requests, during backoff
 * waits, and while the circuit breaker is suspended. Polls a
 * cancellation predicate so a cancel() during a long wait takes effect
 * within ~50ms instead of after the full delay.
 *
 * @param {number} ms - Delay in milliseconds
 * @param {() => boolean} isCancelled - Early-wake predicate
 * @returns {Promise<void>}
 */
function defaultSleep(ms, isCancelled) {
	if (ms <= 0 || isCancelled()) return Promise.resolve();
	return new Promise((resolve) => {
		const deadline = Date.now() + ms;
		const timer = setInterval(
			() => {
				if (isCancelled() || Date.now() >= deadline) {
					clearInterval(timer);
					resolve();
				}
			},
			Math.min(50, ms),
		);
	});
}

/**
 * Exponential backoff delay for attempt N (0-based), capped.
 *
 * @param {number} attempt - Failed attempt count (0-based)
 * @param {number} baseMs
 * @param {number} maxMs
 * @returns {number} Delay in ms
 */
function backoffDelay(attempt, baseMs, maxMs) {
	return Math.min(baseMs * 2 ** attempt, maxMs);
}

/**
 * Creates a background download queue.
 *
 * @param {object} options
 * @param {import("./mbtiles.js").MbTilesStore} options.store - Tile store
 * @param {string} options.tileServerUrl - Slippy URL template ({z}/{x}/{y})
 * @param {string} [options.userAgent] - User-Agent header value
 * @param {number} [options.throttleMs] - Base delay between HTTP requests
 * @param {number} [options.maxRetries] - Transient-error retries per tile
 * @param {number} [options.backoffBaseMs] - First backoff delay
 * @param {number} [options.backoffMaxMs] - Backoff ceiling
 * @param {number} [options.requestTimeoutMs] - Per-request timeout
 * @param {typeof fetch} [options.fetchFn] - Injectable fetch (tests)
 * @param {(ms: number, isCancelled: () => boolean) => Promise<void>} [options.sleepFn]
 * @param {() => string|null} [options.getInternetState] - Circuit breaker
 *   state source; null/undefined means "no connectivity plugin, proceed"
 * @param {(message: string) => void} [options.log] - Debug logger
 * @param {() => void} [options.onProgress] - Called after each state change
 * @returns {{start: Function, cancel: Function, status: Function}}
 */
function createDownloader(options) {
	const store = options.store;
	const tileServerUrl = options.tileServerUrl;
	const userAgent = options.userAgent || "SignalK-Corridor-Downloader/1.0";
	const throttleMs = Math.max(0, options.throttleMs || 0);
	const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
	const backoffBaseMs = Math.max(1, options.backoffBaseMs ?? 1000);
	const backoffMaxMs = Math.max(1, options.backoffMaxMs ?? 60000);
	const requestTimeoutMs =
		options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const fetchFn = options.fetchFn || fetch;
	const sleepFn = options.sleepFn || defaultSleep;
	const getInternetState = options.getInternetState || (() => null);
	const log = options.log || (() => {});
	const onProgress = options.onProgress || (() => {});

	/** @type {{running: boolean, cancelled: boolean, controller: AbortController, tiles: Array, forceOnMetered: boolean, stats: object}|null} */
	let job = null;

	/** Active rate-limit penalty; 0 means the configured throttle applies. */
	let penaltyMs = 0;

	/**
	 * The effective inter-request delay: the configured throttle, or the
	 * escalated rate-limit penalty while one is active.
	 *
	 * @returns {number}
	 */
	function effectiveThrottleMs() {
		return Math.max(throttleMs, penaltyMs);
	}

	/**
	 * Builds the request URL for a tile. The template uses slippy XYZ
	 * coordinates; the store receives the TMS row.
	 *
	 * @param {{z: number, x: number, y: number}} tile
	 * @returns {string}
	 */
	function tileUrl(tile) {
		return tileServerUrl
			.replaceAll("{z}", String(tile.z))
			.replaceAll("{x}", String(tile.x))
			.replaceAll("{y}", String(tile.y));
	}

	/**
	 * Circuit breaker: while the vessel's connectivity is offline (or
	 * metered without the override), sleep in SUSPEND_POLL_MS cycles
	 * instead of spending the offshore data budget. Resumes as soon as
	 * the state clears.
	 *
	 * @param {object} j - The running job
	 * @returns {Promise<boolean>} False when the job was cancelled while
	 *   suspended
	 */
	async function waitForConnection(j) {
		for (;;) {
			if (j.cancelled) return false;
			const state = getInternetState();
			const suspended =
				state === "offline" || (state === "metered" && !j.forceOnMetered);
			if (!suspended) {
				if (j.stats.suspended) {
					j.stats.suspended = false;
					j.stats.suspendReason = null;
					log(`connectivity restored (${state ?? "unknown"}), resuming`);
					onProgress();
				}
				return true;
			}
			if (!j.stats.suspended) {
				j.stats.suspended = true;
				j.stats.suspendReason = state;
				log(`connectivity ${state}; download suspended`);
				onProgress();
			}
			await sleepFn(SUSPEND_POLL_MS, () => j.cancelled);
		}
	}

	/**
	 * Fetches one tile with retry/backoff. Permanent errors (404,
	 * undersized bodies) throw immediately; rate limits (429/503) wait
	 * out the escalating penalty; other transient errors (5xx, network
	 * faults, timeouts) retry with exponential backoff.
	 *
	 * @param {object} j - The running job
	 * @param {{z: number, x: number, y: number}} tile
	 * @returns {Promise<Uint8Array>} Tile blob
	 */
	async function fetchTile(j, tile) {
		const url = tileUrl(tile);
		let transientRetries = 0;
		let rateLimitWaits = 0;
		for (;;) {
			if (!(await waitForConnection(j))) {
				const err = new Error("cancelled");
				err.cancelled = true;
				throw err;
			}
			if (j.cancelled) {
				const err = new Error("cancelled");
				err.cancelled = true;
				throw err;
			}
			try {
				const signal = AbortSignal.any([
					j.controller.signal,
					AbortSignal.timeout(requestTimeoutMs),
				]);
				const res = await fetchFn(url, {
					headers: {
						"User-Agent": userAgent,
						Accept: "image/png,image/*;q=0.9,*/*;q=0.5",
					},
					redirect: "follow",
					signal,
				});
				if (res.ok) {
					const data = Buffer.from(await res.arrayBuffer());
					if (data.length < MIN_TILE_BYTES) {
						// Rate-limit placeholders answer 200 OK with tiny bodies
						const err = new Error(
							`discarded ${data.length}-byte tile body (< ${MIN_TILE_BYTES})`,
						);
						err.permanent = true;
						throw err;
					}
					return data;
				}
				const rateLimited = res.status === 429 || res.status === 503;
				const retryable = rateLimited || res.status >= 500;
				if (rateLimited) {
					// Instantly 5 minutes, doubling on subsequent failures,
					// capped at 30 minutes.
					penaltyMs =
						penaltyMs > 0
							? Math.min(penaltyMs * 2, RATE_LIMIT_PENALTY_MAX_MS)
							: RATE_LIMIT_PENALTY_BASE_MS;
				}
				const err = new Error(`HTTP ${res.status}`);
				err.permanent = !retryable;
				err.rateLimited = rateLimited;
				throw err;
			} catch (err) {
				// Our own abort (cancel) surfaces immediately; a timeout abort
				// (controller still live) is a normal retryable failure.
				if (j.cancelled || err.cancelled) throw err;
				if (err.permanent) throw err;

				let wait;
				if (err.rateLimited) {
					rateLimitWaits += 1;
					if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
						throw new Error(
							`${err.message} (rate limited, gave up after ${rateLimitWaits} penalty waits)`,
						);
					}
					wait = penaltyMs;
				} else {
					if (transientRetries >= maxRetries) {
						throw new Error(
							`${err.message} (giving up after ${transientRetries + 1} attempts)`,
						);
					}
					wait = backoffDelay(transientRetries, backoffBaseMs, backoffMaxMs);
					transientRetries += 1;
				}
				log(`retrying ${url} in ${wait}ms: ${err.message}`);
				await sleepFn(wait, () => j.cancelled);
			}
		}
	}

	/**
	 * The background worker loop. Runs detached; state changes are
	 * observable through `status()` and `onProgress`.
	 *
	 * @param {object} j - The running job
	 */
	async function runJob(j) {
		const stats = j.stats;
		try {
			for (let i = 0; i < j.tiles.length; i++) {
				if (j.cancelled) break;
				const tile = j.tiles[i];

				// Already cached (e.g. a previous corridor overlapped): count
				// and move on without an HTTP request or throttle delay.
				if (store.hasTile(tile.z, tile.x, tile.yTms)) {
					stats.skipped += 1;
					continue;
				}

				try {
					const data = await fetchTile(j, tile);
					if (j.cancelled) break;
					store.insertTile(tile.z, tile.x, tile.yTms, data);
					stats.completed += 1;
					// A successful fetch ends any rate-limit penalty.
					penaltyMs = 0;
				} catch (err) {
					if (j.cancelled) break;
					stats.failed += 1;
					log(`tile ${tile.z}/${tile.x}/${tile.y} failed: ${err.message}`);
				}

				onProgress();
				const wait = effectiveThrottleMs();
				if (i + 1 < j.tiles.length && !j.cancelled && wait > 0) {
					await sleepFn(wait, () => j.cancelled);
				}
			}
		} finally {
			j.running = false;
			penaltyMs = 0;
			stats.state = j.cancelled ? "cancelled" : "completed";
			stats.suspended = false;
			stats.suspendReason = null;
			stats.finishedAt = Date.now();
			onProgress();
		}
	}

	/**
	 * Starts a download job.
	 *
	 * @param {Array<{z: number, x: number, y: number, yTms: number}>} tiles
	 * @param {{routeName?: string|null, forceOnMetered?: boolean}} [meta]
	 * @returns {boolean} False when a job is already running
	 */
	function start(tiles, meta = {}) {
		if (job?.running) return false;
		const controller = new AbortController();
		job = {
			running: true,
			cancelled: false,
			controller,
			tiles,
			forceOnMetered: meta.forceOnMetered === true,
			stats: {
				state: "downloading",
				totalQueued: tiles.length,
				completed: 0,
				failed: 0,
				skipped: 0,
				startedAt: Date.now(),
				finishedAt: null,
				routeName: meta.routeName ?? null,
				suspended: false,
				suspendReason: null,
			},
		};
		runJob(job);
		return true;
	}

	/**
	 * Requests cancellation: aborts the in-flight fetch and flags the
	 * loop to exit before the next tile.
	 */
	function cancel() {
		if (!job) return;
		job.cancelled = true;
		job.controller.abort();
	}

	/**
	 * Snapshot of the queue state. `etaMs` and `rate` are derived from
	 * progress so the UI can render an ETA without client-side math;
	 * `suspended`/`suspendReason` reflect the circuit breaker;
	 * `throttleMs` is the currently effective inter-request delay.
	 *
	 * @returns {object}
	 */
	function status() {
		const base = {
			isDownloading: false,
			state: "idle",
			totalQueued: 0,
			completed: 0,
			failed: 0,
			skipped: 0,
			startedAt: null,
			finishedAt: null,
			routeName: null,
			forceOnMetered: false,
			suspended: false,
			suspendReason: null,
			etaMs: null,
			rate: 0,
		};
		if (!job) {
			return { ...base, throttleMs };
		}
		const s = job.stats;
		const out = {
			...base,
			isDownloading: job.running,
			state: s.state,
			totalQueued: s.totalQueued,
			completed: s.completed,
			failed: s.failed,
			skipped: s.skipped,
			startedAt: s.startedAt,
			finishedAt: s.finishedAt,
			routeName: s.routeName,
			forceOnMetered: job.forceOnMetered,
			suspended: s.suspended,
			suspendReason: s.suspendReason,
			throttleMs: effectiveThrottleMs(),
		};
		if (job.running && s.totalQueued > 0) {
			const done = s.completed + s.skipped + s.failed;
			const elapsedMs = Date.now() - s.startedAt;
			if (done > 0 && elapsedMs > 0) {
				out.rate = done / (elapsedMs / 1000);
				const remaining = s.totalQueued - done;
				out.etaMs = Math.round((remaining * elapsedMs) / done);
			}
		}
		return out;
	}

	return { start, cancel, status };
}

module.exports = {
	backoffDelay,
	createDownloader,
	defaultSleep,
	MIN_TILE_BYTES,
	RATE_LIMIT_PENALTY_BASE_MS,
	RATE_LIMIT_PENALTY_MAX_MS,
	SUSPEND_POLL_MS,
};
