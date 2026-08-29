/**
 * Background tile download queue.
 *
 * Consumes a passage corridor tile list plus a high-priority recovery
 * queue (SPEC Addendum 5) with a single-worker async loop that:
 *
 * - routes every tile by its `source` id: the URL template, the body
 *   validation profile and the destination store all come from the
 *   per-source maps given at construction (BATHYMETRY.md STEP 3/6).
 *   A tile without `source` belongs to `"seamap"` (journal/recovery
 *   entries written before multi-source support stay valid)
 * - validates tile bodies per the source's format profile: `png`
 *   (signature), `pbf` (protobuf walk, stored gzip-compressed — the
 *   MBTiles vector convention charts-provider-simple serves with
 *   `Content-Encoding: gzip`), or `webp` (RIFF/WEBP magic, stored
 *   verbatim). An HTTP 204 over open ocean is a legitimate empty
 *   vector tile, stored as a gzipped empty MVT so re-runs do not
 *   refetch it. An HTTP 404 on ANY source is a per-tile skip —
 *   bathymetry/DEM coverage is regional (BATHYMETRY.md FAILURES)
 * - validates the media type of successful responses against the
 *   profile's allowlist: only `image/png` for raster PNG, the protobuf
 *   family for vector, `image/webp` for WebP. JSON or HTML bodies
 *   (often rate limits) are dropped and trigger the escalating backoff
 *   throttle (SPEC Addendum 6)
 * - escalates the throttle on HTTP 429/503: instantly 5 minutes,
 *   doubling on subsequent failures up to 30 minutes, resetting after
 *   a successful fetch (SPEC Addendum 2)
 * - retries transient failures (HTTP 5xx, network errors, timeouts)
 *   with exponential backoff; fails fast on permanent errors (invalid
 *   bodies)
 * - fetches symbol assets (style, sprites, font glyphs) through the
 *   SAME throttle/backoff/circuit-breaker machinery, concurrently
 *   with tiles (BATHYMETRY.md STEP 9): 404s skip that file, failures
 *   never block the tile queue
 * - monitors vessel connectivity via `getInternetState()` (the
 *   `network.internet.state` path published by signalk-internet) and
 *   suspends — polling every 10 s, waking immediately on `wake()` —
 *   while the state blocks the current tile's policy: passage tiles
 *   honor the job's metered override, recovery tiles honor
 *   `allowRecoveryOnMetered` (SPEC Addendums 3 and 5)
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

/** Smallest structurally possible PNG: signature + IHDR + IEND chunks
 * (8 + 25 + 12 bytes). */
const MIN_PNG_BYTES = 45;

/** gzip magic bytes: MBTiles convention stores vector PBF tiles gzip-
 * compressed, and charts-provider-simple detects (and serves) them by
 * this signature. */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** WebP container magic: bytes 0-3 `RIFF`, bytes 8-11 `WEBP`
 * (12-byte structural check; the RIFF length field is not validated
 * beyond existence — no size floors for tile bodies). */
const RIFF_HEADER = Buffer.from("RIFF", "ascii");
const WEBP_TAG = Buffer.from("WEBP", "ascii");

/** Asset fetches are best-effort: after this many consecutive
 * exhausted assets (dead network, hard-blocked server) the remaining
 * ones are marked skipped so the tile queue is never held hostage by
 * hours of doomed retries (BATHYMETRY.md FAILURES: a failed asset
 * phase never blocks tiles). */
const MAX_CONSECUTIVE_ASSET_FAILURES = 3;

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
 * Is the tile body a WebP container (RIFF....WEBP)? Terrarium DEM tiles
 * from the Open Waters mirror arrive as raster WebP and are stored
 * verbatim (BATHYMETRY.md FACTS).
 *
 * @param {Uint8Array} data
 * @returns {boolean}
 */
function isWebpBody(data) {
  return (
    data.length >= 12 &&
    data.subarray(0, 4).equals(RIFF_HEADER) &&
    data.subarray(8, 12).equals(WEBP_TAG)
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

/**
 * Validates a raster WebP tile body and returns it unchanged (stored
 * verbatim — never gzipped; the consumer sniffs `format: webp` from
 * the metadata row and serves `image/webp`).
 *
 * @param {Uint8Array} data
 * @returns {Buffer}
 * @throws When the body is not a WebP container
 */
function prepareWebpBody(data) {
  if (!isWebpBody(data)) throw new Error("not a WebP");
  return Buffer.from(data);
}

/** A gzipped empty Mapbox Vector Tile: what the store receives for a
 * legitimately empty tile (HTTP 204 from Open Waters over open ocean). */
const EMPTY_PBF = gzipSync(Buffer.alloc(0));

/**
 * Defensive-fetching profiles per tile format (SPEC Addendum 6 + the
 * Open Waters mirror): the exact media types a successful response may
 * carry, the Accept header to send, how to validate and prepare a body
 * for the store, and whether an HTTP 204 (empty vector tile over open
 * ocean) is a legitimate answer.
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
  webp: {
    mediaTypes: new Set(["image/webp"]),
    acceptHeader: "image/webp,image/*;q=0.9,*/*;q=0.5",
    prepare: prepareWebpBody,
    emptyBodyAllowed: false,
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

/** Default per-attempt timeout for a single request. */
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
  if (ms <= 0) return Promise.resolve();
  // A wake or cancel already pending: resolve on the NEXT MACROTASK tick,
  // not as a microtask. Callers drive `await sleepFn(...); continue;`
  // loops (the all-throttled penalty-wait branch, waitSuspend): a
  // microtask resolve lets such a loop spin without ever yielding to
  // the event loop, starving HTTP (and every other timer) for as long
  // as the loop condition holds. A macrotask resolve always yields.
  if (isCancelled()) return new Promise((r) => setImmediate(r));
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
  const mt = raw.split(";", 1)[0].trim().toLowerCase();
  // Some servers (notably tiles.versatiles.org) return vendor subtypes
  // without the `application/` tree prefix — e.g.
  // `vnd.mapbox-vector-tile` instead of `application/vnd.mapbox-vector-tile`.
  // A valid media type always contains a slash, so a bare token is an
  // abbreviated vendor subtype; prepend the `application/` tree it was
  // meant to be. Without this, every versatiles pbf tile is rejected as
  // a wrong-Content-Type rate limit and penalizes the whole host
  // (blocking its sibling elevation source too).
  if (mt && !mt.includes("/")) return `application/${mt}`;
  return mt;
}

/**
 * The host (incl. port) of a URL, for per-server rate-limit tracking.
 * Rate limiting is per-server: a 429 from `tiles.openwaters.io` must not
 * stall `tiles.versatiles.org`. Returns "" for unparseable URLs.
 *
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Parses an HTTP `Retry-After` header (RFC 7231) into milliseconds.
 * Accepts either delta-seconds (e.g. "120") or an HTTP-date. Returns null
 * when absent or unparseable. There is deliberately no floor: if the
 * server says retry in 1 second, the caller waits 1 second, not the
 * SPEC's defensive 5 minutes. A future/past date clamps to >= 0.
 *
 * @param {object} headers - Response headers (`.get(name)`)
 * @param {number} now - Current epoch milliseconds
 * @returns {number|null}
 */
function parseRetryAfter(headers, now) {
  const raw = headers?.get?.("retry-after");
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (/^\d+$/.test(v)) {
    const ms = Number.parseInt(v, 10) * 1000;
    // 0 means "retry now" — no usable delay. Returning null falls back
    // to the SPEC ladder so a 429-with-Retry-After:0 doesn't spin a
    // tight refetch loop (a positive value is honored with no floor).
    return ms > 0 ? ms : null;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const ms = t - now;
  // A past date means "retry now" — same degenerate case as 0 above.
  return ms > 0 ? ms : null;
}

/** The tileset a tile without an explicit `source` belongs to. */
const DEFAULT_SOURCE = "seamap";

/**
 * Which tileset a tile belongs to. Absent `source` means `"seamap"`:
 * journal/recovery entries written before the multi-source mirror stay
 * valid (BATHYMETRY.md STEP 3).
 *
 * @param {{source?: string}} tile
 * @returns {string} Provider source id
 */
function sourceOf(tile) {
  return typeof tile.source === "string" && tile.source !== ""
    ? tile.source
    : DEFAULT_SOURCE;
}

/**
 * Stable identity for a tile (queue dedup). Includes the tile's source
 * so the same z/x/y from different tilesets never collide in
 * `priorityKeys`.
 *
 * @param {{z: number, x: number, yTms: number, source?: string}} tile
 * @returns {string}
 */
function tileKey(tile) {
  return `${sourceOf(tile)}/${tile.z}/${tile.x}/${tile.yTms}`;
}

/**
 * @returns {{totalQueued: number, completed: number, failed: number, skipped: number}}
 */
function blankSourceStats() {
  return { totalQueued: 0, completed: 0, failed: 0, skipped: 0 };
}

/**
 * Per-source queued counts for a tile list (top-level totals stay the
 * sum over sources).
 *
 * @param {Array<object>} tiles
 * @returns {Record<string, object>} Source id → counts
 */
function countBySource(tiles) {
  const out = {};
  for (const tile of tiles) {
    const key = sourceOf(tile);
    out[key] ??= blankSourceStats();
    out[key].totalQueued += 1;
  }
  return out;
}

/**
 * A cancellation error: surfaces immediately, never retried.
 *
 * @returns {Error}
 */
function cancelledError() {
  const err = new Error("cancelled");
  err.cancelled = true;
  return err;
}

/**
 * Creates a background download queue.
 *
 * @param {object} options
 * @param {object} options.templates - Slippy URL template per source
 *   id: `{seamap: "https://…/{z}/{x}/{y}.pbf", …}`
 * @param {object} [options.formats] - Format profile id per source
 *   (`png`|`pbf`|`webp`); sources absent here use `options.format`
 * @param {"png"|"pbf"|"webp"} [options.format] - Default format
 *   profile for validation and storage (default png)
 * @param {object} [options.stores] - Store map per source id; the
 *   tile's source picks the destination file
 * @param {(source: string) => import("./mbtiles.js").MbTilesStore} [options.getStore]
 *   - Store accessor alternative to `stores`, resolved per tile so the
 *   caller can open and close the SQLite handles around active work
 *   (charts-provider-simple housekeeping deletes live `*.mbtiles-wal`
 *   sidecars, so stores must not stay open while idle)
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
 * @param {(tile: object) => void} [options.onTileStored] - Called after a
 *   tile's store gained a new row (used to refresh the charts provider
 *   when a job first populates a store)
 * @param {(stats: object) => void} [options.onSettled] - Called once when
 *   a job finishes (completed or cancelled), with a stats snapshot
 * @returns {{start: Function, enqueueRecovery: Function, cancel: Function, wake: Function, status: Function}}
 */
function createDownloader(options) {
  const storeFor =
    typeof options.getStore === "function"
      ? options.getStore
      : options.stores
        ? (source) => options.stores[source]
        : null;
  const templates = { ...(options.templates ?? {}) };
  const formats = {
    default: options.format ?? "png",
    ...(options.formats ?? {}),
  };
  const userAgent = options.userAgent || "SignalK-Corridor-Downloader/1.0";
  const throttleMs = Math.max(0, options.throttleMs || 0);
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const backoffBaseMs = Math.max(1, options.backoffBaseMs ?? 1000);
  const backoffMaxMs = Math.max(1, options.backoffMaxMs ?? 60000);
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchFn = options.fetchFn || fetch;
  const sleepFn = options.sleepFn || defaultSleep;
  const nowFn = options.nowFn || (() => Date.now());
  const getInternetState = options.getInternetState || (() => null);
  const allowRecoveryOnMetered = options.allowRecoveryOnMetered !== false;
  const log = options.log || (() => {});
  const onProgress = options.onProgress || (() => {});
  const onTileStored = options.onTileStored || null;
  const onSettled = options.onSettled || (() => {});

  /** @type {{running: boolean, cancelled: boolean, controller: AbortController, isRecovery: boolean, tiles: Array, priority: Array, priorityKeys: Set, forceOnMetered: boolean, wakeRequested: boolean, assets: Array|null, onAssetResult: Function|null, stats: object}|null} */
  let job = null;

  /**
   * Per-server rate-limit penalties, keyed by request host. Rate
   * limiting is per-server: a 429 from `tiles.openwaters.io` must not
   * stall `tiles.versatiles.org`. Each entry is `{ level, until }`:
   * `level` is the escalation magnitude (doubles on consecutive
   * failures without a `Retry-After`, per SPEC Addendum 2), `until`
   * is the absolute timestamp until which the host is blocked.
   */
  const penaltyByHost = new Map();

  /**
   * Remaining penalty (ms) for a host — how long until its block
   * expires. 0 when the host is not rate-limited.
   *
   * @param {string} host
   * @returns {number}
   */
  function penaltyRemainingFor(host) {
    const s = penaltyByHost.get(host);
    if (!s) return 0;
    return Math.max(0, s.until - nowFn());
  }

  /**
   * The throttle to report in `status()`: only counts a rate-limit
   * penalty when the loop is actually blocked by it — i.e. every host
   * that still has pending tiles is currently penalized. When at least
   * one pending-tile host is unpenalized, the loop is making progress on
   * that host and the penalty (on a different host) must NOT surface as
   * a job-wide "SERVER THROTTLE" notice — it would cry wolf while tiles
   * are downloading. Rate limiting is per-server; a 429 from
   * `tiles.openwaters.io` is irrelevant while `tiles.versatiles.org`
   * tiles are fetching.
   *
   * @param {Record<string, {totalQueued: number, completed: number, failed: number, skipped: number}>} bySource
   * @returns {number}
   */
  function statusThrottleMs(bySource) {
    let pendingHosts = 0;
    let unpenalizedPending = false;
    let maxBlockedPenalty = 0;
    for (const [id, counts] of Object.entries(bySource)) {
      const done =
        (counts.completed || 0) + (counts.skipped || 0) + (counts.failed || 0);
      if ((counts.totalQueued || 0) - done <= 0) continue;
      pendingHosts += 1;
      const host = hostOf(templates[id] ?? "");
      const rem = penaltyRemainingFor(host);
      if (rem > 0) {
        if (rem > maxBlockedPenalty) maxBlockedPenalty = rem;
      } else {
        unpenalizedPending = true;
      }
    }
    // No pending tiles, or at least one unpenalized pending host: the
    // loop is not blocked by a rate limit, so report the configured
    // throttle only.
    if (pendingHosts === 0 || unpenalizedPending) return throttleMs;
    return Math.max(throttleMs, maxBlockedPenalty);
  }

  /**
   * Shared inter-request gate: when the asset phase and the tile loop
   * run concurrently (BATHYMETRY.md STEP 9), both coordinate through
   * this timestamp so the global request rate never exceeds the
   * configured `throttleMs` — one request every `throttleMs` regardless
   * of which loop is fetching. The per-host rate-limit penalty is
   * applied on top, so a penalized server waits out its own block while
   * other servers proceed. The gate is checked before each HTTP request
   * and updates `lastRequestAt` optimistically.
   */
  let lastRequestAt = 0;

  /**
   * Waits for the shared throttle gate to open (the configured
   * `throttleMs` since the last request to any host) and for this
   * host's rate-limit penalty to expire, then claims the gate.
   *
   * @param {object} j - The running job
   * @param {string} host - Request host (selects the per-server penalty)
   * @param {Function} wakeFn - Cancellation/wake predicate for the sleep
   * @returns {Promise<boolean>} False if the job was cancelled while waiting
   */
  async function awaitThrottle(j, host, wakeFn) {
    const now = nowFn();
    let remaining = 0;
    if (throttleMs > 0) {
      const sinceLast = now - lastRequestAt;
      if (sinceLast < throttleMs) remaining = throttleMs - sinceLast;
    }
    const penalty = penaltyRemainingFor(host);
    if (penalty > remaining) remaining = penalty;
    if (remaining > 0) {
      await sleepFn(remaining, wakeFn);
      if (j.cancelled) return false;
    }
    lastRequestAt = nowFn();
    return true;
  }

  /**
   * Escalates a host's rate-limit penalty. When the response carries a
   * `Retry-After` header (delta-seconds or an HTTP-date), the server's
   * value is honored directly — no floor: if it says 1s, we wait 1s,
   * not the SPEC's defensive 5 minutes. Without `Retry-After`, the
   * SPEC Addendum 2 ladder applies: 5 minutes on the first failure,
   * doubling on subsequent failures, capped at 30 minutes. A fresh
   * penalty replaces any active one (the latest signal wins). All
   * values are capped at `RATE_LIMIT_PENALTY_MAX_MS`.
   *
   * @param {string} host
   * @param {number|null} retryAfterMs - Parsed `Retry-After`, or null
   */
  function escalatePenalty(host, retryAfterMs) {
    const now = nowFn();
    let s = penaltyByHost.get(host);
    if (!s) {
      s = { level: 0, until: 0 };
      penaltyByHost.set(host, s);
    }
    let level;
    if (retryAfterMs != null) {
      level = Math.min(retryAfterMs, RATE_LIMIT_PENALTY_MAX_MS);
    } else {
      level =
        s.level > 0
          ? Math.min(s.level * 2, RATE_LIMIT_PENALTY_MAX_MS)
          : RATE_LIMIT_PENALTY_BASE_MS;
    }
    s.level = level;
    s.until = now + level;
  }

  /**
   * Clears a host's rate-limit penalty after a successful fetch: the
   * server is responding again, so the escalation resets — a later 429
   * starts fresh from the base rather than re-doubling a remembered
   * level (which would strand the job at the doubled penalty).
   *
   * @param {string} host
   */
  function clearPenalty(host) {
    penaltyByHost.delete(host);
  }

  /**
   * The validation/storage profile for a tile's source.
   *
   * @param {{source?: string}} tile
   * @returns {object} TILE_FORMATS entry
   */
  function profileFor(tile) {
    return TILE_FORMATS[formats[sourceOf(tile)] ?? formats.default];
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
   * coordinates; the store receives the TMS row. The tile's source
   * picks its template.
   *
   * @param {{z: number, x: number, y: number, source?: string}} tile
   * @returns {string}
   */
  function tileUrl(tile) {
    const template = templates[sourceOf(tile)];
    if (typeof template !== "string" || template === "") {
      throw new Error(`no URL template for tile source "${tile.source}"`);
    }
    return template
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
   * Retry/backoff wrapper shared by tile and asset fetches: permanent
   * errors throw immediately; rate-limited responses re-throw immediately
   * (the caller defers the tile so other hosts can proceed while this
   * one cools down — sleeping the penalty here would block the whole
   * loop); transient errors (5xx, network faults, timeouts) retry with
   * exponential backoff. Each attempt re-checks the circuit breaker
   * (inside `attempt`).
   *
   * @param {object} j - The running job
   * @param {string} url - Request URL (logging)
   * @param {{transientRetries: number, rateLimitWaits: number}} counters
   * @param {() => Promise<*>} attempt - One fetch attempt
   */
  async function withRetries(j, url, counters, attempt) {
    for (;;) {
      try {
        return await attempt();
      } catch (err) {
        // Our own abort (cancel) surfaces immediately; a timeout abort
        // (controller still live) is a normal retryable failure.
        if (j.cancelled || err.cancelled) throw err;
        if (err.permanent) throw err;
        // Rate limits are not retried inline: sleeping the penalty here
        // would block the whole loop, stalling tiles on other (free)
        // hosts. Re-throw so the caller defers this tile and keeps
        // fetching from unpenalized servers meanwhile. The per-tile
        // deferral cap lives in the caller (runJob), not here, since
        // `counters` is fresh per fetch and wouldn't survive a defer.
        if (err.rateLimited) throw err;

        if (counters.transientRetries >= maxRetries) {
          throw new Error(
            `${err.message} (giving up after ${counters.transientRetries + 1} attempts)`,
          );
        }
        const wait = backoffDelay(
          counters.transientRetries,
          backoffBaseMs,
          backoffMaxMs,
        );
        counters.transientRetries += 1;
        log(`retrying ${url} in ${wait}ms: ${err.message}`);
        await sleepFn(wait, () => j.cancelled);
      }
    }
  }

  /**
   * Fetches one tile with retry/backoff. Permanent errors (404, invalid
   * bodies) throw immediately — a 404 carries `err.skip` so the job
   * counts it as a per-tile skip (regional coverage, BATHYMETRY.md
   * FAILURES); wrong-media-type bodies and rate limits (429/503) wait
   * out the escalating penalty; other transient errors retry with
   * exponential backoff. Each attempt re-checks the circuit breaker for
   * this tile's policy.
   *
   * @param {object} j - The running job
   * @param {{z: number, x: number, y: number, recovery?: boolean, source?: string}} tile
   * @param {boolean} allowMetered
   * @returns {Promise<Uint8Array>} Tile blob as it should be stored
   */
  async function fetchTile(j, tile, allowMetered) {
    const url = tileUrl(tile);
    const profile = profileFor(tile);
    const counters = { transientRetries: 0, rateLimitWaits: 0 };
    return withRetries(j, url, counters, async () => {
      if (!(await waitSuspend(j, allowMetered))) throw cancelledError();
      if (j.cancelled) throw cancelledError();
      const res = await fetchFn(url, {
        headers: {
          "User-Agent": userAgent,
          Accept: profile.acceptHeader,
        },
        redirect: "follow",
        signal: AbortSignal.any([
          j.controller.signal,
          AbortSignal.timeout(requestTimeoutMs),
        ]),
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
          escalatePenalty(hostOf(url), parseRetryAfter(res.headers, nowFn()));
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
      if (res.status === 404) {
        await discardBody(res);
        // Regional coverage (bathymetry, DEM) or a retired tile: a
        // skip, not a failure — the next job re-probes it.
        const err = new Error("HTTP 404");
        err.permanent = true;
        err.skip = true;
        throw err;
      }
      const rateLimited = res.status === 429 || res.status === 503;
      if (rateLimited) {
        escalatePenalty(hostOf(url), parseRetryAfter(res.headers, nowFn()));
      }
      const err = new Error(`HTTP ${res.status}`);
      err.permanent = !(rateLimited || res.status >= 500);
      err.rateLimited = rateLimited;
      throw err;
    });
  }

  /**
   * Fetches one symbol asset (style, sprite sheet, glyph range) with
   * the same retry/backoff/circuit-breaker machinery as tiles. Assets
   * are stored verbatim (no media-type allowlist — the mirror keeps
   * upstream bodies whole); a 404 is a skip, never a failure.
   *
   * @param {object} j - The running job
   * @param {{url: string, acceptHeader?: string}} asset
   * @param {boolean} allowMetered
   * @returns {Promise<{status: number|string, data: Uint8Array|null}>}
   */
  async function fetchAsset(j, asset, allowMetered) {
    const counters = { transientRetries: 0, rateLimitWaits: 0 };
    return withRetries(j, asset.url, counters, async () => {
      if (!(await waitSuspend(j, allowMetered))) throw cancelledError();
      if (j.cancelled) throw cancelledError();
      const res = await fetchFn(asset.url, {
        headers: {
          "User-Agent": userAgent,
          Accept: asset.acceptHeader ?? "*/*",
        },
        redirect: "follow",
        signal: AbortSignal.any([
          j.controller.signal,
          AbortSignal.timeout(requestTimeoutMs),
        ]),
      });
      if (res.ok) {
        return {
          status: res.status,
          data: Buffer.from(await res.arrayBuffer()),
        };
      }
      if (res.status === 404) {
        await discardBody(res);
        return { status: 404, data: null };
      }
      const rateLimited = res.status === 429 || res.status === 503;
      if (rateLimited) {
        escalatePenalty(
          hostOf(asset.url),
          parseRetryAfter(res.headers, nowFn()),
        );
      }
      const err = new Error(`HTTP ${res.status}`);
      err.permanent = !(rateLimited || res.status >= 500);
      err.rateLimited = rateLimited;
      throw err;
    });
  }

  /**
   * The symbol-asset phase of a job (BATHYMETRY.md STEP 9): drains all
   * asset requests concurrently with tiles, delivering one result object per
   * request to `j.onAssetResult` (which stores the body or records the
   * skip). `j.assets` is either an array or a supplier function called
   * until it yields null (the plugin plans sprites/fonts from the style
   * that the phase itself just fetched). When consecutive assets
   * exhaust their retries (dead network), the phase stops early so
   * tiles are never blocked. The terminal `{status: "done"}` result
   * lets the caller finalize its asset state either way.
   *
   * @param {object} j - The running job
   */
  async function runAssets(j) {
    const nextAsset = () =>
      typeof j.assets === "function" ? j.assets() : j.assets.shift();
    let consecutiveFailures = 0;
    try {
      for (;;) {
        if (j.cancelled) return;
        const asset = nextAsset();
        if (asset == null) break;
        if (
          !(await awaitThrottle(
            j,
            hostOf(asset.url),
            () => j.cancelled || j.wakeRequested,
          ))
        )
          return;
        let result;
        try {
          result = await fetchAsset(j, asset, j.forceOnMetered);
          if (j.cancelled) return;
        } catch (err) {
          if (j.cancelled) return;
          result = { status: "error", data: null, error: err.message };
        }
        if (result.status === "error") {
          consecutiveFailures += 1;
        } else {
          consecutiveFailures = 0;
          if (result.status !== 404) clearPenalty(hostOf(asset.url));
        }
        if (j.onAssetResult) await j.onAssetResult(asset, result);
        onProgress();
        if (consecutiveFailures >= MAX_CONSECUTIVE_ASSET_FAILURES) {
          // Best-effort assets: stop burning retries and let tiles
          // proceed. Array-based plans get explicit skipped results so
          // the caller's accounting closes; supplier functions simply
          // stop being pulled.
          log(
            `${consecutiveFailures} consecutive asset failures; skipping remaining asset fetches`,
          );
          if (Array.isArray(j.assets)) {
            for (const skipped of j.assets.splice(0)) {
              if (j.onAssetResult) {
                await j.onAssetResult(skipped, {
                  status: "skipped",
                  data: null,
                });
              }
            }
          }
          return;
        }
      }
    } finally {
      if (j.onAssetResult) {
        await j.onAssetResult(null, {
          status: "done",
          data: null,
          cancelled: j.cancelled,
        });
      }
    }
  }

  /**
   * The background worker loop. Runs detached; state changes are
   * observable through `status()` and `onProgress`. Symbol assets
   * mirror concurrently with tiles (never blocking them); recovery
   * tiles (`j.priority`) always drain before remaining passage tiles;
   * passage tiles blocked by the circuit breaker are deferred while
   * allowed recovery work proceeds. Job state settles only when tiles,
   * assets, and recovery all drain.
   *
   * @param {object} j - The running job
   */
  async function runJob(j) {
    const stats = j.stats;
    // Assets (style, sprites, fonts) mirror concurrently with tiles
    // (BATHYMETRY.md STEP 9: "NEVER block the tile job"). The style is
    // the first asset fetched so the transform route lights up within
    // a second; sprites and font glyph ranges (256 per stack — the
    // upstream answers 200 for every range, so 3 stacks = 768 requests)
    // drain in the background through the same throttle/suspend loop.
    // The job settles only after BOTH tiles and assets have drained.
    let assetPromise = null;
    try {
      if (j.assets != null) {
        assetPromise = runAssets(j);
      }

      let passageIdx = 0;
      /** Per-tile count of rate-limit deferrals, for the give-up cap. */
      const rateLimitWaits = new Map();
      /** Passage tiles deferred by the circuit breaker. */
      const deferred = [];
      /** Tiles deferred because their host is rate-limited: `{tile, recovery, host}`. */
      const throttled = [];

      /**
       * The request host for a tile ("" when its source has no URL
       * template, so it is never deferred as rate-limited).
       */
      const hostOfTile = (tile) => {
        try {
          return hostOf(tileUrl(tile));
        } catch {
          return "";
        }
      };

      /**
       * Pulls the next tile whose host is NOT currently rate-limited,
       * deferring penalized-host tiles to `throttled` so a throttled
       * server A doesn't block tiles available from server B. Cached
       * tiles are counted and skipped here (no HTTP, no host concern).
       * Recovery tiles drain before passage, then connectivity-deferred.
       * Returns `{tile, host}` to process, or null when every remaining
       * tile sits on a penalized host (caller then waits for the
       * nearest penalty to lift) or nothing remains.
       */
      const nextFetchable = () => {
        // Re-queue throttled tiles whose host penalty has expired,
        // preserving recovery priority.
        for (let i = throttled.length - 1; i >= 0; i--) {
          const e = throttled[i];
          if (penaltyRemainingFor(e.host) === 0) {
            throttled.splice(i, 1);
            if (e.recovery) {
              j.priority.unshift(e.tile);
              j.priorityKeys.add(tileKey(e.tile));
            } else {
              deferred.unshift(e.tile);
            }
          }
        }

        const drain = (shift) => {
          for (;;) {
            const t = shift();
            if (!t) return null;
            // Writes route by source: each tileset has its own file.
            const store = storeFor(sourceOf(t));
            // Already cached (e.g. a previous corridor overlapped):
            // count and move on without an HTTP request or delay.
            if (store.hasTile(t.z, t.x, t.yTms)) {
              stats.skipped += 1;
              const key = sourceOf(t);
              stats.bySource[key] ??= blankSourceStats();
              stats.bySource[key].skipped += 1;
              onProgress();
              continue;
            }
            const host = hostOfTile(t);
            if (penaltyRemainingFor(host) > 0) {
              throttled.push({ tile: t, recovery: !!t.recovery, host });
              continue;
            }
            return { tile: t, host };
          }
        };

        return (
          drain(() => {
            if (j.priority.length === 0) return null;
            const t = j.priority.shift();
            j.priorityKeys.delete(tileKey(t));
            return t;
          }) ||
          drain(() =>
            passageIdx < j.tiles.length ? j.tiles[passageIdx++] : null,
          ) ||
          drain(() => (deferred.length > 0 ? deferred.shift() : null))
        );
      };

      for (;;) {
        if (j.cancelled) break;

        const work = nextFetchable();
        if (!work) {
          if (throttled.length > 0) {
            // Every remaining tile is on a penalized host. Wait for
            // the nearest penalty to lift (not the max): the soonest
            // one unblocks fetchable work. Interruptible by cancel/wake.
            let nearest = Infinity;
            for (const e of throttled) {
              const r = penaltyRemainingFor(e.host);
              if (r > 0 && r < nearest) nearest = r;
            }
            // Always yield a real sleep when tiles are deferred: a
            // 0/Infinity nearest (clock skew or a zero-duration
            // penalty) would otherwise busy-spin and starve the event
            // loop. Fall back to a short backoff in that edge case.
            const wait = nearest > 0 && nearest !== Infinity ? nearest : 1000;
            // Consume a pending wake before sleeping. wakeRequested
            // left set makes sleepFn's isCancelled gate true, so the
            // sleep resolves at once and this `await sleep; continue;`
            // loop would spin — starving the event loop (no HTTP
            // served) for as long as the penalty lasts. A wake while a
            // host is penalized is useless anyway (the penalty is
            // time-based, not connectivity-based), so drain it and let
            // the sleep run. waitSuspend resets it the same way.
            j.wakeRequested = false;
            await sleepFn(wait, () => j.cancelled || j.wakeRequested);
            if (j.cancelled) break;
            continue;
          }
          break;
        }

        const { tile, host } = work;
        const allowMetered = allowMeteredFor(j, tile);
        if (blocked(getInternetState(), allowMetered)) {
          // Park the tile and wait; wake() or newly queued recovery
          // tiles bring us back to re-scan the queues. Only passage
          // parks re-scan on queued recovery work — a parked recovery
          // tile shares its own policy, so it just waits for the
          // connectivity state to clear.
          if (tile.recovery) {
            j.priority.unshift(tile);
            j.priorityKeys.add(tileKey(tile));
            if (!(await waitSuspend(j, allowMetered, false))) break;
          } else {
            deferred.unshift(tile);
            if (!(await waitSuspend(j, allowMetered, true))) break;
          }
          continue;
        }

        const store = storeFor(sourceOf(tile));

        try {
          if (
            !(await awaitThrottle(
              j,
              host,
              () => j.cancelled || j.wakeRequested,
            ))
          )
            break;
          const data = await fetchTile(j, tile, allowMetered);
          if (j.cancelled) break;
          if (store.insertTile(tile.z, tile.x, tile.yTms, data)) {
            onTileStored?.(tile);
          }
          stats.completed += 1;
          {
            const key = sourceOf(tile);
            stats.bySource[key] ??= blankSourceStats();
            stats.bySource[key].completed += 1;
          }
          // A successful fetch clears the host's rate-limit penalty.
          clearPenalty(host);
          rateLimitWaits.delete(tileKey(tile));
        } catch (err) {
          if (j.cancelled) break;
          if (err.rateLimited) {
            // The host is now penalized. Defer this tile (not fail it)
            // so the loop keeps fetching from other (unpenalized)
            // hosts meanwhile; nextFetchable re-queues it once the
            // penalty lifts. Fail it only after the cap, so a
            // permanently rate-limited tile doesn't loop forever.
            const tk = tileKey(tile);
            const waits = (rateLimitWaits.get(tk) || 0) + 1;
            if (waits > MAX_RATE_LIMIT_WAITS) {
              rateLimitWaits.delete(tk);
              stats.failed += 1;
              {
                const key = sourceOf(tile);
                stats.bySource[key] ??= blankSourceStats();
                stats.bySource[key].failed += 1;
              }
              log(
                `tile ${tile.z}/${tile.x}/${tile.y} failed: ${err.message} (gave up after ${waits} penalty waits)`,
              );
            } else {
              rateLimitWaits.set(tk, waits);
              throttled.push({ tile, recovery: !!tile.recovery, host });
            }
          } else if (err.skip) {
            // Regional coverage gap: skipped, never a job failure
            stats.skipped += 1;
            {
              const key = sourceOf(tile);
              stats.bySource[key] ??= blankSourceStats();
              stats.bySource[key].skipped += 1;
            }
            log(`tile ${tile.z}/${tile.x}/${tile.y} skipped: ${err.message}`);
          } else {
            stats.failed += 1;
            {
              const key = sourceOf(tile);
              stats.bySource[key] ??= blankSourceStats();
              stats.bySource[key].failed += 1;
            }
            log(`tile ${tile.z}/${tile.x}/${tile.y} failed: ${err.message}`);
          }
        }

        onProgress();
      }
    } finally {
      // Wait for the background asset phase to drain before settling —
      // the job is not finished until both tiles and assets are done.
      if (assetPromise) await assetPromise;
      j.running = false;
      penaltyByHost.clear();
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
   * passage download is never blocked by the safety cache. Symbol
   * assets (`meta.assets`), when given, mirror concurrently with tiles
   * (never blocking the tile job; BATHYMETRY.md STEP 9).
   *
   * @param {Array<{z: number, x: number, y: number, yTms: number, source?: string}>} tiles
   * @param {{routeName?: string|null, forceOnMetered?: boolean, assets?: Array, onAssetResult?: Function}} [meta]
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
    const bySource = countBySource(tiles);
    for (const t of carry) {
      const key = sourceOf(t);
      bySource[key] ??= blankSourceStats();
      bySource[key].totalQueued += 1;
    }
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
      assets: Array.isArray(meta.assets)
        ? meta.assets.slice()
        : typeof meta.assets === "function"
          ? meta.assets
          : null,
      onAssetResult:
        typeof meta.onAssetResult === "function" ? meta.onAssetResult : null,
      stats: {
        state: "downloading",
        jobType: "passage",
        totalQueued: tiles.length + carry.length,
        bySource,
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
   * @param {Array<{z: number, x: number, y: number, yTms: number, source?: string}>} tiles
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
        const key = sourceOf(t);
        job.stats.bySource[key] ??= blankSourceStats();
        job.stats.bySource[key].totalQueued += 1;
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
      assets: null,
      onAssetResult: null,
      stats: {
        state: "downloading",
        jobType: "recovery",
        totalQueued: marked.length,
        bySource: countBySource(marked),
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
   * Requests cancellation: aborts the in-flight fetch (tile or asset)
   * and flags the loop to exit before the next item.
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
   * `jobType` distinguishes passage from recovery jobs,
   * `recoveryPending` counts queued recovery tiles, and `bySource`
   * breaks the counts down per tileset (top-level totals are the sums).
   *
   * @returns {object}
   */
  function status() {
    const base = {
      isDownloading: false,
      state: "idle",
      jobType: null,
      totalQueued: 0,
      bySource: {},
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
    const bySource = {};
    for (const [id, counts] of Object.entries(s.bySource)) {
      bySource[id] = { ...counts };
    }
    const out = {
      ...base,
      isDownloading: job.running,
      state: s.state,
      jobType: s.jobType,
      totalQueued: s.totalQueued,
      bySource,
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
      throttleMs: statusThrottleMs(s.bySource),
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
  hostOf,
  isMvtBody,
  isPngBody,
  isWebpBody,
  parseRetryAfter,
  preparePbfBody,
  preparePngBody,
  prepareWebpBody,
  readVarint,
  tileKey,
  DEFAULT_SOURCE,
  EMPTY_PBF,
  GZIP_MAGIC,
  MAX_CONSECUTIVE_ASSET_FAILURES,
  MIN_PNG_BYTES,
  PNG_SIGNATURE,
  RATE_LIMIT_PENALTY_BASE_MS,
  RATE_LIMIT_PENALTY_MAX_MS,
  SUSPEND_POLL_MS,
  TILE_FORMATS,
};
