/**
 * Background tile download queue.
 *
 * Consumes a passage corridor tile list plus a high-priority recovery
 * queue (SPEC Addendum 5) with a single-worker async loop that:
 *
 * - throttles HTTP requests (`throttleMs` between requests)
 * - skips tiles already present in the store (no wasted bandwidth)
 * - validates tile bodies per the configured format profile (`png` or
 *   `pbf`): raster bodies must carry the PNG signature; vector bodies
 *   must parse as a protobuf message and are stored gzip-compressed
 *   (the MBTiles vector convention charts-provider-simple serves with
 *   `Content-Encoding: gzip`). An HTTP 204 over open ocean is a
 *   legitimate empty vector tile, stored as a gzipped empty MVT so
 *   re-runs do not refetch it
 * - validates the media type of successful responses against the
 *   profile's allowlist: only `image/png` for raster, the protobuf
 *   family for vector. JSON or HTML bodies (often rate limits) are
 *   dropped and trigger the escalating backoff throttle (SPEC
 *   Addendum 6)
 * - escalates the throttle on HTTP 429/503: instantly 5 minutes,
 *   doubling on subsequent failures up to 30 minutes, resetting after
 *   a successful fetch (SPEC Addendum 2)
 * - retries transient failures (HTTP 5xx, network errors, timeouts)
 *   with exponential backoff; fails fast on permanent errors (404,
 *   invalid bodies)
 * - monitors vessel connectivity via `getInternetState()` (the
 *   `network.internet.state` path published by signalk-internet) and
 *   suspends — polling every 10 s, waking immediately on
 *   `wake()` — while the state blocks the current tile's policy:
 *   passage tiles honor the job's metered override, recovery tiles
 *   honor `allowRecoveryOnMetered` (SPEC Addendums 3 and 5)
 * - always drains the recovery queue before remaining passage tiles,
 *   so a safety bubble around the vessel is fetched first (SPEC
 *   Addendum 5)
 * - starts a recovery job on `enqueueRecovery()` when idle, and a
 *   user-triggered passage job preempts a running recovery job (its
 *   pending tiles carry over as priority work)
 * - aborts promptly on `cancel()`: the in-flight fetch is aborted and
 *   the throttling sleep wakes early
 *
 * The loop owns no raw timers: the injectable sleep function is
 * responsible for early wake-ups, so `stop()` in the plugin only needs
 * to flip the cancel flag and abort the controller.
 *
 * @file lib/downloader.js
 */

const { gunzipSync, gzipSync } = require("node:zlib");

/**
 * PNG file signature: the first 8 bytes of every valid PNG body
 * (RFC 2083). Overlay tiles over open water are legitimately tiny —
 * fully transparent OpenSeaMap ocean tiles measure ~334 bytes — so a
 * byte-size floor cannot tell placeholders from empty sea. The
 * signature check can: rate-limit/error placeholders never carry it.
 */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Smallest structurally possible PNG: signature + IHDR + IEND chunks
 * (8 + 25 + 12 bytes).
 */
const MIN_PNG_BYTES = 45;

/** gzip magic bytes: MBTiles convention stores vector PBF tiles gzip-
 * compressed, and charts-provider-simple detects (and serves) them by
 * this signature. */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/**
 * Reads a protobuf varint at `pos`. Returns null when the bytes cannot
 * be a varint (truncated or > 53 bits, beyond Number precision).
 *
 * @param {Uint8Array} buf
 * @param {number} pos
 * @returns {{value: number, next: number}|null}
 */
function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    if (i >= buf.length) return null;
    const byte = buf[i];
    i += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if (value > Number.MAX_SAFE_INTEGER) return null;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 63) return null;
  }
}

/**
 * Do these bytes parse as one clean protobuf message (the envelope of a
 * Mapbox Vector Tile)? Walks the top-level fields without decoding
 * them: every tag must be well-formed and the walk must consume the
 * buffer exactly. A zero-length body is a valid *empty* vector tile.
 * JSON (`{` = tag 0x7b, wire type 3) and HTML (`<` = tag 0x3c, wire type
 * 4) fail on the first byte — the media-type gate rejects them earlier,
 * this is the backstop for mislabeled bodies.
 *
 * @param {Uint8Array} data
 * @returns {boolean}
 */
function isMvtBody(data) {
  if (data.length === 0) return true;
  let i = 0;
  while (i < data.length) {
    const tag = readVarint(data, i);
    if (!tag) return false;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (field < 1 || field > 536870911) return false;
    i = tag.next;
    if (wireType === 0) {
      const v = readVarint(data, i);
      if (!v) return false;
      i = v.next;
    } else if (wireType === 1) {
      i += 8;
    } else if (wireType === 2) {
      const len = readVarint(data, i);
      if (!len) return false;
      i = len.next + len.value;
    } else if (wireType === 5) {
      i += 4;
    } else {
      return false; // wire types 3/4 (groups) are deprecated
    }
    if (i > data.length) return false;
  }
  return true;
}

/**
 * Is the tile body a well-formed PNG? Rejects garbage, HTML and JSON
 * bodies mislabeled as image/png without punishing empty ocean tiles.
 *
 * @param {Uint8Array} data
 * @returns {boolean}
 */
function isPngBody(data) {
  return (
    data.length >= MIN_PNG_BYTES && data.subarray(0, 8).equals(PNG_SIGNATURE)
  );
}

/**
 * Validates a vector tile body and returns the bytes to store: gzipped
 * (the MBTiles vector convention the consumer plugin serves with
 * `Content-Encoding: gzip`). A body that already carries the gzip
 * signature (a server that skipped Content-Encoding) is validated by
 * decompressing and stored as received.
 *
 * @param {Uint8Array} data
 * @returns {Buffer} Blob to insert into the store
 * @throws When the body is not a Mapbox Vector Tile
 */
function preparePbfBody(data) {
  if (
    data.length >= 2 &&
    data[0] === GZIP_MAGIC[0] &&
    data[1] === GZIP_MAGIC[1]
  ) {
    let inner;
    try {
      inner = gunzipSync(data);
    } catch {
      throw new Error("corrupt gzip body");
    }
    if (!isMvtBody(inner)) throw new Error("not a Mapbox Vector Tile");
    return Buffer.from(data);
  }
  if (!isMvtBody(data)) throw new Error("not a Mapbox Vector Tile");
  return gzipSync(data);
}

/**
 * Validates a raster tile body and returns it unchanged.
 *
 * @param {Uint8Array} data
 * @returns {Buffer}
 * @throws When the body is not a PNG
 */
function preparePngBody(data) {
  if (!isPngBody(data)) throw new Error("not a PNG");
  return Buffer.from(data);
}

/** A gzipped empty Mapbox Vector Tile: what the store receives for a
 * legitimately empty tile (HTTP 204 from Open Waters over open ocean). */
const EMPTY_PBF = gzipSync(Buffer.alloc(0));

/**
 * Defensive-fetching profiles per tile format (SPEC Addendum 6 + the
 * Open Waters vector integration): the exact media types a successful
 * response may carry, the Accept header to send, how to validate and
 * prepare a body for the store, and whether an HTTP 204 (empty vector
 * tile over open ocean) is a legitimate answer.
 */
const TILE_FORMATS = {
  png: {
    mediaTypes: new Set(["image/png"]),
    acceptHeader: "image/png,image/*;q=0.9,*/*;q=0.5",
    prepare: preparePngBody,
    emptyBodyAllowed: false,
  },
  pbf: {
    mediaTypes: new Set([
      "application/x-protobuf",
      "application/vnd.mapbox-vector-tile",
      "application/gzip",
      "application/octet-stream",
    ]),
    acceptHeader:
      "application/x-protobuf,application/vnd.mapbox-vector-tile,*/*;q=0.5",
    prepare: preparePbfBody,
    emptyBodyAllowed: true,
  },
};

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
 * cancellation predicate so a cancel() or wake() during a long wait
 * takes effect within ~50ms instead of after the full delay.
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
 * Extracts the normalized media type from a response's Content-Type
 * header: lowercased, parameters (`;charset=...`) stripped. `""` when
 * the header is absent.
 *
 * @param {object} res - Fetch response
 * @returns {string} e.g. "image/png"
 */
function mediaTypeOf(res) {
  const raw = res.headers?.get?.("content-type");
  if (typeof raw !== "string") return "";
  return raw.split(";", 1)[0].trim().toLowerCase();
}

/**
 * Stable identity for a tile (queue dedup).
 *
 * @param {{z: number, x: number, yTms: number}} tile
 * @returns {string}
 */
function tileKey(tile) {
  return `${tile.z}/${tile.x}/${tile.yTms}`;
}

/**
 * Creates a background download queue.
 *
 * @param {object} options
 * @param {() => import("./mbtiles.js").MbTilesStore} options.getStore - Tile
 *   store accessor, resolved once per job so the caller can open and
 *   close the SQLite handle around active work (charts-provider-simple
 *   housekeeping deletes live `*.mbtiles-wal` sidecars, so the store must
 *   not stay open while idle)
 * @param {string} options.tileServerUrl - Slippy URL template ({z}/{x}/{y})
 * @param {"png"|"pbf"} [options.format] - Tile format profile for
 *   validation and storage (default png)
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
 * @param {boolean} [options.allowRecoveryOnMetered] - Whether recovery
 *   tiles may download on a metered link (default true, SPEC Addendum 5)
 * @param {(message: string) => void} [options.log] - Debug logger
 * @param {() => void} [options.onProgress] - Called after each state change
 * @param {(stats: object) => void} [options.onSettled] - Called once when
 *   a job finishes (completed or cancelled), with a stats snapshot
 * @returns {{start: Function, enqueueRecovery: Function, cancel: Function, wake: Function, status: Function}}
 */
function createDownloader(options) {
  const getStore = options.getStore;
  const tileServerUrl = options.tileServerUrl;
  const profile = TILE_FORMATS[options.format] || TILE_FORMATS.png;
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
  const allowRecoveryOnMetered = options.allowRecoveryOnMetered !== false;
  const log = options.log || (() => {});
  const onProgress = options.onProgress || (() => {});
  const onSettled = options.onSettled || (() => {});

  /** @type {{running: boolean, cancelled: boolean, controller: AbortController, isRecovery: boolean, tiles: Array, priority: Array, priorityKeys: Set, forceOnMetered: boolean, wakeRequested: boolean, stats: object}|null} */
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
   * Escalates the rate-limit penalty: instantly 5 minutes, doubling
   * on subsequent failures, capped at 30 minutes (SPEC Addendum 2).
   */
  function escalatePenalty() {
    penaltyMs =
      penaltyMs > 0
        ? Math.min(penaltyMs * 2, RATE_LIMIT_PENALTY_MAX_MS)
        : RATE_LIMIT_PENALTY_BASE_MS;
  }

  /**
   * Does this connectivity state block a download under the given
   * metered policy?
   *
   * @param {string|null} state
   * @param {boolean} allowMetered
   * @returns {boolean}
   */
  function blocked(state, allowMetered) {
    return state === "offline" || (state === "metered" && !allowMetered);
  }

  /**
   * Metered policy for a tile: recovery tiles follow the configured
   * recovery policy, passage tiles the job's override.
   *
   * @param {object} j - The running job
   * @param {{recovery?: boolean}} tile
   * @returns {boolean}
   */
  function allowMeteredFor(j, tile) {
    return tile.recovery === true ? allowRecoveryOnMetered : j.forceOnMetered;
  }

  /**
   * Circuit breaker: while the vessel's connectivity blocks the given
   * policy, sleep in SUSPEND_POLL_MS cycles instead of spending the
   * offshore data budget. Wakes early on cancel(), on wake() (e.g. the
   * internet-state delta transitioned), and — with `resumeIfPriority` —
   * when recovery tiles arrive that may proceed under their own policy.
   *
   * @param {object} j - The running job
   * @param {boolean} allowMetered - Metered policy being waited on
   * @param {boolean} [resumeIfPriority] - Return (unsuspended) as soon
   *   as recovery tiles are queued, even if this policy stays blocked
   * @returns {Promise<boolean>} False when the job was cancelled
   */
  async function waitSuspend(j, allowMetered, resumeIfPriority = false) {
    for (;;) {
      if (j.cancelled) return false;
      const state = getInternetState();
      if (!blocked(state, allowMetered)) {
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
      j.wakeRequested = false;
      await sleepFn(SUSPEND_POLL_MS, () => j.cancelled || j.wakeRequested);
      if (resumeIfPriority && j.priority.length > 0) {
        // New recovery work may be allowed under its own policy; hand
        // control back to the loop to re-scan the queues.
        j.stats.suspended = false;
        j.stats.suspendReason = null;
        return true;
      }
    }
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
   * Releases an unwanted response body without buffering it, so the
   * connection is not left dangling (best-effort for mock responses).
   *
   * @param {object} res - Fetch response
   */
  async function discardBody(res) {
    try {
      if (res.body && typeof res.body.cancel === "function") {
        await res.body.cancel();
      }
    } catch {
      // Connection cleanup is best-effort
    }
  }

  /**
   * Fetches one tile with retry/backoff. Permanent errors (404,
   * invalid bodies) throw immediately; wrong-media-type bodies and rate
   * limits (429/503) wait out the escalating penalty; other transient
   * errors (5xx, network faults, timeouts) retry with exponential
   * backoff. Each attempt re-checks the circuit breaker for this tile's
   * policy.
   *
   * @param {object} j - The running job
   * @param {{z: number, x: number, y: number, recovery?: boolean}} tile
   * @param {boolean} allowMetered
   * @returns {Promise<Uint8Array>} Tile blob as it should be stored
   */
  async function fetchTile(j, tile, allowMetered) {
    const url = tileUrl(tile);
    let transientRetries = 0;
    let rateLimitWaits = 0;
    for (;;) {
      if (!(await waitSuspend(j, allowMetered))) {
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
            Accept: profile.acceptHeader,
          },
          redirect: "follow",
          signal,
        });
        if (res.ok) {
          // Open Waters answers a legitimately empty vector tile (open
          // ocean: no land, no seamarks) with HTTP 204 — store a gzipped
          // empty MVT so corridor re-runs and recovery checks skip it.
          if (res.status === 204 && profile.emptyBodyAllowed) {
            return EMPTY_PBF;
          }
          // SPEC Addendum 6: providers answer rate limits and errors
          // with HTTP 200 + JSON/HTML bodies. Only the profile's exact
          // media types are tiles.
          const mediaType = mediaTypeOf(res);
          if (!profile.mediaTypes.has(mediaType)) {
            await discardBody(res);
            escalatePenalty();
            const err = new Error(
              `discarded body with Content-Type ${mediaType || "(missing)"} (expected ${[...profile.mediaTypes].join(" or ")})`,
            );
            err.rateLimited = true;
            throw err;
          }
          const data = Buffer.from(await res.arrayBuffer());
          try {
            // Validates the body and converts it to its stored form
            // (pbf bodies are gzipped here)
            return profile.prepare(data);
          } catch (err) {
            // Mislabeled or corrupt body (rate-limit placeholder, HTML
            // error page, truncated response): never insert it
            const permanent = new Error(
              `discarded ${data.length}-byte body (${err.message})`,
            );
            permanent.permanent = true;
            throw permanent;
          }
        }
        const rateLimited = res.status === 429 || res.status === 503;
        const retryable = rateLimited || res.status >= 500;
        if (rateLimited) {
          escalatePenalty();
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
   * observable through `status()` and `onProgress`. Recovery tiles
   * (`j.priority`) are always drained before remaining passage tiles;
   * passage tiles blocked by the circuit breaker are deferred while
   * allowed recovery work proceeds.
   *
   * @param {object} j - The running job
   */
  async function runJob(j) {
    const stats = j.stats;
    const store = getStore();
    try {
      let passageIdx = 0;
      /** Passage tiles deferred by the circuit breaker. */
      const deferred = [];

      for (;;) {
        if (j.cancelled) break;

        // Priority order: recovery first, then passage, then passage
        // tiles deferred by an earlier connectivity block.
        let tile;
        if (j.priority.length > 0) {
          tile = j.priority.shift();
          j.priorityKeys.delete(tileKey(tile));
        } else if (passageIdx < j.tiles.length) {
          tile = j.tiles[passageIdx++];
        } else if (deferred.length > 0) {
          tile = deferred.shift();
        } else {
          break;
        }

        const allowMetered = allowMeteredFor(j, tile);
        if (blocked(getInternetState(), allowMetered)) {
          // Park the tile and wait; wake() or newly queued recovery
          // tiles bring us back to re-scan the queues. Only passage
          // parks re-scan on queued recovery work — a parked recovery
          // tile shares its own policy, so it just waits for the
          // connectivity state to clear.
          if (tile.recovery) {
            j.priority.unshift(tile);
            if (!(await waitSuspend(j, allowMetered, false))) break;
          } else {
            deferred.unshift(tile);
            if (!(await waitSuspend(j, allowMetered, true))) break;
          }
          continue;
        }

        // Already cached (e.g. a previous corridor overlapped): count
        // and move on without an HTTP request or throttle delay.
        if (store.hasTile(tile.z, tile.x, tile.yTms)) {
          stats.skipped += 1;
          onProgress();
          continue;
        }

        try {
          const data = await fetchTile(j, tile, allowMetered);
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
        const moreWork =
          j.priority.length > 0 ||
          passageIdx < j.tiles.length ||
          deferred.length > 0;
        if (!j.cancelled && wait > 0 && moreWork) {
          // Wakeable: newly queued recovery tiles jump the throttle.
          await sleepFn(wait, () => j.cancelled || j.wakeRequested);
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
      onSettled({ ...stats, isRecovery: j.isRecovery });
    }
  }

  /**
   * Starts a passage download job. A running recovery job is preempted:
   * its pending tiles carry over as priority work so a user-triggered
   * passage download is never blocked by the safety cache.
   *
   * @param {Array<{z: number, x: number, y: number, yTms: number}>} tiles
   * @param {{routeName?: string|null, forceOnMetered?: boolean}} [meta]
   * @returns {boolean} False when a passage job is already running
   */
  function start(tiles, meta = {}) {
    if (job?.running) {
      if (!job.isRecovery) return false;
      job.cancelled = true;
      job.controller.abort();
      job.wakeRequested = true;
    }

    const carry = job?.running ? job.priority.splice(0) : [];
    const controller = new AbortController();
    job = {
      running: true,
      cancelled: false,
      controller,
      isRecovery: false,
      tiles,
      priority: carry,
      priorityKeys: new Set(carry.map((t) => tileKey(t))),
      forceOnMetered: meta.forceOnMetered === true,
      wakeRequested: false,
      stats: {
        state: "downloading",
        jobType: "passage",
        totalQueued: tiles.length + carry.length,
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
   * Queues recovery tiles (SPEC Addendum 5) tagged with the recovery
   * metered policy. When a job is running they are drained before any
   * remaining passage tiles; when idle a dedicated recovery job starts.
   * Duplicates of tiles already waiting in the priority queue are
   * dropped.
   *
   * @param {Array<{z: number, x: number, y: number, yTms: number}>} tiles
   * @param {{routeName?: string|null}} [meta]
   * @returns {number} Tiles actually queued
   */
  function enqueueRecovery(tiles, meta = {}) {
    if (!Array.isArray(tiles) || tiles.length === 0) return 0;
    const marked = tiles.map((t) => ({ ...t, recovery: true }));

    if (job?.running) {
      const fresh = marked.filter((t) => !job.priorityKeys.has(tileKey(t)));
      if (fresh.length === 0) return 0;
      for (const t of fresh) {
        job.priority.push(t);
        job.priorityKeys.add(tileKey(t));
      }
      job.stats.totalQueued += fresh.length;
      // Wake a suspended loop so the recovery tiles are considered
      // immediately (SPEC Addendum 5: priority fetching).
      job.wakeRequested = true;
      return fresh.length;
    }

    const controller = new AbortController();
    // Capture the count first: runJob drains `marked` (it is the
    // job's priority queue) synchronously up to its first await.
    const count = marked.length;
    job = {
      running: true,
      cancelled: false,
      controller,
      isRecovery: true,
      tiles: [],
      priority: marked,
      priorityKeys: new Set(marked.map((t) => tileKey(t))),
      forceOnMetered: false,
      wakeRequested: false,
      stats: {
        state: "downloading",
        jobType: "recovery",
        totalQueued: marked.length,
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
    return count;
  }

  /**
   * Requests cancellation: aborts the in-flight fetch and flags the
   * loop to exit before the next tile.
   */
  function cancel() {
    if (!job) return;
    job.cancelled = true;
    job.controller.abort();
    job.wakeRequested = true;
  }

  /**
   * Wakes a suspended loop immediately (SPEC Addendum 5: on
   * connectivity transitions). Cheap and safe when nothing is waiting.
   */
  function wake() {
    if (job) job.wakeRequested = true;
  }

  /**
   * Snapshot of the queue state. `etaMs` and `rate` are derived from
   * progress so the UI can render an ETA without client-side math;
   * `suspended`/`suspendReason` reflect the circuit breaker;
   * `throttleMs` is the currently effective inter-request delay;
   * `jobType` distinguishes passage from recovery jobs and
   * `recoveryPending` counts queued recovery tiles.
   *
   * @returns {object}
   */
  function status() {
    const base = {
      isDownloading: false,
      state: "idle",
      jobType: null,
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
      recoveryPending: 0,
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
      jobType: s.jobType,
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
      recoveryPending: job.priority.length,
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

  return { start, enqueueRecovery, cancel, wake, status };
}

module.exports = {
  backoffDelay,
  createDownloader,
  defaultSleep,
  isMvtBody,
  isPngBody,
  preparePbfBody,
  readVarint,
  EMPTY_PBF,
  GZIP_MAGIC,
  MIN_PNG_BYTES,
  PNG_SIGNATURE,
  RATE_LIMIT_PENALTY_BASE_MS,
  RATE_LIMIT_PENALTY_MAX_MS,
  SUSPEND_POLL_MS,
  TILE_FORMATS,
};
