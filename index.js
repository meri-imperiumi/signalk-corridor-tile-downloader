/**
 * Signal K Corridor Tile Downloader plugin.
 *
 * Pre-caches marine tile corridors (OpenStreetMap / OpenSeaMap) along
 * the active route — or a custom target — into a standard MBTiles file
 * that `signalk-charts-provider-simple` serves to Freeboard SK for
 * offline navigation. This plugin is strictly a data producer.
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
const path = require("node:path");
const { corridorTiles } = require("./lib/geometry.js");
const { MbTilesStore, nodeSupportsSqlite } = require("./lib/mbtiles.js");
const { createDownloader } = require("./lib/downloader.js");

/** Plugin identifier (package name). */
const PLUGIN_ID = "signalk-corridor-tile-downloader";

/** Default output inside the directory watched by charts-provider-simple. */
const DEFAULT_OUTPUT_PATH = "~/.signalk/charts-simple/passage_cache.mbtiles";

/** Default OpenSeaMap seamark overlay tiles. */
const DEFAULT_TILE_URL = "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png";

const DEFAULT_USER_AGENT = "SignalK-Corridor-Downloader/1.0";

/**
 * Multi-tier corridor margins (SPEC Addendum 1): strategic swath for
 * zooms <= 10, tactical swath for 11-13, approach rings for >= 14.
 */
const DEFAULT_STRATEGIC_MARGIN_NM = 50;
const DEFAULT_TACTICAL_MARGIN_NM = 15;
const DEFAULT_APPROACH_RADIUS_NM = 3;

/**
 * Safety valve: refuse to queue absurdly large corridor jobs (e.g. a
 * transoceanic route at z17 with a huge margin) that would take weeks
 * to download. The client can narrow zoom or margin and retry.
 */
const MAX_QUEUE_SIZE = 500000;

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

  let tileServerUrl = String(options.tileServerUrl || DEFAULT_TILE_URL).trim();
  if (
    !tileServerUrl.includes("{z}") ||
    !tileServerUrl.includes("{x}") ||
    !tileServerUrl.includes("{y}")
  ) {
    tileServerUrl = DEFAULT_TILE_URL;
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
    tileServerUrl,
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
            "Absolute path of the .mbtiles file. Must live in the directory watched by signalk-charts-provider-simple. A leading ~/ expands to the server user's home.",
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
          default: 14,
        },
        throttleMs: {
          type: "integer",
          title: "Throttle (ms between requests)",
          description:
            "Delay between HTTP tile requests, to stay polite to public tile servers",
          default: 500,
        },
        tileServerUrl: {
          type: "string",
          title: "Tile server URL template",
          description: "Slippy tile URL with {z}/{x}/{y} placeholders",
          default: DEFAULT_TILE_URL,
        },
        userAgent: {
          type: "string",
          title: "User-Agent header",
          default: DEFAULT_USER_AGENT,
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

      try {
        store = new MbTilesStore(config.outputPath);
      } catch (err) {
        store = null;
        const message = `failed to open ${config.outputPath}: ${err.message}`;
        setError?.(message);
        app.error(`${PLUGIN_ID}: ${message}`);
        return;
      }

      // Test hooks (`fetch`, `sleep`) ride along in the raw options,
      // mirroring the injectable-probe pattern; absent in production.
      downloader = createDownloader({
        store,
        tileServerUrl: config.tileServerUrl,
        userAgent: config.userAgent,
        throttleMs: config.throttleMs,
        fetchFn: options?.fetch,
        sleepFn: options?.sleep,
        getInternetState,
        log: (m) => app.debug(`${PLUGIN_ID}: ${m}`),
        onProgress: () => publishStatus(),
      });

      publishStatus();
    },

    stop: () => {
      downloader?.cancel();
      downloader = null;
      store?.close();
      store = null;
      setStatus?.("Corridor downloader stopped");
    },
  };

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
      setStatus?.(
        `Downloading corridor: ${s.completed + s.skipped}/${s.totalQueued} tiles (${s.failed} failed)`,
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
   * metadata, filters out already-cached tiles and starts the queue.
   *
   * @param {Array<{lat: number, lon: number}>} coordinates
   * @param {string} routeName - Display name for the job
   * @param {boolean} forceOnMetered - Metered override (SPEC Addendum 4)
   * @returns {{totalTiles: number}}
   */
  function startJob(coordinates, routeName, forceOnMetered) {
    if (!store || !downloader) {
      throw httpError(503, "Tile store unavailable (check plugin log)");
    }
    const running = downloader.status();
    if (running.isDownloading) {
      throw httpError(409, "A download job is already in progress");
    }

    const { tiles, bounds } = corridorTiles(coordinates, config);
    if (tiles.length === 0) {
      throw httpError(400, "No valid coordinates to fetch");
    }
    if (tiles.length > MAX_QUEUE_SIZE) {
      throw httpError(
        413,
        `Corridor of ${tiles.length} tiles exceeds the ${MAX_QUEUE_SIZE} tile limit; reduce zoom range or margin`,
      );
    }

    // API discovery handoff: bounds and zoom range must reflect the
    // corridor before the consumer plugin sees new tiles.
    if (bounds) store.setBounds(bounds);
    store.setZoomLevels(config.minZoom, config.maxZoom);

    // Skip what we already have so re-runs only fetch the delta.
    const pending = tiles.filter((t) => !store.hasTile(t.z, t.x, t.yTms));

    downloader.start(pending, { routeName, forceOnMetered });
    lastRouteName = routeName;
    return { totalTiles: pending.length };
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
        dbSizeBytes: store ? store.sizeBytes() : 0,
        outputPath: store ? store.filePath : null,
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
      res.json({ status: "cancelled" });
    });

    router.post("/vacuum", (_req, res) => {
      if (!store) {
        res
          .status(503)
          .json({ message: "Tile store unavailable (check plugin log)" });
        return;
      }
      if (downloader?.status().isDownloading) {
        res
          .status(409)
          .json({ message: "Cannot vacuum while a download is in progress" });
        return;
      }
      try {
        store.vacuum();
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
module.exports.DEFAULT_TILE_URL = DEFAULT_TILE_URL;
module.exports.DEFAULT_USER_AGENT = DEFAULT_USER_AGENT;
module.exports.DEFAULT_STRATEGIC_MARGIN_NM = DEFAULT_STRATEGIC_MARGIN_NM;
module.exports.DEFAULT_TACTICAL_MARGIN_NM = DEFAULT_TACTICAL_MARGIN_NM;
module.exports.DEFAULT_APPROACH_RADIUS_NM = DEFAULT_APPROACH_RADIUS_NM;
module.exports.MAX_QUEUE_SIZE = MAX_QUEUE_SIZE;
module.exports.expandHome = expandHome;
module.exports.resolveConfig = resolveConfig;
