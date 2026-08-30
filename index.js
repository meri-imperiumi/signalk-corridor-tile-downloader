/**
 * Signal K Corridor Tile Downloader plugin.
 *
 * Pre-caches marine tile corridors (OpenStreetMap / OpenSeaMap /
 * Open Waters) along the active route — or a custom target — into
 * standard MBTiles files that `signalk-charts-provider-simple` serves
 * to Freeboard SK for offline navigation.
 *
 * With the Open Waters provider the offline cache is a COMPLETE mirror
 * of the online chart (BATHYMETRY.md): every tile source the published
 * style references (seamarks, bathymetry, coverage, base map, two DEMs)
 * gets its own MBTiles file, the style itself plus its sprite sheets
 * and font glyphs are mirrored under the plugin data dir, and plugin
 * HTTP routes serve a URL-rewritten copy of the style so MapLibre
 * clients render the identical chart offline.
 *
 * This plugin is strictly a data producer. Passage jobs are journaled
 * and resume automatically after restarts.
 *
 * It also registers as a read-only Signal K `charts` resource provider:
 * once the mirror can serve a style and at least one source has tiles,
 * a single `mapstyleJSON` chart resource (id `openwaters-corridor`)
 * points Freeboard SK at the OL-compatible style variant — clients
 * discover and render the offline chart with zero manual setup. A
 * `resources.charts` delta is emitted whenever that entry changes.
 *
 * REST API (mounted at /plugins/signalk-corridor-tile-downloader):
 *   GET  /status                       queue + cache + mirror snapshot
 *   POST /fetch-active-route           corridor for navigation.course.activeRoute
 *   POST /fetch-target                 corridor for a posted coordinate list
 *   POST /cancel                       abort the running job
 *   POST /vacuum                       VACUUM every mbtiles database
 *   GET  /assets/manifest.json         mirror discovery contract
 *   GET  /assets/style.json            URL-rewritten copy of the mirrored style
 *   GET  /assets/style-ol.json         OpenLayers variant (unrenderable layers dropped)
 *   GET  /assets/sprites/:file         mirrored sprite sheets
 *   GET  /assets/fonts/:fontstack/:range  mirrored glyph ranges
 *
 * @file index.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  bubbleTiles,
  corridorTiles,
  distanceNM,
  isValidCoordinate,
  overviewTiles,
  unionBoxes,
} = require("./lib/geometry.js");
const { MbTilesStore, nodeSupportsSqlite, extentFromTilesFile } =
  require("./lib/mbtiles.js");
const {
  createDownloader,
  DEFAULT_SOURCE,
  GZIP_MAGIC,
} = require("./lib/downloader.js");

/** Plugin identifier (package name). */
const PLUGIN_ID = "signalk-corridor-tile-downloader";

/** Default output inside the directory watched by charts-provider-simple. */
const DEFAULT_OUTPUT_PATH = "~/.signalk/charts-simple/passage_cache.mbtiles";

/**
 * Supported seamark overlay providers. Each entry defines the default
 * slippy URL template and its tile format profile:
 *
 * - Open Waters Seamap serves Mapbox Vector Tiles (`.pbf`, zooms 0-14).
 *   Its `sources` table lists EVERY tileset of the published chart
 *   style (BATHYMETRY.md FACTS) — corridor jobs mirror all of them,
 *   one MBTiles per source, plus the style/sprites/fonts the style
 *   references. The legacy top-level fields (`format`, `vectorLayers`,
 *   `maxZoom`, `urlTemplate`) keep old config paths valid and describe
 *   the primary `seamap` source.
 * - OpenSeaMap serves raster PNGs (`format=png`).
 *
 * Custom raster or vector sources can be used through the custom
 * `tileServerUrl` template; a `.pbf` template selects the vector
 * profile automatically. Custom/OpenSeaMap configs never gain the
 * multi-source mirror.
 */
const TILE_PROVIDERS = {
  "Open Waters Seamap": {
    styleUrl: "https://tiles.openwaters.io/seamap/style.json",
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
    // Ordered by download priority (safety first: seamarks, then
    // bathymetry, then base map, DEMs last). `fileSuffix` derives each
    // store's path from the configured outputPath (STEP 2); zooms cap
    // the per-source corridor (STEP 4); attribution lands in each
    // store's metadata (STEP 5).
    sources: [
      {
        id: "seamap",
        fileSuffix: "",
        format: "pbf",
        urlTemplate: "https://tiles.openwaters.io/seamap/{z}/{x}/{y}.pbf",
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
      {
        id: "seascape-vector",
        fileSuffix: "-bathy",
        format: "pbf",
        urlTemplate: "https://tiles.openwaters.io/seascape/{z}/{x}/{y}.pbf",
        vectorLayers: ["contours", "soundings", "depare"],
        maxZoom: 15,
        attribution:
          '<a href="https://openwaters.io/charts/seascape#license">© Open Waters</a>',
      },
      {
        id: "seascape-coverage",
        fileSuffix: "-coverage",
        format: "pbf",
        urlTemplate:
          "https://tiles.openwaters.io/seascape/coverage/{z}/{x}/{y}.pbf",
        vectorLayers: ["coverage"],
        maxZoom: 8,
        attribution:
          '<a href="https://openwaters.io/charts/seascape#license">© Open Waters</a>',
      },
      {
        id: "versatiles-shortbread",
        fileSuffix: "-base",
        format: "pbf",
        urlTemplate: "https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}",
        maxZoom: 14,
        attribution:
          "© OpenStreetMap contributors (CC-BY-4.0) · ESA WorldCover",
      },
      {
        id: "elevation",
        fileSuffix: "-elevation",
        format: "webp",
        urlTemplate: "https://tiles.versatiles.org/tiles/elevation/{z}/{x}/{y}",
        maxZoom: 12,
        attribution:
          '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
      },
      {
        id: "seascape-dem",
        fileSuffix: "-dem",
        format: "webp",
        urlTemplate: "https://tiles.openwaters.io/seascape/{z}/{x}/{y}.webp",
        maxZoom: 18,
        attribution:
          '<a href="https://openwaters.io/charts/seascape#license">© Open Waters</a>',
      },
    ],
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
 * transoceanic route at z18 with a huge margin) that would take weeks
 * to download. The six-source Open Waters mirror multiplies the
 * per-tileset count, hence the generous ceiling. The client can
 * narrow zoom or margin and retry.
 */
const MAX_QUEUE_SIZE = 2000000;

/**
 * Restart journal (crash-safe resume): passage jobs are persisted as
 * their *intent* — coordinates, geometry snapshot, the mirrored source
 * list with per-source zoom caps — rather than as tile lists.
 * Rebuilding the corridors on the next start() and filtering against
 * the MBTiles caches (`hasTile`) yields exactly the tiles the
 * interrupted job still lacked. Version 1 journals (pre-mirror) resume
 * seamap-only, exactly as written.
 */
const PENDING_JOB_VERSION = 2;
const PENDING_JOB_FILENAME = "pending-job.json";

/** The consumer plugin that serves our tiles to Freeboard SK. */
const CHARTS_PROVIDER_ID = "signalk-charts-provider-simple";

/**
 * In-process refresh hook published by charts-provider-simple on
 * globalThis (same pattern as signalk-container's manager global).
 */
const CHARTS_REFRESH_GLOBAL = "__signalk_chartsProviderRefresh";

/**
 * Id of the chart resource this plugin advertises through the Signal K
 * resources API: a `mapstyleJSON` chart whose URL is the OL-compatible
 * style variant, so Freeboard SK renders the offline mirror styled.
 * Multiple chart providers coexist (the server merges their listings),
 * so this never collides with charts-provider-simple's per-file charts.
 */
const STYLE_CHART_ID = "openwaters-corridor";

/** Glyph range geometry of the Open Waters font endpoint: files cover
 * 256 codepoints each, `{n}-{n+255}` for n = 0..65280. */
const GLYPH_RANGE_STEP = 256;
const GLYPH_MAX_CODEPOINT = 65535;

/** Upstream glyph endpoint (fontstack URL-encoded, BATHYMETRY.md). */
const FONT_URL_TEMPLATE =
  "https://tiles.openwaters.io/fonts/{fontstack}/{range}.pbf";

/**
 * Layer types ol-mapbox-style — Freeboard SK's style renderer — can
 * draw: background, the vector geometry types, raster, and hillshade
 * from raster-dem sources. MapLibre-only additions are absent: a
 * `heatmap` layer is logged and skipped by ol-mapbox-style, and a
 * `color-relief` layer (Open Waters' `depth-shading`) matches no
 * branch at all — when it is the FIRST layer of its source, as
 * upstream, `apply()` dereferences an undefined layer and rejects,
 * blanking the entire chart instead of just the one layer. The OL
 * style variant keeps only this set.
 */
const OL_RENDERABLE_LAYER_TYPES = new Set([
  "background",
  "fill",
  "fill-extrusion",
  "line",
  "symbol",
  "circle",
  "raster",
  "hillshade",
]);

/**
 * Rewrites MapLibre's `image` expression (used in `icon-image`
 * fallback chains: `["image", name]` resolves to the sprite icon,
 * null when absent so `coalesce` can fall through) to its inner name
 * expression. ol-mapbox-style has no `image` operator — parsing the
 * expression fails, and with it every feature of the layer styles to
 * nothing: Open Waters' `lights`, `buoys` and `topmarks` layers would
 * render blank while their labels (separate layers) stay visible.
 *
 * Degradation vs MapLibre: a name the sprite lacks no longer falls
 * through to later `coalesce` branches — the icon is just skipped
 * (ol-mapbox-style draws nothing for unknown names). The sprite's
 * color variants cover the first branch in practice.
 *
 * @param {unknown} value - Style expression node
 * @returns {unknown}
 */
function unwrapImageExpressions(value) {
  if (!Array.isArray(value)) return value;
  if (value[0] === "image" && value.length === 2) {
    return unwrapImageExpressions(value[1]);
  }
  return value.map(unwrapImageExpressions);
}

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
 * Envelope union of two `[west, south, east, north]` boxes (null
 * tolerant). Coverage never shrinks: tiles accumulate across jobs, so
 * every advertised extent is the union of everything seen so far.
 *
 * @param {number[]|null} a
 * @param {number[]|null} b
 * @returns {number[]|null}
 */
function unionBounds(a, b) {
  if (a == null) return b == null ? null : [...b];
  if (b == null) return [...a];
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/**
 * Parses a `bounds` metadata row ("west,south,east,north"). Null when
 * absent or malformed.
 *
 * @param {string|null|undefined} value
 * @returns {number[]|null}
 */
function parseBoundsMetadata(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) ? parts : null;
}

/**
 * Derives a source's cache path from the configured seamap path:
 * insert `suffix` before the extension, same directory. An empty
 * suffix (the seamap source itself) returns the path unchanged.
 *
 * @param {string} outputPath - Configured seamap cache path
 * @param {string} suffix - e.g. "-bathy", "-dem", ""
 * @returns {string}
 */
function sourcePath(outputPath, suffix) {
  if (!suffix) return outputPath;
  const i = outputPath.lastIndexOf(".");
  return i > 0
    ? `${outputPath.slice(0, i)}${suffix}${outputPath.slice(i)}`
    : `${outputPath}${suffix}`;
}

/** All glyph range file names ("0-255" … "65280-65535"). */
function glyphRangeNames() {
  const names = [];
  for (
    let n = 0;
    n + GLYPH_RANGE_STEP - 1 <= GLYPH_MAX_CODEPOINT;
    n += GLYPH_RANGE_STEP
  ) {
    names.push(`${n}-${n + GLYPH_RANGE_STEP - 1}`);
  }
  return names;
}

/**
 * Normalizes plugin configuration, applying defaults and clamps.
 *
 * Tile provider resolution (SPEC Addendum 6): an explicit
 * `tileProvider` selection drives the default URL template, its tile
 * format profile and the source-layer ids advertised to MapLibre
 * clients. A `tileServerUrl` that is empty or equal to any provider
 * default is "derived" and follows the selection; anything else is a
 * custom override whose format is inferred from the template (a
 * `{y}.pbf` path is vector).
 *
 * The Open Waters multi-source mirror is enabled iff the resolved
 * provider is Open Waters AND the URL is derived (not custom): the
 * configured maxZoom then clamps to the highest native source ceiling
 * (z18 for the DEM), and every source additionally caps its own
 * corridor at job time (STEP 4).
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

  // The six-source mirror rides along with the Open Waters provider's
  // derived URL only (BATHYMETRY.md STEP 1 rules).
  const sources =
    !isCustomUrl && Array.isArray(provider.sources) ? provider.sources : null;

  // The configured zoom range may reach the highest native source
  // ceiling (the DEM's z18); each source applies its own, tighter cap
  // when the corridor is built.
  const zoomCeiling = sources
    ? Math.max(...sources.map((s) => s.maxZoom ?? 0))
    : provider.maxZoom;
  if (!isCustomUrl && zoomCeiling != null) {
    maxZoom = Math.min(maxZoom, zoomCeiling);
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
    sources,
    styleUrl: sources ? provider.styleUrl : null,
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
 * Version 1 (pre-mirror) intents stay valid and resume seamap-only.
 *
 * @param {object|null} intent
 * @returns {boolean}
 */
function isValidPendingJob(intent) {
  if (intent == null || typeof intent !== "object") return false;
  if (intent.version !== 1 && intent.version !== 2) return false;
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
  if (intent.version === 2) {
    if (!Array.isArray(intent.sources)) return false;
    for (const source of intent.sources) {
      if (
        source == null ||
        typeof source !== "object" ||
        typeof source.id !== "string" ||
        source.id === "" ||
        typeof source.path !== "string" ||
        !zoomOk(source.maxZoom)
      ) {
        return false;
      }
    }
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

  /** @type {Map<string, MbTilesStore>} Open stores by source id. */
  const stores = new Map();
  let downloader = null;
  let lastRouteName = null;
  let config = null;
  /** Last position the recovery cache was verified against. */
  let lastCheckedPosition = null;
  const unsubscribes = [];
  /** Chart-provider refresh callback (injectable for tests). */
  let notifyChartsProvider = defaultNotifyChartsProvider;
  /** Source ids already announced to the charts provider this session. */
  const refreshedSources = new Set();
  /** Mirror asset phase state ("fetching" in-flight; null → derive). */
  let assetsStatus = null;
  /** Did this job's style refetch fail (drives assets.state). */
  let styleFetchFailed = false;

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
            "Absolute path of the .mbtiles file. Must live in the charts directory watched by signalk-charts-provider-simple (default ~/.signalk/charts-simple). A leading ~/ expands to the server user's home. With the Open Waters provider the other mirrored tilesets are cached beside it with derived suffixes (-bathy, -coverage, -base, -elevation, -dem).",
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
          description:
            "Corridor zooms start here; a small low-zoom overview pyramid (z0 up to one below this level, over the corridor bounds) is always fetched alongside so zooming out keeps showing cached context",
          default: 8,
        },
        maxZoom: {
          type: "integer",
          title: "Maximum zoom",
          description:
            "Clamped to the provider's native ceiling (Open Waters mirror sources serve up to z18; each source applies its own cap)",
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
            "Open Waters Seamap mirrors the complete chart style (six vector/raster tilesets, style, sprites, fonts) for offline MapLibre rendering; OpenSeaMap serves the raster PNG overlay. The tile format must match the cache file: switching formats on a filled cache is rejected until you pick a new output path",
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

      // The tile stores open lazily on first use and are released when
      // a job settles: charts-provider-simple's startup housekeeping
      // deletes `*.mbtiles-wal` sidecars and bounds-less .mbtiles
      // files, so an idle downloader must leave neither on disk.

      // Test hooks (`fetch`, `sleep`, `notify`) ride along in the raw
      // options, mirroring the injectable-probe pattern; absent in
      // production.
      notifyChartsProvider =
        typeof options?.notify === "function"
          ? options.notify
          : defaultNotifyChartsProvider;
      downloader = createDownloader({
        getStore: (source) => ensureStoreForId(source),
        templates: downloaderTemplates(),
        formats: downloaderFormats(),
        format: config.format,
        userAgent: config.userAgent,
        throttleMs: config.throttleMs,
        allowRecoveryOnMetered: config.allowRecoveryOnMetered,
        fetchFn: options?.fetch,
        sleepFn: options?.sleep,
        getInternetState,
        log: (m) => app.debug(`${PLUGIN_ID}: ${m}`),
        onProgress: () => publishStatus(),
        onTileStored: (tile) => {
          // A job populating a store for the first time must be picked
          // up by the consumer (no file watcher): announce each new
          // store the moment its first tile lands (BATHYMETRY.md
          // consumer notes).
          const id = tile.source ?? DEFAULT_SOURCE;
          if (refreshedSources.has(id)) return;
          refreshedSources.add(id);
          notifyChartsProvider();
        },
        onSettled: (stats) => {
          // A naturally completed passage job retires its restart
          // journal; a job cancelled by stop() keeps its journal so the
          // next start() resumes it.
          if (stats.state === "completed" && !stats.isRecovery) {
            clearPendingJob();
          }
          // Charts landed in the files: ask the consumer to rescan so
          // the corridor shows up in Freeboard without a provider
          // restart.
          if (stats.completed > 0) {
            notifyChartsProvider();
          }
          // The advertised chart resource may have appeared or grown:
          // push it to subscribed clients (quiet when unchanged).
          emitStyleChartDelta();
          // A cancelled asset phase leaves "fetching" behind: fall
          // back to deriving the state from disk.
          if (assetsStatus?.state === "fetching") {
            assetsStatus = null;
          }
        },
      });

      // Reconcile sidecars wedged by an earlier provider housekeeping
      // strike before any reader (or resumed job) touches the caches.
      sweepStaleSidecars();

      // Serve the offline style as a chart resource (no-op for
      // non-mirror configs and older servers).
      registerChartsResourceProvider();

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
      closeStores();
      lastCheckedPosition = null;
      assetsStatus = null;
      setStatus?.("Corridor downloader stopped");
    },
  };

  // ------------------------------------------------------------------
  // Source and store plumbing
  // ------------------------------------------------------------------

  /**
   * Is the Open Waters multi-source mirror active in the resolved
   * config?
   *
   * @returns {boolean}
   */
  function mirrorEnabled() {
    return config?.sources != null;
  }

  /**
   * The effective source list for routing, status and recovery: the
   * provider's mirror sources with derived paths, or the single
   * legacy seamap source for OpenSeaMap/custom configs.
   *
   * @returns {Array<{id: string, path: string, format: string, urlTemplate: string, vectorLayers?: string[], attribution?: string, maxZoom?: number}>}
   */
  function activeSourceConfigs() {
    if (mirrorEnabled()) {
      return config.sources.map((source) => ({
        ...source,
        path: sourcePath(config.outputPath, source.fileSuffix),
      }));
    }
    return [
      {
        id: DEFAULT_SOURCE,
        path: config.outputPath,
        format: config.format,
        urlTemplate: config.tileServerUrl,
        maxZoom: config?.maxZoom,
      },
    ];
  }

  /**
   * URL templates for the downloader, keyed by source id.
   *
   * @returns {Record<string, string>}
   */
  function downloaderTemplates() {
    const templates = {};
    for (const source of activeSourceConfigs()) {
      templates[source.id] = source.urlTemplate;
    }
    return templates;
  }

  /**
   * Format profile ids for the downloader, keyed by source id.
   *
   * @returns {Record<string, string>}
   */
  function downloaderFormats() {
    const formats = {};
    for (const source of activeSourceConfigs()) {
      formats[source.id] = source.format;
    }
    return formats;
  }

  /**
   * Opens (or reuses) the store of a source id. Unknown ids open
   * nothing and yield null (the downloader counts such tiles failed).
   *
   * @param {string} sourceId
   * @returns {MbTilesStore|null}
   */
  function ensureStoreForId(sourceId) {
    const source = activeSourceConfigs().find((s) => s.id === sourceId);
    if (!source) return null;
    return ensureStoreFor(source);
  }

  /**
   * Opens (or reuses) a source's store, honoring configuration changes
   * to `outputPath`.
   *
   * @param {object} source - Active source config
   * @returns {MbTilesStore}
   * @throws When the database cannot be opened
   */
  function ensureStoreFor(source) {
    const existing = stores.get(source.id);
    if (existing && existing.filePath === source.path) return existing;
    existing?.close();
    stores.delete(source.id);
    const store = new MbTilesStore(source.path, {
      name: storeNameFor(source),
    });
    stores.set(source.id, store);
    return store;
  }

  /**
   * Display name for a store's metadata: derived files carry their
   * source id, the seamap file keeps the historic name.
   *
   * @param {object} source
   * @returns {string}
   */
  function storeNameFor(source) {
    return source.id === DEFAULT_SOURCE
      ? "Signal K Corridor Cache"
      : `Signal K Corridor Cache — ${source.id}`;
  }

  /** Closes every open store. */
  function closeStores() {
    for (const store of stores.values()) store.close();
    stores.clear();
  }

  /**
   * Closes the tile stores when no job is using them, so no live
   * `*.mbtiles-wal` sidecar sits on disk while idle (see start()).
   */
  function releaseStoresIfIdle() {
    if (downloader?.status().isDownloading) return;
    closeStores();
  }

  /**
   * Sweeps stale WAL sidecars left around any cache file by an earlier
   * charts-provider-simple housekeeping strike. A wedged `-shm`/`-wal`
   * pair (stale wal-index referencing a deleted or emptied WAL) fails
   * every read-only open — the provider's chart-metadata endpoint —
   * with `disk I/O error` until a read-write connection reconciles the
   * index. Opening and closing our store does exactly that, and the
   * clean close checkpoints and removes the sidecars. No-op when no
   * sidecars linger.
   */
  function sweepStaleSidecars() {
    for (const source of activeSourceConfigs()) {
      const wal = `${source.path}-wal`;
      const shm = `${source.path}-shm`;
      if (!fs.existsSync(wal) && !fs.existsSync(shm)) continue;
      if (!fs.existsSync(source.path)) continue;
      try {
        ensureStoreFor(source);
        releaseStoresIfIdle();
        app.debug(
          `${PLUGIN_ID}: reconciled stale WAL sidecars at ${source.path}`,
        );
      } catch (err) {
        app.error(
          `${PLUGIN_ID}: cannot reconcile stale WAL sidecars at ${source.path}: ${err.message}`,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Mirror assets (style, sprites, fonts — BATHYMETRY.md STEP 9)
  // ------------------------------------------------------------------

  /**
   * The mirror directory inside the plugin data dir, or null when the
   * server exposes no data directory (persistence off).
   *
   * @returns {string|null}
   */
  function mirrorDir() {
    const dataDir = app.getDataDirPath?.();
    return typeof dataDir === "string" && dataDir !== ""
      ? path.join(dataDir, "mirror")
      : null;
  }

  /** @returns {string|null} */
  function stylePath() {
    return mirrorDir() ? path.join(mirrorDir(), "style.json") : null;
  }

  /**
   * @param {string} spriteId
   * @param {string} variant - "" | "@2x"
   * @param {"json"|"png"} ext
   * @returns {string|null}
   */
  function spriteFilePath(spriteId, variant, ext) {
    return mirrorDir()
      ? path.join(mirrorDir(), "sprites", `${spriteId}${variant}.${ext}`)
      : null;
  }

  /**
   * @param {string} stack
   * @param {string} rangeName - e.g. "0-255"
   * @returns {string|null}
   */
  function fontFilePath(stack, rangeName) {
    return mirrorDir()
      ? path.join(mirrorDir(), "fonts", stack, `${rangeName}.pbf`)
      : null;
  }

  /** @returns {string|null} */
  function mirrorIndexPath() {
    return mirrorDir() ? path.join(mirrorDir(), "index.json") : null;
  }

  /**
   * Reads the mirrored style (the render truth), parsed. Null when not
   * (yet) mirrored.
   *
   * @returns {object|null}
   */
  function readMirrorStyle() {
    const file = stylePath();
    if (!file) return null;
    try {
      const style = JSON.parse(fs.readFileSync(file, "utf8"));
      return style && typeof style === "object" ? style : null;
    } catch {
      return null;
    }
  }

  /**
   * Reads the asset index tracking which glyph ranges are stored vs
   * known-absent (upstream 404): a missing or corrupt index means
   * "everything unknown" and is rebuilt as fetches land.
   *
   * @returns {{fonts: Record<string, Record<string, "stored"|"absent">>}}
   */
  function readMirrorIndex() {
    const file = mirrorIndexPath();
    if (!file) return { fonts: {} };
    try {
      const index = JSON.parse(fs.readFileSync(file, "utf8"));
      if (index && typeof index === "object" && index.fonts != null) {
        return index;
      }
    } catch {
      // Corrupt index: rebuild from fetches
    }
    return { fonts: {} };
  }

  /**
   * Persists the asset index (best-effort).
   *
   * @param {object} index
   */
  function writeMirrorIndex(index) {
    const file = mirrorIndexPath();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(index)}\n`);
    } catch (err) {
      app.error(`${PLUGIN_ID}: cannot write mirror index: ${err.message}`);
    }
  }

  /**
   * Sprite entries of a style, normalized to `{id, url}` objects. The
   * online style uses the array form; a plain string is treated as a
   * single anonymous entry.
   *
   * @param {object|null} style
   * @returns {Array<{id: string, url: string}>}
   */
  function collectSpriteEntries(style) {
    const sprite = style?.sprite;
    if (typeof sprite === "string") {
      return sprite !== "" ? [{ id: "default", url: sprite }] : [];
    }
    if (!Array.isArray(sprite)) return [];
    return sprite
      .filter((entry) => entry != null && typeof entry.url === "string")
      .map((entry) => ({
        id: String(entry.id ?? "default"),
        url: entry.url,
      }));
  }

  /**
   * Font stacks referenced by a style's symbol layers (union of every
   * `text-font` value, BATHYMETRY.md STEP 9.2).
   *
   * @param {object|null} style
   * @returns {string[]}
   */
  function collectFontStacks(style) {
    const stacks = new Set();
    for (const layer of style?.layers ?? []) {
      const font = layer?.layout?.["text-font"];
      if (typeof font === "string") {
        stacks.add(font);
      } else if (Array.isArray(font)) {
        for (const name of font) {
          if (typeof name === "string") stacks.add(name);
        }
      }
    }
    return [...stacks].sort();
  }

  /**
   * Resolution state of one glyph range: "cached" (stored on disk),
   * "absent" (upstream 404 — skip forever), or "unknown" (fetch or
   * refetch).
   *
   * @param {string} stack
   * @param {string} rangeName
   * @param {object} index - Mirror index
   * @returns {"cached"|"absent"|"unknown"}
   */
  function fontRangeState(stack, rangeName, index) {
    const entry = index.fonts?.[stack]?.[rangeName];
    if (entry === "absent") return "absent";
    const file = fontFilePath(stack, rangeName);
    if (entry === "stored" && file && fs.existsSync(file)) return "cached";
    return "unknown";
  }

  /**
   * Font stacks with at least one stored range (the route's notion of
   * a "cached stack").
   *
   * @returns {string[]}
   */
  function cachedFontStacks() {
    const index = readMirrorIndex();
    return Object.keys(index.fonts ?? {})
      .filter((stack) =>
        Object.entries(index.fonts[stack] ?? {}).some(
          ([range, state]) =>
            state === "stored" &&
            fontFilePath(stack, range) &&
            fs.existsSync(fontFilePath(stack, range)),
        ),
      )
      .sort();
  }

  /**
   * Expected mirror files that are not resolved yet (missing list for
   * the `assets` status). `@2x` sprite variants are optional and never
   * missing.
   *
   * @param {object} style - Parsed mirrored style
   * @returns {string[]} Relative paths under the mirror dir
   */
  function missingMirrorFiles(style) {
    const missing = [];
    for (const entry of collectSpriteEntries(style)) {
      for (const ext of ["json", "png"]) {
        const file = spriteFilePath(entry.id, "", ext);
        if (file && !fs.existsSync(file)) {
          missing.push(`sprites/${entry.id}.${ext}`);
        }
      }
    }
    const index = readMirrorIndex();
    for (const stack of collectFontStacks(style)) {
      for (const rangeName of glyphRangeNames()) {
        if (fontRangeState(stack, rangeName, index) === "unknown") {
          missing.push(`fonts/${stack}/${rangeName}.pbf`);
        }
      }
    }
    return missing;
  }

  /**
   * Has anything in the mirror been attempted (used to distinguish
   * "never fetched" from "fetched and failed" after a restart)?
   *
   * @returns {boolean}
   */
  function mirrorAttempted() {
    const dir = mirrorDir();
    if (!dir || !fs.existsSync(dir)) return false;
    return (
      fs.existsSync(mirrorIndexPath()) ||
      fs.existsSync(stylePath()) ||
      fs.readdirSync(dir).some((entry) => entry !== "index.json")
    );
  }

  /**
   * Derives the `assets` status from what is actually mirrored on
   * disk: "none" (no mirror / never attempted), "ready" (style +
   * required sprites + all glyph ranges resolved), "partial" (some
   * pieces missing), "failed" (style not mirrored after an attempt).
   *
   * @param {boolean} styleFailedThisJob - This job's style refetch failed
   * @returns {{state: string, missing?: string[]}}
   */
  function computeAssetsState(styleFailedThisJob = false) {
    if (!mirrorEnabled()) return { state: "none" };
    if (styleFailedThisJob) {
      return { state: "failed", missing: ["style.json"] };
    }
    const style = readMirrorStyle();
    if (!style) {
      return mirrorAttempted()
        ? { state: "failed", missing: ["style.json"] }
        : { state: "none" };
    }
    const missing = missingMirrorFiles(style);
    if (missing.length === 0) return { state: "ready" };
    return { state: "partial", missing };
  }

  /**
   * Builds the lazy asset plan for a job (BATHYMETRY.md STEP 9): the
   * style is re-fetched every Open Waters job start, then — planned
   * from the style that is now on disk — the missing sprite files and
   * glyph ranges. Returns a generator function the downloader pulls
   * until it yields null.
   *
   * @returns {() => (object|null)} Asset request supplier
   */
  function createAssetPlan() {
    if (!mirrorDir() || !config.styleUrl) return () => null;
    let styleFetched = false;
    let planned = false;
    /** @type {Array<object>} */
    const pending = [];
    return () => {
      if (pending.length > 0) return pending.shift();
      if (!styleFetched) {
        styleFetched = true;
        return {
          kind: "style",
          url: config.styleUrl,
          path: stylePath(),
          acceptHeader: "application/json",
        };
      }
      if (planned) return null;
      planned = true;
      const style = readMirrorStyle();
      if (!style) return null;
      // Sprites: {url}.json/.png/@2x variants; @2x is optional
      // (404 = skip) but still fetched when present upstream.
      for (const entry of collectSpriteEntries(style)) {
        for (const variant of ["", "@2x"]) {
          for (const ext of ["json", "png"]) {
            const file = spriteFilePath(entry.id, variant, ext);
            if (!file || fs.existsSync(file)) continue;
            pending.push({
              kind: "sprite",
              url: `${entry.url}${variant}.${ext}`,
              path: file,
              optional: variant === "@2x",
              acceptHeader: ext === "json" ? "application/json" : "image/png",
            });
          }
        }
      }
      // Glyph ranges: every unknown range of every referenced stack.
      const index = readMirrorIndex();
      for (const stack of collectFontStacks(style)) {
        for (const rangeName of glyphRangeNames()) {
          if (fontRangeState(stack, rangeName, index) !== "unknown") continue;
          pending.push({
            kind: "font",
            url: FONT_URL_TEMPLATE.replaceAll(
              "{fontstack}",
              encodeURI(stack),
            ).replaceAll("{range}", rangeName),
            path: fontFilePath(stack, rangeName),
            stack,
            range: rangeName,
            acceptHeader:
              "application/x-protobuf,application/vnd.mapbox-vector-tile,*/*;q=0.5",
          });
        }
      }
      return pending.length > 0 ? pending.shift() : null;
    };
  }

  /**
   * Handles one asset fetch result from the downloader's asset phase;
   * the terminal `{status: "done"}` finalizes the `assets` state.
   *
   * @param {object|null} asset
   * @param {{status: number|string, data?: Uint8Array, error?: string}} result
   */
  function handleAssetResult(asset, result) {
    if (result.status === "done") {
      assetsStatus = computeAssetsState(styleFetchFailed);
      styleFetchFailed = false;
      return;
    }
    if (asset == null) return;
    try {
      if (result.status === 200 || result.status === 204) {
        fs.mkdirSync(path.dirname(asset.path), { recursive: true });
        fs.writeFileSync(asset.path, result.data ?? Buffer.alloc(0));
        if (asset.kind === "font") {
          const index = readMirrorIndex();
          index.fonts[asset.stack] ??= {};
          index.fonts[asset.stack][asset.range] = "stored";
          writeMirrorIndex(index);
        }
      } else if (result.status === 404 && asset.kind === "font") {
        // Ranges that do not exist upstream: skip forever.
        const index = readMirrorIndex();
        index.fonts[asset.stack] ??= {};
        index.fonts[asset.stack][asset.range] = "absent";
        writeMirrorIndex(index);
      } else if (result.status !== 404 && asset.kind === "style") {
        styleFetchFailed = true;
      }
    } catch (err) {
      app.error(
        `${PLUGIN_ID}: cannot store mirrored asset ${asset.url}: ${err.message}`,
      );
    }
  }

  /**
   * The chart resource advertising the offline style through the
   * Signal K resources API: a single `mapstyleJSON` entry pointing at
   * the OL-compatible style variant, with bounds and zooms aggregated
   * from every cached store so clients (Freeboard SK) frame and layer
   * it like any other chart. Null while the mirror cannot serve a
   * style or no source has tiles yet (the style would render an empty
   * background over the base map).
   *
   * The URL is root-relative: the Signal K server serves it on every
   * host the plugin routes answer on, and clients resolve it against
   * their own connection host.
   *
   * @returns {object|null}
   */
  function styleChartResource() {
    if (!mirrorEnabled()) return null;
    if (readMirrorStyle() == null) return null;
    // Derived from the tiles tables — the metadata `bounds` row only
    // ever describes the latest job's corridor while tiles accumulate
    // across jobs, so a fresh smaller corridor must not un-advertise
    // older coverage (Freeboard clips charts to these bounds).
    const cached = activeSourceConfigs()
      .map((source) => ({ source, extent: extentFromTilesFile(source.path) }))
      .filter((entry) => entry.extent != null);
    if (cached.length === 0) return null;

    let bounds = null;
    let minzoom = Number.POSITIVE_INFINITY;
    let maxzoom = Number.NEGATIVE_INFINITY;
    for (const { extent } of cached) {
      bounds = unionBounds(bounds, extent.bounds);
      minzoom = Math.min(minzoom, extent.minzoom);
      maxzoom = Math.max(maxzoom, extent.maxzoom);
    }

    const resource = {
      name: "Open Waters corridor",
      description:
        "Offline Open Waters chart style rendered from the corridor tile cache",
      type: "mapstyleJSON",
      url: `/plugins/${PLUGIN_ID}/assets/style-ol.json`,
    };
    if (bounds != null) resource.bounds = bounds;
    if (
      Number.isFinite(minzoom) &&
      Number.isFinite(maxzoom) &&
      minzoom <= maxzoom
    ) {
      resource.minzoom = minzoom;
      resource.maxzoom = maxzoom;
    }
    return resource;
  }

  /**
   * Registers the plugin as a read-only Signal K `charts` resource
   * provider (multiple chart providers coexist — the server merges
   * their listings). Writes and deletes throw, exactly like
   * charts-provider-simple: the entry is derived from mirror state,
   * never user-managed. Quiet on servers without provider support.
   */
  function registerChartsResourceProvider() {
    if (!mirrorEnabled()) return;
    if (typeof app.registerResourceProvider !== "function") return;
    try {
      app.registerResourceProvider({
        type: "charts",
        methods: {
          listResources: () => {
            const resource = styleChartResource();
            return Promise.resolve(
              resource == null ? {} : { [STYLE_CHART_ID]: resource },
            );
          },
          getResource: (id) => {
            if (id !== STYLE_CHART_ID) {
              return Promise.reject(new Error("Chart not found!"));
            }
            const resource = styleChartResource();
            return resource == null
              ? Promise.reject(new Error("Chart not available!"))
              : Promise.resolve(resource);
          },
          setResource: (_id, _value) =>
            Promise.reject(new Error("Not implemented!")),
          deleteResource: (_id) =>
            Promise.reject(new Error("Not implemented!")),
        },
      });
      app.debug(`${PLUGIN_ID}: registered as charts resource provider`);
    } catch (err) {
      app.error(
        `${PLUGIN_ID}: charts resource provider registration failed: ${err.message}`,
      );
    }
  }

  /** Last chart resource value emitted as a delta (dedupe guard). */
  let lastEmittedStyleChart;

  /**
   * Emits a `resources.charts.<id>` delta whenever the advertised
   * chart resource changes (appears, bounds grow, or disappears —
   * null value), so connected clients refresh without polling. The
   * v2 handleMessage flag keeps resources out of the server's full
   * model cache, per the resource-provider contract.
   */
  function emitStyleChartDelta() {
    if (typeof app.handleMessage !== "function") return;
    const resource = styleChartResource();
    const serialized = resource == null ? null : JSON.stringify(resource);
    if (serialized === lastEmittedStyleChart) return;
    lastEmittedStyleChart = serialized;
    try {
      app.handleMessage(
        PLUGIN_ID,
        {
          updates: [
            {
              values: [
                {
                  path: `resources.charts.${STYLE_CHART_ID}`,
                  value: resource,
                },
              ],
            },
          ],
        },
        2,
      );
    } catch (err) {
      app.error(
        `${PLUGIN_ID}: cannot emit chart resource delta: ${err.message}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Deltas, recovery, status
  // ------------------------------------------------------------------

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
   * Size of a cache file on disk, without opening a database handle.
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
   * 8-12, 2 NM for 13-14, clipped to the configured zoom range and
   * each source's ceiling), checks each against its store and queues
   * the missing ones into the high-priority recovery queue for ALL
   * sources (SPEC Addendum 5, BATHYMETRY.md STEP 4).
   *
   * @param {{lat: number, lon: number}} position
   */
  function verifyRecoveryCache(position) {
    const sources = activeSourceConfigs();
    for (const source of sources) {
      try {
        ensureStoreFor(source);
      } catch (err) {
        app.error(
          `${PLUGIN_ID}: cannot open ${source.id} store for recovery: ${err.message}`,
        );
        return;
      }
    }

    const tiles = [];
    const seen = new Set();
    for (const source of sources) {
      const ceiling = source.maxZoom ?? Number.POSITIVE_INFINITY;
      for (const band of RECOVERY_BANDS) {
        const minZoom = Math.max(config.minZoom, band.minZoom);
        const maxZoom = Math.min(config.maxZoom, band.maxZoom, ceiling);
        for (let z = minZoom; z <= maxZoom; z++) {
          for (const tile of bubbleTiles(position, z, band.radiusNM)) {
            const key = `${source.id}/${tile.z}/${tile.x}/${tile.yTms}`;
            if (seen.has(key)) continue;
            seen.add(key);
            tiles.push({ ...tile, source: source.id });
          }
        }
      }
    }

    const missing = tiles.filter((tile) => {
      const store = stores.get(tile.source);
      return store == null || !store.hasTile(tile.z, tile.x, tile.yTms);
    });
    if (missing.length === 0) {
      app.debug(
        `${PLUGIN_ID}: position recovery cache complete around ${position.lat.toFixed(4)},${position.lon.toFixed(4)}`,
      );
      releaseStoresIfIdle();
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
        s.jobType === "recovery"
          ? "Recovery fetch"
          : assetsStatus?.state === "fetching"
            ? "Downloading corridor (mirroring style)"
            : "Downloading corridor";
      const done = s.completed + s.skipped;
      const suspended = s.suspended ? " — suspended" : "";
      setStatus?.(
        `${label}: ${done}/${s.totalQueued} tiles (${s.failed} failed)${suspended}`,
      );
    } else if (s.state === "completed") {
      setStatus?.(
        `Corridor complete: ${s.completed} downloaded, ${s.skipped} cached/skipped, ${s.failed} failed`,
      );
    } else if (s.state === "cancelled") {
      setStatus?.("Corridor download cancelled");
    } else {
      setStatus?.("Idle");
    }
    // Job settled: release the SQLite handles (and their WAL sidecars).
    if (!s.isDownloading) {
      releaseStoresIfIdle();
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
   * Reads the vessel's current position from `navigation.position`.
   * A single target coordinate is meaningless as a corridor on its
   * own — `/fetch-target` prepends this position so the corridor
   * follows the great circle from the vessel to the target. Returns
   * null when no fix is available (the target then buffers a bubble
   * around itself, the documented fallback).
   *
   * @returns {{lat: number, lon: number}|null}
   */
  function getVesselPosition() {
    const raw = app.getSelfPath?.("navigation.position.value");
    const value = raw && typeof raw === "object" ? (raw.value ?? raw) : raw;
    if (!value || typeof value !== "object") return null;
    const position = {
      lat: Number(value.latitude),
      lon: Number(value.longitude),
    };
    return isValidCoordinate(position) ? position : null;
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

  // ------------------------------------------------------------------
  // Job start / resume
  // ------------------------------------------------------------------

  /**
   * The sources a job fetches: the full mirror list for v2 intents
   * under a mirror config (honoring journaled zoom caps on resume), or
   * the single seamap source for v1 journals and non-mirror configs
   * (no silent migration, BATHYMETRY.md STEP 7).
   *
   * @param {number} journalVersion
   * @param {object} geometry - Job geometry (config or journal snapshot)
   * @returns {Array<object>} Active source configs with `maxZoom` caps
   */
  function resolveJobSources(journalVersion, geometry) {
    if (!mirrorEnabled() || journalVersion < 2) {
      return [
        {
          ...activeSourceConfigs()[0],
          maxZoom: geometry.maxZoom,
        },
      ];
    }
    return activeSourceConfigs().map((source) => ({
      ...source,
      maxZoom:
        geometry.sourceMaxZoom?.[source.id] ??
        Math.min(geometry.maxZoom, source.maxZoom ?? geometry.maxZoom),
    }));
  }

  /**
   * Builds the corridors for a coordinate list (one per source, zooms
   * capped per source and by the configured maxZoom, ordered by source
   * priority), updates every store's MBTiles metadata, filters out
   * already-cached tiles, journals the job intent for restart-safe
   * resume, kicks off the mirror asset phase and starts the queue.
   *
   * @param {Array<{lat: number, lon: number}>} coordinates
   * @param {string} routeName - Display name for the job
   * @param {boolean} forceOnMetered - Metered override (SPEC Addendum 4)
   * @param {object} [geometryConfig] - Geometry the corridor is built
   *   from; defaults to the live config. Resume passes the journaled
   *   snapshot so a restarted job keeps its original shape even if
   *   the configuration changed in between.
   * @param {object} [opts] - `{journalVersion}` (1 for legacy resumes)
   * @returns {{totalTiles: number}}
   */
  function startJob(
    coordinates,
    routeName,
    forceOnMetered,
    geometryConfig,
    opts = {},
  ) {
    const geometry = geometryConfig ?? config;
    const journalVersion = opts.journalVersion ?? PENDING_JOB_VERSION;
    if (!downloader) {
      throw httpError(503, "Downloader not started");
    }
    const running = downloader.status();
    if (running.isDownloading && running.jobType !== "recovery") {
      throw httpError(409, "A download job is already in progress");
    }
    const jobSources = resolveJobSources(journalVersion, geometry);

    try {
      for (const source of jobSources) {
        ensureStoreFor(source);
      }
    } catch (err) {
      throw httpError(500, `Failed to open tile store: ${err.message}`);
    }

    // One corridor per source (STEP 4): same geometry, per-source zoom
    // caps, tile list ordered by source priority (seamap first, DEMs
    // last). A source whose ceiling sits below the configured minimum
    // still fetches its own top zoom. Below its effective minimum each
    // source additionally fetches the low-zoom overview pyramid over
    // the corridor bounds — a covering rectangle of z0..min-1 tiles so
    // zooming out always finds cached context instead of blanking
    // (overzoom cannot go downward: no ancestors exist below the
    // lowest cached zoom). Re-runs and resumes skip what stores hold.
    const combined = [];
    const zoomCaps = {};
    const perSourceCount = {};
    let boxes = null;
    for (const source of jobSources) {
      const maxZoom = Math.min(
        geometry.maxZoom,
        source.maxZoom ?? geometry.maxZoom,
      );
      const minZoom = Math.min(geometry.minZoom, maxZoom);
      const { tiles, boxes: tileBoxes } = corridorTiles(coordinates, {
        ...geometry,
        minZoom,
        maxZoom,
      });
      boxes ??= tileBoxes;
      zoomCaps[source.id] = maxZoom;
      perSourceCount[source.id] = tiles.length;
      for (const tile of tiles) {
        combined.push({ ...tile, source: source.id });
      }
      const overview = overviewTiles(boxes, minZoom - 1);
      perSourceCount[source.id] += overview.length;
      for (const tile of overview) {
        combined.push({ ...tile, source: source.id });
      }
    }
    if (combined.length === 0) {
      throw httpError(400, "No valid coordinates to fetch");
    }
    if (combined.length > MAX_QUEUE_SIZE) {
      const counts = jobSources
        .map((source) => `${source.id}: ${perSourceCount[source.id]}`)
        .join(", ");
      throw httpError(
        413,
        `Combined corridor of ${combined.length} tiles exceeds the ${MAX_QUEUE_SIZE} tile limit (${counts}); reduce zoom range or margin`,
      );
    }

    // One cache file carries one tile format: the consumer plugin picks
    // its Content-Type from the `format` metadata row, so mixing png
    // and pbf blobs would corrupt both. An empty file adopts the
    // source's format; a filled one refuses to switch (the user points
    // outputPath at a fresh file instead). The guard runs PER STORE
    // and names the offending file.
    for (const source of jobSources) {
      const store = stores.get(source.id);
      const storedFormat = store.getMetadata("format");
      if (store.hasAnyTile() && storedFormat !== source.format) {
        throw httpError(
          409,
          `Cache at ${source.path} holds ${storedFormat} tiles, but the ${config.tileProvider} provider downloads ${source.format} for source ${source.id}; use a different output path`,
        );
      }
    }

    // Metadata at job start, before the first tile lands (STEP 5; the
    // consumer drops bound-less stores at load). Tiles accumulate
    // across jobs, so the advertised extent/zooms are the UNION of the
    // existing rows, the tiles already on disk (the authority — an
    // interrupted earlier job may hold coverage beyond its metadata)
    // and the new corridor: a fresh corridor must never shrink the
    // chart (Freeboard clips rendering to its bounds, which used to
    // blank tiles of previous corridors still in the cache).
    for (const source of jobSources) {
      const store = stores.get(source.id);
      store.setFormat(source.format);
      const layerIds =
        source.id === DEFAULT_SOURCE
          ? config.vectorLayers
          : source.vectorLayers;
      if (layerIds) store.setVectorLayers(layerIds);
      if (source.attribution) {
        store.setMetadata("attribution", source.attribution);
      }
      const dataExtent = store.extentFromTiles();
      const priorBounds = parseBoundsMetadata(store.getMetadata("bounds"));
      const nextBounds = unionBounds(
        unionBounds(priorBounds, dataExtent?.bounds),
        unionBoxes(boxes),
      );
      if (nextBounds) store.setBounds(nextBounds);
      store.setZoomLevels(
        Math.min(
          geometry.minZoom,
          zoomCaps[source.id],
          dataExtent?.minzoom ?? Number.POSITIVE_INFINITY,
        ),
        Math.max(zoomCaps[source.id], dataExtent?.maxzoom ?? 0),
      );
      // Stores already holding tiles are visible to the consumer.
      if (store.hasAnyTile()) refreshedSources.add(source.id);
    }

    // Skip what we already have so re-runs only fetch the delta —
    // against each source's own store.
    const pending = combined.filter(
      (tile) => !stores.get(tile.source).hasTile(tile.z, tile.x, tile.yTms),
    );

    const intent = {
      version: journalVersion,
      outputPath: config.outputPath,
      routeName,
      forceOnMetered: forceOnMetered === true,
      coordinates,
      minZoom: geometry.minZoom,
      maxZoom: geometry.maxZoom,
      strategicMarginNM: geometry.strategicMarginNM,
      tacticalMarginNM: geometry.tacticalMarginNM,
      approachRadiusNM: geometry.approachRadiusNM,
    };
    if (journalVersion >= 2) {
      intent.sources = jobSources.map((source) => ({
        id: source.id,
        path: source.path,
        maxZoom: zoomCaps[source.id],
      }));
    }
    persistPendingJob(intent);

    // Mirror assets (style, sprites, fonts) run concurrently with
    // tiles and never block tile state (STEP 9). Non-mirror jobs
    // fetch none.
    let assets = null;
    let onAssetResult = null;
    if (mirrorEnabled() && journalVersion >= 2) {
      assets = createAssetPlan();
      onAssetResult = handleAssetResult;
      assetsStatus = { state: "fetching" };
      styleFetchFailed = false;
    }

    downloader.start(pending, {
      routeName,
      forceOnMetered,
      assets,
      onAssetResult,
    });
    lastRouteName = routeName;
    return { totalTiles: pending.length };
  }

  /**
   * Resumes a passage job journaled before the last shutdown: every
   * source's corridor is rebuilt from the journaled intent — not the
   * possibly changed live config — and filtered against the stores, so
   * only the tiles the interrupted job still lacked are fetched. A
   * journal targeting a different output file is kept but not resumed:
   * its corridor resumes if the configuration is switched back. A v1
   * journal resumes seamap-only, exactly as written (no migration).
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
    if (intent.version === 2 && Array.isArray(intent.sources)) {
      geometry.sourceMaxZoom = Object.fromEntries(
        intent.sources.map((source) => [source.id, source.maxZoom]),
      );
    }
    try {
      startJob(
        intent.coordinates,
        intent.routeName,
        intent.forceOnMetered,
        geometry,
        { journalVersion: intent.version },
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

  // ------------------------------------------------------------------
  // HTTP layer
  // ------------------------------------------------------------------

  /**
   * Absolute base URL (`https://host`) derived from the request —
   * protocol from X-Forwarded-Proto when present, host from the Host
   * header. Empty string when undeterminable: callers then emit
   * root-relative URLs (never a hardcoded host).
   *
   * @param {import("express").Request} req
   * @returns {string}
   */
  function baseUrlFromRequest(req) {
    const host =
      req?.headers?.host ??
      (typeof req?.get === "function" ? req.get("host") : undefined);
    if (!host) return "";
    const proto =
      req?.headers?.["x-forwarded-proto"] ?? req?.protocol ?? "http";
    return `${proto}://${host}`;
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

  /**
   * Streams a mirrored file with its content type. Glyph bodies carry
   * `Content-Encoding: gzip` only when the stored bytes are gzip
   * (detected by magic bytes — upstream may serve either).
   *
   * @param {import("express").Response} res
   * @param {string} filePath
   * @param {string} contentType
   * @param {boolean} [sniffGzip]
   */
  function sendMirroredFile(res, filePath, contentType, sniffGzip = false) {
    let body;
    try {
      body = fs.readFileSync(filePath);
    } catch {
      res.status(404).json({ message: "Asset not mirrored" });
      return;
    }
    res.status(200);
    res.set("Content-Type", contentType);
    if (
      sniffGzip &&
      body.length >= 2 &&
      body[0] === GZIP_MAGIC[0] &&
      body[1] === GZIP_MAGIC[1]
    ) {
      res.set("Content-Encoding", "gzip");
    }
    res.send(body);
  }

  /**
   * The URL-rewritten copy of the mirrored style (STEP 10): sources
   * with cached tiles point at local chart resources, uncached sources
   * and their layers are dropped (graceful degradation), glyphs and
   * sprites point at the plugin's asset routes. Everything else passes
   * through unchanged.
   *
   * The `olCompatible` option builds the OpenLayers variant
   * (`/assets/style-ol.json`): layers of a type ol-mapbox-style cannot
   * render are dropped as well, a source left without any layer —
   * e.g. a raster-dem only ever referenced by `color-relief` layers —
   * is removed so no client requests tiles nothing will draw, and
   * `icon-image` values have their `image` expressions unwrapped
   * (unsupported operator; see `unwrapImageExpressions`), with
   * `icon-overlap: always` mapped to `icon-allow-overlap: true`.
   *
   * @param {object} style - Parsed mirrored style
   * @param {string} baseUrl - Absolute base URL ("" → relative URLs)
   * @param {{olCompatible?: boolean}} [opts]
   * @returns {object}
   */
  function transformStyle(style, baseUrl, { olCompatible = false } = {}) {
    const out = structuredClone(style);
    // Strip the upstream chart author's demo camera (`center`/`zoom`/
    // `bearing`/`pitch`) from the mirrored style. These point at the
    // author's showcase location (e.g. the Danish Baltic), not the
    // corridor this offline mirror actually covers, so they're wrong for
    // every consumer. MapLibre applies them on style load — before a
    // consumer's own fitBounds runs — firing a high-zoom tile pyramid
    // across every source over a location the cache doesn't hold, a
    // barrage of 404s (and, on a fresh mount before the track resolves,
    // a long stall on an uncached area). Leaflet-based consumers (DR)
    // dodge this only because they set the viewport themselves and never
    // read the style's camera. Without a style camera, MapLibre starts
    // at a neutral world view the consumer re-fits from. (Freeboard SK
    // / ol-mapbox-style set their own view too, so dropping these is
    // inert there.)
    delete out.center;
    delete out.zoom;
    delete out.bearing;
    delete out.pitch;
    const sourceConfigs = new Map(
      activeSourceConfigs().map((source) => [source.id, source]),
    );

    const keptSources = new Set();
    for (const id of Object.keys(out.sources ?? {})) {
      const source = sourceConfigs.get(id);
      // The cache's true coverage, derived from its tiles table: drives
      // both the keep decision AND the source descriptor. Advertising
      // `bounds`/`minzoom`/`maxzoom` makes clients request only covered
      // tiles — without them every source is requested viewport-wide
      // and everything outside the corridor 404s (raster sources get
      // no pbf-style overzoom synthesis from the provider). Zooms are
      // honest too: above `maxzoom` clients overzoom cached parents
      // instead of requesting tiles that cannot exist.
      const extent = source != null ? extentFromTilesFile(source.path) : null;
      if (extent != null) {
        const stem = path.basename(source.path, ".mbtiles");
        out.sources[id].tiles = [
          `${baseUrl}/signalk/v1/api/resources/charts/${stem}/{z}/{x}/{y}`,
        ];
        delete out.sources[id].url;
        out.sources[id].bounds = extent.bounds;
        // `minzoom` is deliberately NOT advertised in either variant:
        // below the cached minimum no tiles exist and none can be
        // synthesized (overzoom only goes up from an ancestor), so
        // minzoom merely HIDES the layer around that boundary — in
        // ol-mapbox-style via a max-resolution clamp, in MapLibre by
        // skipping rendering — making the chart visibly "disappear"
        // one level above the data. `maxzoom` stays: above it clients
        // overzoom cached parents instead of requesting tiles that
        // cannot exist.
        out.sources[id].maxzoom = extent.maxzoom;
        keptSources.add(id);
      } else {
        delete out.sources[id];
      }
    }

    if (Array.isArray(out.layers)) {
      out.layers = out.layers.filter(
        (layer) =>
          ("source" in layer ? keptSources.has(layer.source) : true) &&
          (!olCompatible ||
            layer.type == null ||
            OL_RENDERABLE_LAYER_TYPES.has(layer.type)),
      );
    }

    if (olCompatible) {
      const referenced = new Set(
        (out.layers ?? [])
          .map((layer) => layer.source)
          .filter((source) => source != null),
      );
      for (const id of Object.keys(out.sources ?? {})) {
        if (!referenced.has(id)) delete out.sources[id];
      }

      for (const layer of out.layers ?? []) {
        const layout = layer?.layout;
        if (layout == null) continue;
        if (layout["icon-image"] != null) {
          layout["icon-image"] = unwrapImageExpressions(layout["icon-image"]);
        }
        // MapLibre's icon-overlap ≡ the Mapbox icon-allow-overlap that
        // ol-mapbox-style reads: "always" icons (lights, rocks —
        // safety symbology) must not be decluttered away.
        if (layout?.["icon-overlap"] === "always") {
          layout["icon-allow-overlap"] = true;
          delete layout["icon-overlap"];
        } else if ("icon-overlap" in layout) {
          delete layout["icon-overlap"];
        }
      }
    }

    if (out.glyphs) {
      out.glyphs = `${baseUrl}/plugins/${PLUGIN_ID}/assets/fonts/{fontstack}/{range}.pbf`;
    }
    if (Array.isArray(out.sprite)) {
      out.sprite = out.sprite.map((entry) => ({
        ...entry,
        url: `${baseUrl}/plugins/${PLUGIN_ID}/assets/sprites/${entry.id}`,
      }));
    } else if (typeof out.sprite === "string") {
      out.sprite = `${baseUrl}/plugins/${PLUGIN_ID}/assets/sprites/default`;
    }
    return out;
  }

  plugin.registerWithRouter = (router) => {
    router.get("/status", (_req, res) => {
      const s = downloader
        ? downloader.status()
        : { isDownloading: false, state: "idle", bySource: {} };
      const outputPaths = {};
      const dbSizeBytes = {};
      const bySource = { ...(s.bySource ?? {}) };
      for (const source of activeSourceConfigs()) {
        outputPaths[source.id] = source.path;
        dbSizeBytes[source.id] = fileSizeBytes(source.path);
        bySource[source.id] ??= {
          totalQueued: 0,
          completed: 0,
          failed: 0,
          skipped: 0,
        };
      }
      res.json({
        ...s,
        bySource,
        activeRouteName: lastRouteName,
        tileProvider: config ? config.tileProvider : null,
        format: config ? config.format : null,
        outputPaths,
        dbSizeBytes,
        assets: assetsStatus ?? computeAssetsState(),
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
        // A single target coordinate plots the great-circle corridor
        // from the vessel's current position to the target, not a
        // bubble around the target alone: a one-point corridor covers
        // only the destination, leaving the whole passage uncached.
        // Without a GPS fix we fall back to the target alone so the
        // panel still works before navigation.position is published.
        let coordinates = body.coordinates;
        let name = body.name || "Custom target";
        if (coordinates.length === 1) {
          const vessel = getVesselPosition();
          if (vessel) {
            coordinates = [vessel, ...coordinates];
            if (!body.name) name = `Target from vessel to ${coordinates[1]}`;
          }
        }
        const { totalTiles } = startJob(
          coordinates,
          name,
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
        for (const source of activeSourceConfigs()) {
          ensureStoreFor(source).vacuum();
        }
        releaseStoresIfIdle();
        res.json({ status: "vacuum_complete" });
      } catch (err) {
        errorResponse(res, err);
      }
    });

    // ----------------------------------------------------------------
    // Mirror asset routes (BATHYMETRY.md STEP 10)
    // ----------------------------------------------------------------

    /** The machine discovery contract for the offline mirror. */
    router.get("/assets/manifest.json", (req, res) => {
      const baseUrl = baseUrlFromRequest(req);
      const style = readMirrorStyle();
      const manifest = {
        sprites: {},
        glyphs: `${baseUrl}/plugins/${PLUGIN_ID}/assets/fonts/{fontstack}/{range}.pbf`,
        fonts: cachedFontStacks(),
        sources: activeSourceConfigs().map((source) => source.id),
      };
      // The style link appears only once the mirror is complete
      // enough to serve it (clients fall back otherwise).
      if (style != null) {
        manifest.style = `${baseUrl}/plugins/${PLUGIN_ID}/assets/style.json`;
        manifest.styleOl = `${baseUrl}/plugins/${PLUGIN_ID}/assets/style-ol.json`;
        for (const entry of collectSpriteEntries(style)) {
          manifest.sprites[entry.id] =
            `${baseUrl}/plugins/${PLUGIN_ID}/assets/sprites/${entry.id}`;
        }
      }
      res.json(manifest);
    });

    /** The mirrored style, URLs rewritten to local endpoints. */
    router.get("/assets/style.json", (req, res) => {
      const style = readMirrorStyle();
      if (style == null) {
        res.status(404).json({ message: "Style not mirrored" });
        return;
      }
      res.json(transformStyle(style, baseUrlFromRequest(req)));
    });

    /**
     * The OpenLayers-compatible style variant for Freeboard SK
     * (ol-mapbox-style): same URL rewriting as `/assets/style.json`,
     * minus layers OL cannot render. Dropped most notably is the
     * `color-relief` depth shading — in ol-mapbox-style it does not
     * merely render nothing, it rejects the whole `apply()` call —
     * and `icon-image` `image` expressions are unwrapped so the
     * seamark symbols (lights, buoys, topmarks) render instead of
     * styling every feature to nothing.
     */
    router.get("/assets/style-ol.json", (req, res) => {
      const style = readMirrorStyle();
      if (style == null) {
        res.status(404).json({ message: "Style not mirrored" });
        return;
      }
      res.json(
        transformStyle(style, baseUrlFromRequest(req), { olCompatible: true }),
      );
    });

    /**
     * Sprite sheet files: `<spriteId>.json|.png` and `@2x` variants.
     * The id must be one the mirrored style references (no traversal).
     */
    router.get("/assets/sprites/:file", (req, res) => {
      const match = /^(.+?)(@2x)?\.(json|png)$/.exec(req.params.file ?? "");
      if (match == null) {
        res.status(404).json({ message: "Unknown sprite file" });
        return;
      }
      const [, spriteId, variant, ext] = match;
      const known = collectSpriteEntries(readMirrorStyle()).some(
        (entry) => entry.id === spriteId,
      );
      if (!known) {
        res.status(404).json({ message: "Unknown sprite id" });
        return;
      }
      sendMirroredFile(
        res,
        spriteFilePath(spriteId, variant ?? "", ext),
        ext === "json" ? "application/json" : "image/png",
      );
    });

    /** Glyph range files, one `{n}-{n+255}.pbf` per cached stack. */
    router.get("/assets/fonts/:fontstack/:range", (req, res) => {
      let stack;
      try {
        stack = decodeURIComponent(req.params.fontstack ?? "");
      } catch {
        res.status(404).json({ message: "Unknown font stack" });
        return;
      }
      if (!cachedFontStacks().includes(stack)) {
        res.status(404).json({ message: "Unknown font stack" });
        return;
      }
      const match = /^(\d+)-(\d+)\.pbf$/.exec(req.params.range ?? "");
      if (match == null) {
        res.status(404).json({ message: "Unknown glyph range" });
        return;
      }
      const [lo, hi] = [Number(match[1]), Number(match[2])];
      if (
        lo % GLYPH_RANGE_STEP !== 0 ||
        hi !== lo + GLYPH_RANGE_STEP - 1 ||
        lo + GLYPH_RANGE_STEP - 1 > GLYPH_MAX_CODEPOINT
      ) {
        res.status(404).json({ message: "Unknown glyph range" });
        return;
      }
      const file = fontFilePath(stack, match[0].slice(0, -4));
      // Path-traversal backstop: the resolved path must stay under the
      // mirror's fonts root (stack ids come from a known-set check,
      // this guards a future refactor).
      const fontsRoot = mirrorDir()
        ? path.resolve(path.join(mirrorDir(), "fonts"))
        : null;
      if (
        file == null ||
        fontsRoot == null ||
        !path.resolve(file).startsWith(`${fontsRoot}${path.sep}`)
      ) {
        res.status(404).json({ message: "Unknown glyph range" });
        return;
      }
      sendMirroredFile(res, file, "application/x-protobuf", true);
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
module.exports.sourcePath = sourcePath;
module.exports.glyphRangeNames = glyphRangeNames;
module.exports.resolveConfig = resolveConfig;
module.exports.formatForUrlTemplate = formatForUrlTemplate;
module.exports.unwrapImageExpressions = unwrapImageExpressions;
module.exports.unionBounds = unionBounds;
module.exports.parseBoundsMetadata = parseBoundsMetadata;
