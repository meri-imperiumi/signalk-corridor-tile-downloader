/**
 * Signal K Corridor Tile Downloader plugin.
 *
 * Pre-caches marine tile corridors (OpenStreetMap / OpenSeaMap) along
 * the active route — or a custom target — into a standard MBTiles file
 * that `signalk-charts-provider-simple` serves to Freeboard SK for
 * offline navigation. This plugin is strictly a data producer.
 * Passage jobs are journaled and resume automatically after restarts.
 *
 * REST API (mounted at /plugins/signalk-corridor-tile-downloader):
 *   GET  /status              queue + cache snapshot
 *   POST /fetch-active-route  corridor for navigation.course.activeRoute
 *   POST /fetch-target        corridor for a posted coordinate list
 *   POST /cancel              abort the running job
 *   POST /vacuum              VACUUM the mbtiles database
 *
 * @file index.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { bubbleTiles, corridorTiles, distanceNM } = require("./lib/geometry.js");
const { MbTilesStore, nodeSupportsSqlite } = require("./lib/mbtiles.js");
const { createDownloader } = require("./lib/downloader.js");

/** Plugin identifier (package name). */
const PLUGIN_ID = "signalk-corridor-tile-downloader";

/** Default output inside the directory watched by charts-provider-simple. */
const DEFAULT_OUTPUT_PATH = "~/.signalk/charts-simple/passage_cache.mbtiles";

/**
 * Supported seamark overlay providers (SPEC Addendum 6, vector
 * follow-up). Each entry defines the default slippy URL template and
 * its tile format profile:
 *
 * - Open Waters Seamap serves Mapbox Vector Tiles (`.pbf`, zooms 0-14).
 *   Bodies are validated as protobuf, stored gzip-compressed, and the
 *   MBTiles `format` metadata is set to `pbf` so charts-provider-simple
 *   serves them as `application/x-protobuf` for MapLibre clients.
 * - OpenSeaMap serves raster PNGs (`format=png`).
 *
 * Custom raster or vector sources can be used through the custom
 * `tileServerUrl` template; a `.pbf` template selects the vector
 * profile automatically.
 */
const TILE_PROVIDERS = {
  "Open Waters Seamap": {
    urlTemplate: "https://tiles.openwaters.io/seamap/{z}/{x}/{y}.pbf",
    format: "pbf",
    vectorLayers: [
      "land",
      "light",
      "sea_area",
      "seamark",
      "water",
      "waterway",
      "wetland",
    ],
    maxZoom: 14,
  },
  OpenSeaMap: {
    urlTemplate: "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
    format: "png",
  },
};

const DEFAULT_TILE_PROVIDER = "Open Waters Seamap";

/**
 * Infers the tile format profile from a slippy URL template: a `.pbf`
 * path segment selects the vector profile, anything else the raster
 * one. Used for custom tile server URLs where no provider entry
 * applies.
 *
 * @param {string} urlTemplate
 * @returns {"png"|"pbf"}
 */
function formatForUrlTemplate(urlTemplate) {
  return /^https?:\/\/.*\{y\}\.pbf(?:\?.*)?$/.test(urlTemplate) ? "pbf" : "png";
}

/**
 * Retired default templates, mapped to their provider: a saved config
 * naming one follows the provider selection (and its current default)
 * instead of clinging to the dead endpoint as a "custom" URL.
 */
const RETIRED_URL_TEMPLATES = new Map([
  ["https://tiles.openwaters.io/seamap/{z}/{x}/{y}.png", "Open Waters Seamap"],
]);

/**
 * Finds the provider whose default URL template matches the given
 * stored value, so a saved template that merely mirrors a provider
 * default (current or retired) keeps following the provider selection
 * instead of being mistaken for a custom override.
 *
 * @param {string} urlTemplate
 * @returns {string|null} Provider name
 */
function providerForUrlTemplate(urlTemplate) {
  for (const [name, provider] of Object.entries(TILE_PROVIDERS)) {
    if (provider.urlTemplate === urlTemplate) return name;
  }
  return RETIRED_URL_TEMPLATES.get(urlTemplate) ?? null;
}

const DEFAULT_USER_AGENT = "SignalK-Corridor-Downloader/1.0";

/**
 * Multi-tier corridor margins (SPEC Addendum 1): strategic swath for
 * zooms <= 10, tactical swath for 11-13, approach rings for >= 14.
 */
const DEFAULT_STRATEGIC_MARGIN_NM = 50;
const DEFAULT_TACTICAL_MARGIN_NM = 15;
const DEFAULT_APPROACH_RADIUS_NM = 3;

/**
 * JIT position recovery (SPEC Addendum 5): safety-bubble radii per
 * zoom band, and the distance a position must move before the cache
 * is re-verified.
 */
const RECOVERY_TRIGGER_NM = 1;
const RECOVERY_BANDS = [
  { minZoom: 8, maxZoom: 12, radiusNM: 5 },
  { minZoom: 13, maxZoom: 14, radiusNM: 2 },
];

/**
 * Safety valve: refuse to queue absurdly large corridor jobs (e.g. a
 * transoceanic route at z17 with a huge margin) that would take weeks
 * to download. The client can narrow zoom or margin and retry.
 */
const MAX_QUEUE_SIZE = 500000;

/**
 * Restart journal (crash-safe resume): passage jobs are persisted as
 * their *intent* — coordinates, geometry snapshot, metered override —
 * rather than as tile lists. Rebuilding the corridor on the next
 * start() and filtering against the MBTiles cache (`hasTile`) yields
 * exactly the tiles the interrupted job still lacked.
 */
const PENDING_JOB_VERSION = 1;
const PENDING_JOB_FILENAME = "pending-job.json";

/** The consumer plugin that serves our tiles to Freeboard SK. */
const CHARTS_PROVIDER_ID = "signalk-charts-provider-simple";

/**
 * In-process refresh hook published by charts-provider-simple on
 * globalThis (same pattern as signalk-container's manager global).
 */
const CHARTS_REFRESH_GLOBAL = "__signalk_chartsProviderRefresh";

/**
 * Expands a leading `~/` to the user's home directory.
 *
 * @param {string} p - Path, possibly starting with `~/`
 * @returns {string} Absolute path
 */
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Normalizes plugin configuration, applying defaults and clamps.
 *
 * Tile provider resolution (SPEC Addendum 6): an explicit
 * `tileProvider` selection drives the default URL template, its tile
 * format profile (`pbf` vector for Open Waters Seamap, `png` raster
 * for OpenSeaMap) and — for the vector provider — the source-layer ids
 * advertised to MapLibre clients through the MBTiles `vector_layers`
 * metadata. A `tileServerUrl` that is empty or equal to any provider
 * default is "derived" and follows the selection; anything else is a
 * custom override whose format is inferred from the template (a
 * `{y}.pbf` path is vector). The vector provider's native zoom ceiling
 * (14) clamps the configured maxZoom when its default URL is in use.
 *
 * @param {object} [options] - Raw configuration from the admin UI
 * @returns {object} Resolved configuration
 */
function resolveConfig(options = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  let minZoom = Math.trunc(num(options.minZoom, 8));
  let maxZoom = Math.trunc(num(options.maxZoom, 14));
  minZoom = Math.min(22, Math.max(0, minZoom));
  maxZoom = Math.min(22, Math.max(0, maxZoom));
  if (minZoom > maxZoom) [minZoom, maxZoom] = [maxZoom, minZoom];

  const storedUrl = String(options.tileServerUrl || "").trim();
  const tileProvider =
    TILE_PROVIDERS[options.tileProvider] != null
      ? options.tileProvider
      : (providerForUrlTemplate(storedUrl) ?? DEFAULT_TILE_PROVIDER);

  // A stored template that mirrors a provider default is derived, not
  // custom: it follows the provider selection (SPEC Addendum 6).
  const isCustomUrl =
    storedUrl !== "" && providerForUrlTemplate(storedUrl) == null;
  const provider = TILE_PROVIDERS[tileProvider];
  let tileServerUrl = isCustomUrl ? storedUrl : provider.urlTemplate;
  if (
    !tileServerUrl.includes("{z}") ||
    !tileServerUrl.includes("{x}") ||
    !tileServerUrl.includes("{y}")
  ) {
    tileServerUrl = provider.urlTemplate;
  }

  const format = isCustomUrl
    ? formatForUrlTemplate(tileServerUrl)
    : provider.format;
  const vectorLayers =
    !isCustomUrl && format === "pbf" ? provider.vectorLayers : null;
  if (!isCustomUrl && provider.maxZoom != null) {
    maxZoom = Math.min(maxZoom, provider.maxZoom);
    if (minZoom > maxZoom) minZoom = maxZoom;
  }

  return {
    outputPath: expandHome(String(options.outputPath || DEFAULT_OUTPUT_PATH)),
    strategicMarginNM: Math.max(
      0,
      num(options.strategicMarginNM, DEFAULT_STRATEGIC_MARGIN_NM),
    ),
    tacticalMarginNM: Math.max(
      0,
      num(options.tacticalMarginNM, DEFAULT_TACTICAL_MARGIN_NM),
    ),
    approachRadiusNM: Math.max(
      0,
      num(options.approachRadiusNM, DEFAULT_APPROACH_RADIUS_NM),
    ),
    minZoom,
    maxZoom,
    throttleMs: Math.max(0, Math.trunc(num(options.throttleMs, 500))),
    allowRecoveryOnMetered: options.allowRecoveryOnMetered !== false,
    tileProvider,
    tileServerUrl,
    format,
    vectorLayers,
    userAgent: String(options.userAgent || DEFAULT_USER_AGENT),
  };
}

/**
 * HTTP-facing error carrying a status code.
 *
 * @param {number} status - HTTP status code
 * @param {string} message
 * @returns {Error}
 */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Is the parsed restart journal a well-formed job intent? Hand-edited,
 * corrupt, or future-version files are discarded, never trusted.
 *
 * @param {object|null} intent
 * @returns {boolean}
 */
function isValidPendingJob(intent) {
  if (intent == null || typeof intent !== "object") return false;
  if (intent.version !== PENDING_JOB_VERSION) return false;
  if (typeof intent.outputPath !== "string" || intent.outputPath === "") {
    return false;
  }
  if (typeof intent.routeName !== "string" || intent.routeName === "") {
    return false;
  }
  if (typeof intent.forceOnMetered !== "boolean") return false;
  const zoomOk = (z) => Number.isInteger(z) && z >= 0 && z <= 22;
  if (!zoomOk(intent.minZoom) || !zoomOk(intent.maxZoom)) return false;
  const marginOk = (v) => Number.isFinite(v) && v >= 0;
  if (
    !marginOk(intent.strategicMarginNM) ||
    !marginOk(intent.tacticalMarginNM) ||
    !marginOk(intent.approachRadiusNM)
  ) {
    return false;
  }
  if (!Array.isArray(intent.coordinates) || intent.coordinates.length === 0) {
    return false;
  }
  return intent.coordinates.every(
    (c) =>
      c != null &&
      typeof c === "object" &&
      Number.isFinite(c.lat) &&
      Number.isFinite(c.lon) &&
      c.lat >= -90 &&
      c.lat <= 90 &&
      c.lon >= -180 &&
      c.lon <= 180,
  );
}

/**
 * @param {ServerAPI} app - Signal K server API
 * @returns {Plugin}
 */
module.exports = (app) => {
  const setStatus = (app.setPluginStatus || app.setProviderStatus)?.bind(app);
  const setError = app.setPluginError?.bind(app);

  /** @type {MbTilesStore|null} */
  let store = null;
  let downloader = null;
  let lastRouteName = null;
  let config = null;
  /** Last position the recovery cache was verified against. */
  let lastCheckedPosition = null;
  const unsubscribes = [];
  /** Chart-provider refresh callback (injectable for tests). */
  let notifyChartsProvider = defaultNotifyChartsProvider;

  const plugin = {
    id: PLUGIN_ID,
    name: "Corridor Tile Downloader",
    description:
      "Pre-cache marine tile corridors along your route into MBTiles for offline navigation",

    schema: {
      type: "object",
      properties: {
        outputPath: {
          type: "string",
          title: "Output path",
          description:
            "Absolute path of the .mbtiles file. Must live in the charts directory watched by signalk-charts-provider-simple (default ~/.signalk/charts-simple). A leading ~/ expands to the server user's home. New tiles are picked up automatically when the provider supports refresh; otherwise restart it once after the first fetch.",
          default: DEFAULT_OUTPUT_PATH,
        },
        strategicMarginNM: {
          type: "number",
          title: "Strategic margin (NM)",
          description:
            "Corridor buffer for low zooms (8-10): broad coverage for weather routing and major deviations",
          default: DEFAULT_STRATEGIC_MARGIN_NM,
        },
        tacticalMarginNM: {
          type: "number",
          title: "Tactical margin (NM)",
          description:
            "Corridor buffer for mid zooms (11-13): standard tacking and current offsets",
          default: DEFAULT_TACTICAL_MARGIN_NM,
        },
        approachRadiusNM: {
          type: "number",
          title: "Approach radius (NM)",
          description:
            "Radius for high zooms (14+), fetched only around the route's start and end points for reef and anchorage detail",
          default: DEFAULT_APPROACH_RADIUS_NM,
        },
        minZoom: {
          type: "integer",
          title: "Minimum zoom",
          default: 8,
        },
        maxZoom: {
          type: "integer",
          title: "Maximum zoom",
          description:
            "Clamped to the provider's native ceiling (Open Waters Seamap serves up to z14)",
          default: 14,
        },
        throttleMs: {
          type: "integer",
          title: "Throttle (ms between requests)",
          description:
            "Delay between HTTP tile requests, to stay polite to public tile servers",
          default: 500,
        },
        tileProvider: {
          type: "string",
          title: "Tile provider",
          description:
            "Open Waters Seamap serves vector .pbf tiles (MapLibre clients, format=pbf, native zooms 0-14); OpenSeaMap serves the raster PNG overlay. The tile format must match the cache file: switching formats on a filled cache is rejected until you pick a new output path",
          enum: ["Open Waters Seamap", "OpenSeaMap"],
          default: DEFAULT_TILE_PROVIDER,
        },
        tileServerUrl: {
          type: "string",
          title: "Custom tile server URL template",
          description:
            "Optional slippy tile URL with {z}/{x}/{y} placeholders. Leave empty to follow the selected provider's default URL. A template ending in {y}.pbf is treated as a vector source (format=pbf)",
          default: "",
        },
        userAgent: {
          type: "string",
          title: "User-Agent header",
          default: DEFAULT_USER_AGENT,
        },
        allowRecoveryOnMetered: {
          type: "boolean",
          title: "Allow recovery fetches on metered connections",
          description:
            "When enabled, the just-in-time safety bubble around the vessel's position is also fetched on metered links (e.g. satellite). Passage corridor downloads still wait for your approval.",
          default: true,
        },
      },
    },

    start: (options) => {
      config = resolveConfig(options);

      if (!nodeSupportsSqlite()) {
        const message = `requires Node.js >= 22.5.0 for node:sqlite (running ${process.versions.node})`;
        setError?.(message);
        app.error(`${PLUGIN_ID}: ${message}`);
        return;
      }

      // The tile store opens lazily on first use and is released when a
      // job settles: charts-provider-simple's startup housekeeping deletes
      // `*.mbtiles-wal` sidecars and bounds-less .mbtiles files, so an
      // idle downloader must leave neither on disk.

      // Test hooks (`fetch`, `sleep`, `notify`) ride along in the raw
      // options, mirroring the injectable-probe pattern; absent in
      // production.
      notifyChartsProvider =
        typeof options?.notify === "function"
          ? options.notify
          : defaultNotifyChartsProvider;
      downloader = createDownloader({
        getStore: () => store,
        tileServerUrl: config.tileServerUrl,
        format: config.format,
        userAgent: config.userAgent,
        throttleMs: config.throttleMs,
        allowRecoveryOnMetered: config.allowRecoveryOnMetered,
        fetchFn: options?.fetch,
        sleepFn: options?.sleep,
        getInternetState,
        log: (m) => app.debug(`${PLUGIN_ID}: ${m}`),
        onProgress: () => publishStatus(),
        onSettled: (stats) => {
          // A naturally completed passage job retires its restart
          // journal; a job cancelled by stop() keeps its journal so the
          // next start() resumes it.
          if (stats.state === "completed" && !stats.isRecovery) {
            clearPendingJob();
          }
          // Charts landed in the file: ask the consumer to rescan so the
          // corridor shows up in Freeboard without a provider restart.
          if (stats.completed > 0) {
            notifyChartsProvider();
          }
        },
      });

      // Reconcile sidecars wedged by an earlier provider housekeeping
      // strike before any reader (or resumed job) touches the cache.
      sweepStaleSidecars();

      subscribeToDeltas();

      // Crash-safe resume: restart any passage job journaled before
      // the last shutdown.
      resumePendingJob();

      publishStatus();
    },

    stop: () => {
      for (const unsubscribe of unsubscribes) {
        try {
          unsubscribe();
        } catch {
          // Already unsubscribed
        }
      }
      unsubscribes.length = 0;
      downloader?.cancel();
      downloader = null;
      store?.close();
      store = null;
      lastCheckedPosition = null;
      setStatus?.("Corridor downloader stopped");
    },
  };

  /**
   * Sweeps stale WAL sidecars left around the cache file by an earlier
   * charts-provider-simple housekeeping strike. A wedged `-shm`/`-wal`
   * pair (stale wal-index referencing a deleted or emptied WAL) fails
   * every read-only open — the provider's chart-metadata endpoint —
   * with `disk I/O error` until a read-write connection reconciles the
   * index. Opening and closing our store does exactly that, and the
   * clean close checkpoints and removes the sidecars. No-op when no
   * sidecars linger.
   */
  function sweepStaleSidecars() {
    const wal = `${config.outputPath}-wal`;
    const shm = `${config.outputPath}-shm`;
    if (!fs.existsSync(wal) && !fs.existsSync(shm)) return;
    if (!fs.existsSync(config.outputPath)) return;
    try {
      ensureStore();
      releaseStoreIfIdle();
      app.debug(
        `${PLUGIN_ID}: reconciled stale WAL sidecars at ${config.outputPath}`,
      );
    } catch (err) {
      app.error(
        `${PLUGIN_ID}: cannot reconcile stale WAL sidecars: ${err.message}`,
      );
    }
  }

  /**
   * Subscribes to `navigation.position` (JIT recovery triggers) and
   * `network.internet.state` (immediate wake on connectivity
   * transitions, SPEC Addendum 5).
   */
  function subscribeToDeltas() {
    if (!app.subscriptionmanager?.subscribe) return;
    const subscription = {
      context: "vessels.self",
      subscribe: [
        { path: "navigation.position", policy: "instant" },
        { path: "network.internet.state", policy: "instant" },
      ],
    };
    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (err) =>
        app.error(`${PLUGIN_ID}: subscription error: ${err.message ?? err}`),
      (delta) => handleDelta(delta),
    );
  }

  /**
   * Dispatches subscribed deltas to the recovery and wake handlers.
   *
   * @param {object} delta - Signal K delta
   */
  function handleDelta(delta) {
    if (!delta?.updates) return;
    for (const update of delta.updates) {
      if (!update.values) continue;
      for (const value of update.values) {
        if (value.path === "navigation.position") {
          handlePositionValue(value.value);
        } else if (value.path === "network.internet.state") {
          // Wake the loop immediately on a connectivity transition
          // instead of waiting out the 10 s suspend poll.
          downloader?.wake();
        }
      }
    }
  }

  /**
   * Handles a navigation.position value: verifies the recovery cache
   * once the vessel has moved more than 1 NM (Haversine) from the last
   * checked position (SPEC Addendum 5). The first fix after startup
   * only establishes the baseline.
   *
   * @param {unknown} value - `{latitude, longitude}` position value
   */
  function handlePositionValue(value) {
    if (!downloader) return;
    if (!value || typeof value !== "object") return;
    const position = {
      lat: Number(value.latitude),
      lon: Number(value.longitude),
    };
    if (
      !Number.isFinite(position.lat) ||
      !Number.isFinite(position.lon) ||
      position.lat < -90 ||
      position.lat > 90 ||
      position.lon < -180 ||
      position.lon > 180
    ) {
      return;
    }
    if (lastCheckedPosition === null) {
      // The first fix after startup only establishes the baseline:
      // verification requires actual movement (SPEC Addendum 5).
      lastCheckedPosition = position;
      return;
    }
    if (distanceNM(lastCheckedPosition, position) < RECOVERY_TRIGGER_NM) {
      return;
    }
    lastCheckedPosition = position;
    verifyRecoveryCache(position);
  }

  /**
   * Opens (or reuses) the tile store on demand, honoring configuration
   * changes to `outputPath`.
   *
   * @returns {MbTilesStore}
   * @throws When the database cannot be opened
   */
  function ensureStore() {
    if (store && store.filePath === config.outputPath) return store;
    store?.close();
    store = null;
    store = new MbTilesStore(config.outputPath);
    return store;
  }

  /**
   * Closes the tile store when no job is using it, so no live
   * `*.mbtiles-wal` sidecar sits on disk while idle (see start()).
   */
  function releaseStoreIfIdle() {
    if (store && !downloader?.status().isDownloading) {
      store.close();
      store = null;
    }
  }

  /**
   * Path of the restart journal inside the plugin data directory, or
   * null when the server exposes no data directory (persistence off).
   *
   * @returns {string|null}
   */
  function pendingJobPath() {
    const dataDir = app.getDataDirPath?.();
    return typeof dataDir === "string" && dataDir !== ""
      ? path.join(dataDir, PENDING_JOB_FILENAME)
      : null;
  }

  /**
   * Is a passage job journaled on disk right now?
   *
   * @returns {boolean}
   */
  function hasPendingJob() {
    const file = pendingJobPath();
    return file != null && fs.existsSync(file);
  }

  /**
   * Persists the intent of a starting passage job so the next start()
   * can resume it after a shutdown or crash. Best-effort: a failed
   * write never blocks the download itself.
   *
   * @param {object} intent - Validated job intent
   */
  function persistPendingJob(intent) {
    const file = pendingJobPath();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(intent)}\n`);
    } catch (err) {
      app.error(`${PLUGIN_ID}: cannot journal pending job: ${err.message}`);
    }
  }

  /**
   * Reads the restart journal. A missing file yields null; a corrupt
   * or invalid one is discarded with an error log.
   *
   * @returns {object|null} Job intent
   */
  function readPendingJob() {
    const file = pendingJobPath();
    if (!file) return null;
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return null; // No journal: nothing to resume
    }
    let intent = null;
    try {
      intent = JSON.parse(raw);
    } catch {
      // Corrupt file falls through to the discard below
    }
    if (isValidPendingJob(intent)) return intent;
    app.error(`${PLUGIN_ID}: discarding invalid restart journal ${file}`);
    clearPendingJob();
    return null;
  }

  /**
   * Removes the restart journal (job settled, user cancelled, or the
   * journal was invalid). A missing file is not an error.
   */
  function clearPendingJob() {
    const file = pendingJobPath();
    if (!file) return;
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone
    }
  }

  /**
   * Size of the cache file on disk, without opening a database handle.
   *
   * @param {string} filePath
   * @returns {number}
   */
  function fileSizeBytes(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Builds the recovery bubble tiles for a position (5 NM for zooms
   * 8-12, 2 NM for 13-14, clipped to the configured zoom range),
   * checks each against the cache and queues the missing ones into
   * the high-priority recovery queue (SPEC Addendum 5).
   *
   * @param {{lat: number, lon: number}} position
   */
  function verifyRecoveryCache(position) {
    let activeStore;
    try {
      activeStore = ensureStore();
    } catch (err) {
      app.error(
        `${PLUGIN_ID}: cannot open tile store for recovery: ${err.message}`,
      );
      return;
    }

    const tiles = [];
    const seen = new Set();
    for (const band of RECOVERY_BANDS) {
      const minZoom = Math.max(config.minZoom, band.minZoom);
      const maxZoom = Math.min(config.maxZoom, band.maxZoom);
      for (let z = minZoom; z <= maxZoom; z++) {
        for (const tile of bubbleTiles(position, z, band.radiusNM)) {
          const key = `${tile.z}/${tile.x}/${tile.yTms}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tiles.push(tile);
        }
      }
    }

    const missing = tiles.filter(
      (tile) => !activeStore.hasTile(tile.z, tile.x, tile.yTms),
    );
    if (missing.length === 0) {
      app.debug(
        `${PLUGIN_ID}: position recovery cache complete around ${position.lat.toFixed(4)},${position.lon.toFixed(4)}`,
      );
      releaseStoreIfIdle();
      return;
    }

    const queued = downloader.enqueueRecovery(missing, {
      routeName: `Recovery @ ${position.lat.toFixed(3)},${position.lon.toFixed(3)}`,
    });
    if (queued > 0) {
      app.debug(
        `${PLUGIN_ID}: queued ${queued} recovery tiles around ${position.lat.toFixed(4)},${position.lon.toFixed(4)}`,
      );
    }
  }

  /**
   * Reflects queue state into the Signal K admin UI.
   */
  function publishStatus() {
    if (!downloader) {
      setStatus?.("Idle");
      return;
    }
    const s = downloader.status();
    if (s.isDownloading) {
      const label =
        s.jobType === "recovery" ? "Recovery fetch" : "Downloading corridor";
      const done = s.completed + s.skipped;
      const suspended = s.suspended ? " — suspended" : "";
      setStatus?.(
        `${label}: ${done}/${s.totalQueued} tiles (${s.failed} failed)${suspended}`,
      );
    } else if (s.state === "completed") {
      setStatus?.(
        `Corridor complete: ${s.completed} downloaded, ${s.skipped} cached, ${s.failed} failed`,
      );
    } else if (s.state === "cancelled") {
      setStatus?.("Corridor download cancelled");
    } else {
      setStatus?.("Idle");
    }
    // Job settled: release the SQLite handle (and its WAL sidecars).
    if (!s.isDownloading) {
      releaseStoreIfIdle();
    }
  }

  /**
   * Asks signalk-charts-provider-simple to rescan its charts directory
   * so tiles written by this plugin get registered — the provider has
   * no file watcher, so without a rescan a newly created corridor file
   * stays invisible until its next restart. Prefers the in-process
   * globalThis hook (no HTTP round-trip, works with server security
   * enabled); falls back to the provider's POST /refresh endpoint when
   * the port is known. Best-effort: quiet when the provider or its
   * refresh capability is absent (older versions).
   */
  function defaultNotifyChartsProvider() {
    const hook = globalThis[CHARTS_REFRESH_GLOBAL];
    if (typeof hook === "function") {
      hook()
        .then((count) =>
          app.debug(
            `${PLUGIN_ID}: charts provider refreshed (${count} charts)`,
          ),
        )
        .catch((err) =>
          app.debug(
            `${PLUGIN_ID}: charts provider refresh failed: ${err.message}`,
          ),
        );
      return;
    }
    const port = app.config?.settings?.port;
    if (!port) return;
    fetch(`http://127.0.0.1:${port}/plugins/${CHARTS_PROVIDER_ID}/refresh`, {
      method: "POST",
    })
      .then((res) => {
        if (res.ok) {
          app.debug(`${PLUGIN_ID}: charts provider refreshed via REST`);
        } else {
          app.debug(
            `${PLUGIN_ID}: charts provider refresh returned HTTP ${res.status}`,
          );
        }
      })
      .catch((err) =>
        app.debug(
          `${PLUGIN_ID}: charts provider refresh unreachable: ${err.message}`,
        ),
      );
  }

  /**
   * Reads the vessel's connectivity state published by
   * signalk-internet (`network.internet.state`). Returns null when the
   * path is absent so vessels without a connectivity plugin are never
   * suspended.
   *
   * @returns {string|null} online | metered | offline | captive | null
   */
  function getInternetState() {
    const raw = app.getSelfPath?.("network.internet.state.value");
    if (typeof raw === "string") return raw;
    if (raw && typeof raw === "object" && typeof raw.value === "string") {
      return raw.value;
    }
    return null;
  }

  /**
   * Resolves the currently active route from the Signal K tree.
   *
   * @returns {{coordinates: Array<{lat: number, lon: number}>, name: string}|null}
   */
  function getActiveRoute() {
    const hrefNode = app.getSelfPath?.("navigation.course.activeRoute.href");
    const href =
      typeof hrefNode === "object" && hrefNode !== null
        ? hrefNode.value
        : hrefNode;
    if (typeof href !== "string" || href === "") return null;

    const id = decodeURIComponent(href.split("/").filter(Boolean).pop() || "");
    if (!id) return null;

    const node = app.getPath?.(`resources.routes.${id}`);
    const feature =
      node && typeof node === "object"
        ? (node.value ?? node.feature ?? node)
        : null;
    const rawCoordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(rawCoordinates)) return null;

    const coordinates = rawCoordinates
      .map((c) => ({ lon: Number(c?.[0]), lat: Number(c?.[1]) }))
      .filter(
        (c) =>
          Number.isFinite(c.lat) &&
          Number.isFinite(c.lon) &&
          c.lat >= -90 &&
          c.lat <= 90 &&
          c.lon >= -180 &&
          c.lon <= 180,
      );
    if (coordinates.length === 0) return null;

    const name = feature?.properties?.name || id || "Active route";
    return { coordinates, name };
  }

  /**
   * Builds the corridor for a coordinate list, updates MBTiles
   * metadata, filters out already-cached tiles, journals the job
   * intent for restart-safe resume and starts the queue.
   *
   * @param {Array<{lat: number, lon: number}>} coordinates
   * @param {string} routeName - Display name for the job
   * @param {boolean} forceOnMetered - Metered override (SPEC Addendum 4)
   * @param {object} [geometryConfig] - Geometry the corridor is built
   *   from; defaults to the live config. Resume passes the journaled
   *   snapshot so a restarted job keeps its original shape even if
   *   the configuration changed in between.
   * @returns {{totalTiles: number}}
   */
  function startJob(coordinates, routeName, forceOnMetered, geometryConfig) {
    const geometry = geometryConfig ?? config;
    if (!downloader) {
      throw httpError(503, "Downloader not started");
    }
    const running = downloader.status();
    if (running.isDownloading && running.jobType !== "recovery") {
      throw httpError(409, "A download job is already in progress");
    }
    try {
      ensureStore();
    } catch (err) {
      throw httpError(500, `Failed to open tile store: ${err.message}`);
    }

    const { tiles, bounds } = corridorTiles(coordinates, geometry);
    if (tiles.length === 0) {
      throw httpError(400, "No valid coordinates to fetch");
    }
    if (tiles.length > MAX_QUEUE_SIZE) {
      throw httpError(
        413,
        `Corridor of ${tiles.length} tiles exceeds the ${MAX_QUEUE_SIZE} tile limit; reduce zoom range or margin`,
      );
    }

    // One cache file carries one tile format: the consumer plugin picks
    // its Content-Type from the `format` metadata row, so mixing png and
    // pbf blobs would corrupt both. An empty file adopts the active
    // provider's format; a filled one refuses to switch (the user points
    // outputPath at a fresh file instead).
    const storedFormat = store.getMetadata("format");
    if (store.hasAnyTile() && storedFormat !== config.format) {
      throw httpError(
        409,
        `Cache at ${config.outputPath} holds ${storedFormat} tiles, but the ${config.tileProvider} provider downloads ${config.format}; use a different output path for ${config.format} tiles`,
      );
    }
    store.setFormat(config.format);
    if (config.vectorLayers) {
      store.setVectorLayers(config.vectorLayers);
    }

    // API discovery handoff: bounds and zoom range must reflect the
    // corridor before the consumer plugin sees new tiles.
    if (bounds) store.setBounds(bounds);
    store.setZoomLevels(geometry.minZoom, geometry.maxZoom);

    // Skip what we already have so re-runs only fetch the delta.
    const pending = tiles.filter((t) => !store.hasTile(t.z, t.x, t.yTms));

    persistPendingJob({
      version: PENDING_JOB_VERSION,
      outputPath: config.outputPath,
      routeName,
      forceOnMetered: forceOnMetered === true,
      coordinates,
      minZoom: geometry.minZoom,
      maxZoom: geometry.maxZoom,
      strategicMarginNM: geometry.strategicMarginNM,
      tacticalMarginNM: geometry.tacticalMarginNM,
      approachRadiusNM: geometry.approachRadiusNM,
    });

    downloader.start(pending, { routeName, forceOnMetered });
    lastRouteName = routeName;
    return { totalTiles: pending.length };
  }

  /**
   * Resumes a passage job journaled before the last shutdown: the
   * corridor is rebuilt from the journaled intent — not the possibly
   * changed live config — and filtered against the tile cache, so only
   * the tiles the interrupted job still lacked are fetched. A journal
   * targeting a different output file is kept but not resumed: its
   * corridor resumes if the configuration is switched back.
   */
  function resumePendingJob() {
    const intent = readPendingJob();
    if (!intent) return;
    if (path.resolve(intent.outputPath) !== path.resolve(config.outputPath)) {
      app.debug(
        `${PLUGIN_ID}: pending job "${intent.routeName}" targets ${intent.outputPath}; not resuming into ${config.outputPath}`,
      );
      return;
    }
    const geometry = {
      ...config,
      minZoom: intent.minZoom,
      maxZoom: intent.maxZoom,
      strategicMarginNM: intent.strategicMarginNM,
      tacticalMarginNM: intent.tacticalMarginNM,
      approachRadiusNM: intent.approachRadiusNM,
    };
    try {
      startJob(
        intent.coordinates,
        intent.routeName,
        intent.forceOnMetered,
        geometry,
      );
      app.debug(
        `${PLUGIN_ID}: resumed corridor "${intent.routeName}" after restart`,
      );
    } catch (err) {
      app.error(
        `${PLUGIN_ID}: resume of "${intent.routeName}" failed: ${err.message}`,
      );
    }
  }

  /**
   * Parses a JSON request body that Express may or may not have decoded.
   *
   * @param {import("express").Request} req
   * @returns {object}
   */
  function parseBody(req) {
    if (req.body && typeof req.body === "object") return req.body;
    if (typeof req.body === "string" && req.body.length > 0) {
      try {
        return JSON.parse(req.body);
      } catch {
        throw httpError(400, "Invalid JSON body");
      }
    }
    return {};
  }

  /**
   * Sends an error response, mapping httpErrors to their status codes.
   *
   * @param {import("express").Response} res
   * @param {Error} err
   */
  function errorResponse(res, err) {
    if (err.status) {
      res.status(err.status).json({ message: err.message });
      return;
    }
    app.error(`${PLUGIN_ID}: ${err.stack || err.message}`);
    res.status(500).json({ message: err.message });
  }

  plugin.registerWithRouter = (router) => {
    router.get("/status", (_req, res) => {
      res.json({
        ...(downloader
          ? downloader.status()
          : { isDownloading: false, state: "idle" }),
        activeRouteName: lastRouteName,
        tileProvider: config ? config.tileProvider : null,
        format: config ? config.format : null,
        dbSizeBytes: store
          ? store.sizeBytes()
          : fileSizeBytes(config ? config.outputPath : ""),
        outputPath: config ? config.outputPath : null,
        resumable: hasPendingJob(),
      });
    });

    router.post("/fetch-active-route", (req, res) => {
      try {
        const body = parseBody(req);
        const route = getActiveRoute();
        if (!route) {
          throw httpError(404, "No active route found");
        }
        const { totalTiles } = startJob(
          route.coordinates,
          route.name,
          body.forceOnMetered === true,
        );
        res.json({ status: "started", totalTiles });
      } catch (err) {
        errorResponse(res, err);
      }
    });

    router.post("/fetch-target", (req, res) => {
      try {
        const body = parseBody(req);
        if (!Array.isArray(body.coordinates) || body.coordinates.length === 0) {
          throw httpError(
            400,
            "Body must contain a non-empty coordinates array",
          );
        }
        const { totalTiles } = startJob(
          body.coordinates,
          body.name || "Custom target",
          body.forceOnMetered === true,
        );
        res.json({ status: "started", totalTiles });
      } catch (err) {
        errorResponse(res, err);
      }
    });

    router.post("/cancel", (_req, res) => {
      downloader?.cancel();
      // A cancelled corridor must not resurrect after a restart.
      clearPendingJob();
      res.json({ status: "cancelled" });
    });

    router.post("/vacuum", (_req, res) => {
      if (downloader?.status().isDownloading) {
        res
          .status(409)
          .json({ message: "Cannot vacuum while a download is in progress" });
        return;
      }
      try {
        ensureStore().vacuum();
        releaseStoreIfIdle();
        res.json({ status: "vacuum_complete" });
      } catch (err) {
        errorResponse(res, err);
      }
    });
  };

  return plugin;
};

module.exports.PLUGIN_ID = PLUGIN_ID;
module.exports.DEFAULT_OUTPUT_PATH = DEFAULT_OUTPUT_PATH;
module.exports.TILE_PROVIDERS = TILE_PROVIDERS;
module.exports.DEFAULT_TILE_PROVIDER = DEFAULT_TILE_PROVIDER;
module.exports.DEFAULT_USER_AGENT = DEFAULT_USER_AGENT;
module.exports.DEFAULT_STRATEGIC_MARGIN_NM = DEFAULT_STRATEGIC_MARGIN_NM;
module.exports.DEFAULT_TACTICAL_MARGIN_NM = DEFAULT_TACTICAL_MARGIN_NM;
module.exports.DEFAULT_APPROACH_RADIUS_NM = DEFAULT_APPROACH_RADIUS_NM;
module.exports.MAX_QUEUE_SIZE = MAX_QUEUE_SIZE;
module.exports.RECOVERY_TRIGGER_NM = RECOVERY_TRIGGER_NM;
module.exports.RECOVERY_BANDS = RECOVERY_BANDS;
module.exports.PENDING_JOB_VERSION = PENDING_JOB_VERSION;
module.exports.PENDING_JOB_FILENAME = PENDING_JOB_FILENAME;
module.exports.CHARTS_PROVIDER_ID = CHARTS_PROVIDER_ID;
module.exports.CHARTS_REFRESH_GLOBAL = CHARTS_REFRESH_GLOBAL;
module.exports.expandHome = expandHome;
module.exports.resolveConfig = resolveConfig;
module.exports.formatForUrlTemplate = formatForUrlTemplate;
