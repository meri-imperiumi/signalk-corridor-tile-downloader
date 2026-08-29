const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const pluginFactory = require("../index.js");
const { MbTilesStore } = require("../lib/mbtiles.js");

const PNG = Buffer.concat([
  require("../lib/downloader.js").PNG_SIGNATURE,
  Buffer.alloc(592, 0x89),
]);

/**
 * Mock Signal K app: plugin status/error recorders, configurable
 * getSelfPath/getPath trees, and a stub router recording REST routes.
 */
function createMockApp() {
  let status = "";
  let error = "";
  const deltaHandlers = [];
  const subscriptions = [];
  const router = {
    routes: [],
    get(pathName, handler) {
      this.routes.push({ method: "get", path: pathName, handler });
    },
    post(pathName, handler) {
      this.routes.push({ method: "post", path: pathName, handler });
    },
    put(pathName, handler) {
      this.routes.push({ method: "put", path: pathName, handler });
    },
  };
  return {
    debug: () => {},
    error: () => {},
    setPluginStatus: (s) => {
      status = s;
    },
    getPluginStatus: () => status,
    setPluginError: (s) => {
      error = s;
    },
    getPluginError: () => error,
    subscriptionmanager: {
      subscribe: (subscription, _unsubscribes, _onError, onDelta) => {
        subscriptions.push(subscription);
        deltaHandlers.push(onDelta);
      },
    },
    getDeltaHandlers: () => deltaHandlers,
    getSubscriptions: () => subscriptions,
    selfTree: {},
    getSelfPath(p) {
      return this.selfTree[p];
    },
    pathTree: {},
    getPath(p) {
      return this.pathTree[p];
    },
    router,
    dataDir: null,
    getDataDirPath() {
      return this.dataDir;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

/** Realistic image/png response headers. */
const pngHeaders = {
  get: (name) => (name.toLowerCase() === "content-type" ? "image/png" : null),
};

/** Realistic application/x-protobuf response headers. */
const pbfHeaders = {
  get: (name) =>
    name.toLowerCase() === "content-type" ? "application/x-protobuf" : null,
};

/** Minimal Mapbox Vector Tile: one layer named "seamark". */
const MVT = Buffer.concat([
  Buffer.from([0x1a, 0x09, 0x12, 0x07]), // field 3 (layers), len 9: field 2 (name)
  Buffer.from("seamark"),
]);

function okPbfFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: pbfHeaders,
    arrayBuffer: async () => MVT,
  });
}

function okFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: pngHeaders,
    arrayBuffer: async () => PNG,
  });
}

/** Route handler lookup on the mock router. */
function route(app, method, pathName) {
  const found = app.router.routes.find(
    (r) => r.method === method && r.path === pathName,
  );
  assert.ok(found, `route ${method} ${pathName} registered`);
  return found.handler;
}

/** Signal K position delta for the subscribed handler. */
function positionDelta(lat, lon) {
  return {
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: lat, longitude: lon },
          },
        ],
      },
    ],
  };
}

/** Fetch stub counting calls while returning valid tile bodies. */
function countingFetch() {
  const calls = [];
  const fn = (url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: pngHeaders,
      arrayBuffer: async () => PNG,
    });
  };
  return { calls, fn };
}

const webpHeaders = {
  get: (n) => (n.toLowerCase() === "content-type" ? "image/webp" : null),
};
const jsonHeaders = {
  get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null),
};

/** Minimal WebP body: RIFF...WEBPVP8L signature (12-byte magic). */
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x4c,
]);

/** A small sprite-sheet PNG. */
const SPRITE_PNG = Buffer.concat([
  require("../lib/downloader.js").PNG_SIGNATURE,
  Buffer.alloc(100, 0x44),
]);

/**
 * The mirrored style's source ids must match the provider's source
 * table so the style transform rewrites them to local chart URLs.
 */
function openWatersStyle() {
  return {
    version: 8,
    name: "seamap",
    glyphs: "https://tiles.openwaters.io/fonts/{fontstack}/{range}.pbf",
    sprite: [
      {
        id: "freenauticalchart",
        url: "https://tiles.openwaters.io/seamap/sprites/freenauticalchart",
      },
    ],
    sources: {
      seamap: {
        type: "vector",
        tiles: ["https://tiles.openwaters.io/seamap/{z}/{x}/{y}.pbf"],
      },
      "seascape-vector": {
        type: "vector",
        tiles: ["https://tiles.openwaters.io/seascape/{z}/{x}/{y}.pbf"],
      },
      "seascape-coverage": {
        type: "vector",
        tiles: [
          "https://tiles.openwaters.io/seascape/coverage/{z}/{x}/{y}.pbf",
        ],
      },
      "versatiles-shortbread": {
        type: "vector",
        tiles: ["https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}"],
      },
      elevation: {
        type: "raster",
        tiles: ["https://tiles.versatiles.org/tiles/elevation/{z}/{x}/{y}"],
      },
      "seascape-dem": {
        type: "raster",
        tiles: ["https://tiles.openwaters.io/seascape/{z}/{x}/{y}.webp"],
      },
    },
    layers: [
      { id: "background", type: "background" },
      {
        id: "seamark",
        type: "symbol",
        source: "seamap",
        layout: { "text-font": ["Noto Sans Regular"] },
      },
    ],
  };
}

/**
 * URL-aware mock fetch for the Open Waters provider: serves the style,
 * sprites, font glyph ranges, pbf tiles and webp tiles with correct
 * content types so the full six-source mirror + assets phase runs.
 * Glyph ranges above 0-255 are 404 (absent upstream).
 */
function openWatersFetch(opts = {}) {
  const calls = [];
  const style = opts.style ?? openWatersStyle();
  const fn = (url) => {
    calls.push(url);
    if (url === "https://tiles.openwaters.io/seamap/style.json") {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: jsonHeaders,
        arrayBuffer: async () => Buffer.from(JSON.stringify(style)),
      });
    }
    if (url.includes("/sprites/")) {
      if (url.endsWith(".json")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: jsonHeaders,
          arrayBuffer: async () => Buffer.from("{}"),
        });
      }
      if (url.endsWith(".png")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: pngHeaders,
          arrayBuffer: async () => SPRITE_PNG,
        });
      }
    }
    if (url.includes("/fonts/")) {
      const m = /\/fonts\/(.+)\/(\d+)-(\d+)\.pbf$/.exec(url);
      if (!m)
        return Promise.resolve({ ok: false, status: 404, headers: undefined });
      // Only the first range exists upstream; the rest are 404s (skip)
      if (Number(m[2]) > 0) {
        return Promise.resolve({ ok: false, status: 404, headers: undefined });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: pbfHeaders,
        arrayBuffer: async () => require("node:zlib").gzipSync(MVT),
      });
    }
    if (url.endsWith(".webp") || url.includes("/tiles/elevation/")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: webpHeaders,
        arrayBuffer: async () => WEBP,
      });
    }
    // pbf tiles (seamap, seascape, coverage, versatiles osm)
    if (url.endsWith(".pbf") || url.includes("/tiles/osm/")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: pbfHeaders,
        arrayBuffer: async () => MVT,
      });
    }
    return Promise.resolve({ ok: false, status: 404, headers: undefined });
  };
  return { calls, fn };
}

/** Is a fetch URL a tile (not an asset)? */
const isTileUrl = (url) =>
  /\/\d+\/\d+\/\d+(\.pbf|\.webp)?$/.test(url) ||
  (url.includes("/tiles/") && !url.includes("/fonts/"));

function waitUntil(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setImmediate(check);
    };
    check();
  });
}

/** Sleep stub that yields to the macrotask queue (circuit-breaker tests). */
const yieldSleep = async () => {
  await new Promise((r) => setImmediate(r));
};

describe("plugin", () => {
  let app;
  let plugin;
  let dir;
  let dbPath;

  beforeEach(() => {
    app = createMockApp();
    plugin = pluginFactory(app);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-test-"));
    dbPath = path.join(dir, "passage_cache.mbtiles");
    app.dataDir = path.join(dir, "plugin-data");
  });

  afterEach(() => {
    plugin.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function startWithTestHooks(overrides = {}) {
    plugin.start({
      outputPath: dbPath,
      minZoom: 1,
      maxZoom: 1,
      strategicMarginNM: 0.1,
      tacticalMarginNM: 0.1,
      approachRadiusNM: 0.1,
      throttleMs: 0,
      fetch: okFetch,
      sleep: () => Promise.resolve(),
      // The raster (OpenSeaMap) pipeline is the default test bed; the
      // vector provider has its own tests below
      tileProvider: "OpenSeaMap",
      ...overrides,
    });
  }

  test("start() sweeps stale WAL sidecars left around the cache", () => {
    // A previous charts-provider housekeeping strike can leave sidecar
    // files behind. The sweep opens and closes our store, whose clean
    // close checkpoints and removes them — so the provider's own
    // startup cleanup finds nothing to delete and the boot-order race
    // over live sidecars cannot recur, and any stale wal-index is
    // reconciled by the read-write pass.
    const seed = new MbTilesStore(dbPath);
    seed.insertTile(8, 1, 1, Buffer.from([1]));
    seed.close();
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(0));
    fs.writeFileSync(`${dbPath}-shm`, Buffer.alloc(0));

    startWithTestHooks();

    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${dbPath}-shm`), false);

    const reader = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM tiles").get().n, 1);
    reader.close();
  });

  test("registers REST routes, subscriptions and reports idle status", () => {
    startWithTestHooks();
    plugin.registerWithRouter(app.router);

    // Addendum 5 wiring: position (recovery triggers) + internet state
    // (immediate wake) subscriptions
    const subscription = app.getSubscriptions()[0];
    assert.ok(subscription);
    assert.deepEqual(
      subscription.subscribe.map((s) => s.path),
      ["navigation.position", "network.internet.state"],
    );

    const res = makeRes();
    route(app, "get", "/status")({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isDownloading, false);
    assert.equal(res.body.state, "idle");
    assert.equal(typeof res.body.dbSizeBytes, "object");
    assert.equal(res.body.dbSizeBytes.seamap, 0);
    assert.equal(res.body.outputPaths.seamap, dbPath);
    assert.equal(res.body.activeRouteName, null);
    assert.equal(res.body.tileProvider, "OpenSeaMap");
    assert.equal(res.body.format, "png");
  });

  test("cache file is created lazily with real bounds on first fetch", () => {
    startWithTestHooks();
    plugin.registerWithRouter(app.router);

    // Idle: no cache file, no WAL sidecars — nothing for
    // charts-provider-simple housekeeping to trip over
    assert.ok(!fs.existsSync(dbPath));
    assert.ok(!fs.existsSync(`${dbPath}-wal`));
    const idle = makeRes();
    route(app, "get", "/status")({}, idle);
    assert.equal(idle.body.dbSizeBytes.seamap, 0);
    assert.equal(idle.body.outputPaths.seamap, dbPath);

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: -18.85, lon: -159.78 }] } }, res);
    assert.equal(res.statusCode, 200);

    const reader = new DatabaseSync(dbPath);
    const meta = Object.fromEntries(
      reader
        .prepare("SELECT name, value FROM metadata")
        .all()
        .map((r) => [r.name, r.value]),
    );
    reader.close();
    assert.notEqual(meta.bounds, "0,0,0,0");
  });

  test("notifies the charts provider after tiles land", async () => {
    const notifyCalls = [];
    startWithTestHooks({ notify: () => notifyCalls.push(1) });
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )(
      {
        body: {
          coordinates: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 0.5 },
          ],
        },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.totalTiles > 0);

    await waitUntil(() => notifyCalls.length > 0);
    // The refresh fires when the first tile lands (onTileStored) and
    // again at job completion (onSettled) — never a storm, but >= 1
    assert.ok(notifyCalls.length >= 1);
  });

  test("cancelled jobs with no tiles do not notify the provider", async () => {
    let resolveFetch;
    const slowFetch = () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }).then(() => ({
        ok: true,
        status: 200,
        headers: pngHeaders,
        arrayBuffer: async () => PNG,
      }));
    const notifyCalls = [];
    startWithTestHooks({ fetch: slowFetch, notify: () => notifyCalls.push(1) });
    plugin.registerWithRouter(app.router);

    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, makeRes());
    await waitUntil(() => resolveFetch !== undefined);
    route(app, "post", "/cancel")({}, makeRes());
    resolveFetch();
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return !s.body.isDownloading;
    });
    assert.equal(notifyCalls.length, 0);
  });

  test("fetch-target starts a job that downloads tiles into the store", async () => {
    startWithTestHooks();
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )(
      {
        body: {
          coordinates: [
            { lat: -18.85, lon: -159.78 },
            { lat: -19.05, lon: -169.85 },
          ],
        },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "started");
    assert.ok(res.body.totalTiles > 0);

    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });

    const s = makeRes();
    route(app, "get", "/status")({}, s);
    assert.equal(s.body.isDownloading, false);
    assert.equal(s.body.failed, 0);
    assert.equal(s.body.completed, res.body.totalTiles);
    assert.equal(s.body.activeRouteName, "Custom target");
    assert.ok(s.body.dbSizeBytes.seamap > 0);

    // Tiles really landed in the file, readable by a concurrent
    // connection (the charts-provider-simple handoff)
    const reader = new DatabaseSync(dbPath);
    const rows = reader.prepare("SELECT COUNT(*) AS n FROM tiles").get();
    reader.close();
    assert.equal(rows.n, res.body.totalTiles);
  });

  test("fetch-target rejects invalid bodies", () => {
    startWithTestHooks();
    plugin.registerWithRouter(app.router);

    for (const body of [{}, { coordinates: [] }, { coordinates: "no" }]) {
      const res = makeRes();
      route(app, "post", "/fetch-target")({ body }, res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
  });

  test("fetch-active-route without an active route returns 404", () => {
    startWithTestHooks();
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(app, "post", "/fetch-active-route")({}, res);
    assert.equal(res.statusCode, 404);
    assert.ok(res.body.message);
  });

  test("fetch-active-route uses the route resource and records its name", async () => {
    app.selfTree["navigation.course.activeRoute.href"] =
      "/signalk/v1/api/resources/routes/urn:mrn:signalk:uuid:1234";
    app.pathTree["resources.routes.urn:mrn:signalk:uuid:1234"] = {
      type: "Feature",
      properties: { name: "Aitutaki to Niue" },
      geometry: {
        type: "LineString",
        coordinates: [
          [-159.78, -18.85],
          [-169.85, -19.05],
        ],
      },
    };
    startWithTestHooks();
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(app, "post", "/fetch-active-route")({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "started");

    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    const s = makeRes();
    route(app, "get", "/status")({}, s);
    assert.equal(s.body.activeRouteName, "Aitutaki to Niue");

    // Metadata handoff for the consumer plugin
    const reader = new DatabaseSync(dbPath);
    const meta = Object.fromEntries(
      reader
        .prepare("SELECT name, value FROM metadata")
        .all()
        .map((r) => [r.name, r.value]),
    );
    reader.close();
    assert.equal(meta.minzoom, "1");
    assert.equal(meta.maxzoom, "1");
    const bounds = meta.bounds.split(",").map(Number);
    assert.ok(bounds[0] < -159 && bounds[2] > -170);
    assert.ok(bounds[1] < -18 && bounds[3] > -19.2);
  });

  test("busy job rejects concurrent fetches with 409", async () => {
    let resolveFetch;
    const slowFetch = () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }).then(() => ({
        ok: true,
        status: 200,
        headers: pngHeaders,
        arrayBuffer: async () => PNG,
      }));
    startWithTestHooks({ fetch: slowFetch });
    plugin.registerWithRouter(app.router);

    const started = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )(
      {
        body: {
          coordinates: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
          ],
        },
      },
      started,
    );
    assert.equal(started.statusCode, 200);
    // Wait until the first fetch is actually in flight
    await waitUntil(() => resolveFetch !== undefined);

    const busy = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 1, lon: 1 }] } }, busy);
    assert.equal(busy.statusCode, 409);

    const vacuum = makeRes();
    route(app, "post", "/vacuum")({}, vacuum);
    assert.equal(vacuum.statusCode, 409);

    const cancelled = makeRes();
    route(app, "post", "/cancel")({}, cancelled);
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.body.status, "cancelled");
    resolveFetch();
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return !s.body.isDownloading;
    });
  });

  test("vacuum completes when idle", () => {
    startWithTestHooks();
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(app, "post", "/vacuum")({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "vacuum_complete");
  });

  test("fetches from the selected provider's URL (Addendum 6)", async () => {
    const fetch = countingFetch();
    startWithTestHooks({ fetch: fetch.fn });
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
    assert.equal(res.statusCode, 200);
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    assert.ok(fetch.calls.length > 0);
    assert.ok(
      fetch.calls.every((url) =>
        url.startsWith("https://tiles.openseamap.org/seamark/"),
      ),
      "selected provider is OpenSeaMap",
    );
  });

  test("vector corridor downloads pbf tiles into a pbf cache", async () => {
    const fetch = openWatersFetch();
    startWithTestHooks({
      tileProvider: "Open Waters Seamap",
      fetch: fetch.fn,
    });
    plugin.registerWithRouter(app.router);

    const status = makeRes();
    route(app, "get", "/status")({}, status);
    assert.equal(status.body.format, "pbf");
    assert.equal(status.body.tileProvider, "Open Waters Seamap");

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
    assert.equal(res.statusCode, 200);
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    // pbf tile URLs (seamap) end in .pbf; the mock also fetched style,
    // sprites and glyph ranges — filter those out
    const tileCalls = fetch.calls.filter(isTileUrl);
    assert.ok(tileCalls.length > 0);
    assert.ok(
      tileCalls
        .filter((url) => url.includes("/seamap/"))
        .every((url) => url.endsWith(".pbf")),
      "seamap vector provider URL template used",
    );

    const reader = new DatabaseSync(dbPath);
    const meta = Object.fromEntries(
      reader
        .prepare("SELECT name, value FROM metadata")
        .all()
        .map((r) => [r.name, r.value]),
    );
    const rows = reader.prepare("SELECT tile_data FROM tiles").all();
    reader.close();
    assert.equal(meta.format, "pbf");
    assert.deepEqual(
      JSON.parse(meta.vector_layers).map((l) => l.id),
      pluginFactory.TILE_PROVIDERS["Open Waters Seamap"].vectorLayers,
    );
    // Stored blobs are gzip-wrapped (the MBTiles vector convention the
    // consumer serves with Content-Encoding: gzip)
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.tile_data[0], 0x1f);
      assert.equal(row.tile_data[1], 0x8b);
    }
  });

  test("empty vector tiles (HTTP 204) are cached as gzipped empties", async () => {
    const ow = openWatersFetch();
    // Override: pbf tiles get 204 (empty ocean), everything else
    // (webp tiles, style, sprites, fonts) routes through the mock
    const fn = (url) => {
      if (
        (url.endsWith(".pbf") || url.includes("/tiles/osm/")) &&
        !url.includes("/fonts/")
      ) {
        return Promise.resolve({
          ok: true,
          status: 204,
          headers: pbfHeaders,
          arrayBuffer: async () => Buffer.alloc(0),
        });
      }
      return ow.fn(url);
    };
    startWithTestHooks({
      tileProvider: "Open Waters Seamap",
      fetch: fn,
    });
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
    assert.equal(res.statusCode, 200);
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    const done = makeRes();
    route(app, "get", "/status")({}, done);
    assert.equal(done.body.completed, res.body.totalTiles);

    // A stored empty tile keeps recovery checks from refetching it
    // (seamap store only — other sources are in sibling files)
    const reader = new DatabaseSync(dbPath);
    const rows = reader.prepare("SELECT tile_data FROM tiles").all();
    reader.close();
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.tile_data[0], 0x1f);
      assert.equal(row.tile_data[1], 0x8b);
    }
  });

  test("a filled png cache refuses vector downloads (format guard)", async () => {
    startWithTestHooks();
    plugin.registerWithRouter(app.router);
    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
    assert.equal(res.statusCode, 200);
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });

    // Switch to the vector provider against the same filled png file
    app.router.routes.length = 0;
    plugin = pluginFactory(app);
    startWithTestHooks({
      tileProvider: "Open Waters Seamap",
      fetch: () => okPbfFetch(),
    });
    plugin.registerWithRouter(app.router);
    const busy = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, busy);
    assert.equal(busy.statusCode, 409);
    assert.match(busy.body.message, /holds png tiles/);
  });

  test("stop() closes the store (further fetches are 503)", () => {
    startWithTestHooks();
    plugin.registerWithRouter(app.router);
    plugin.stop();

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
    assert.equal(res.statusCode, 503);
  });

  test("unparseable string bodies are rejected", () => {
    startWithTestHooks();
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(app, "post", "/fetch-target")({ body: "{not json" }, res);
    assert.equal(res.statusCode, 400);
  });

  test("position drift triggers a recovery bubble download (Addendum 5)", async () => {
    const fetch = countingFetch();
    startWithTestHooks({ minZoom: 8, maxZoom: 12, fetch: fetch.fn });
    plugin.registerWithRouter(app.router);
    const onDelta = app.getDeltaHandlers()[0];

    // First fix only establishes the baseline
    onDelta(positionDelta(0, 0));
    let res = makeRes();
    route(app, "get", "/status")({}, res);
    assert.equal(res.body.state, "idle");

    // 1.2 NM of movement triggers verification: the 5 NM bubble at
    // z8-12 has missing tiles, so a recovery job starts
    onDelta(positionDelta(0.02, 0));
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    res = makeRes();
    route(app, "get", "/status")({}, res);
    assert.equal(res.body.jobType, "recovery");
    assert.ok(res.body.completed > 0);
    assert.equal(res.body.completed, fetch.calls.length);

    // The bubble tiles really are cached
    const reader = new DatabaseSync(dbPath);
    const rows = reader.prepare("SELECT COUNT(*) AS n FROM tiles").get();
    reader.close();
    assert.equal(rows.n, res.body.completed);
  });

  test("position verification is throttled to 1 NM of movement", async () => {
    const fetch = countingFetch();
    startWithTestHooks({ minZoom: 8, maxZoom: 12, fetch: fetch.fn });
    plugin.registerWithRouter(app.router);
    const onDelta = app.getDeltaHandlers()[0];

    onDelta(positionDelta(0, 0)); // baseline
    onDelta(positionDelta(0.005, 0)); // 0.3 NM
    onDelta(positionDelta(0.008, 0)); // 0.48 NM from baseline
    const res = makeRes();
    route(app, "get", "/status")({}, res);
    assert.equal(res.body.state, "idle");
    assert.equal(fetch.calls.length, 0);

    onDelta(positionDelta(0.02, 0)); // 1.2 NM from baseline
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    assert.ok(fetch.calls.length > 0);
  });

  test("re-verification only queues missing tiles", async () => {
    const fetch = countingFetch();
    startWithTestHooks({ minZoom: 8, maxZoom: 12, fetch: fetch.fn });
    plugin.registerWithRouter(app.router);
    const onDelta = app.getDeltaHandlers()[0];

    onDelta(positionDelta(0, 0));
    onDelta(positionDelta(0.02, 0));
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    const fetched = fetch.calls.length;
    assert.ok(fetched > 0);

    // Drift again: everything in the new bubble is already cached, so
    // no new job and no new fetches
    onDelta(positionDelta(0.04, 0));
    await new Promise((r) => setTimeout(r, 25));
    res = makeRes();
    route(app, "get", "/status")({}, res);
    assert.equal(fetch.calls.length, fetched);
    assert.equal(res.body.state, "completed");
  });

  test("recovery defaults to allowed on metered, configurable off", async () => {
    app.selfTree["network.internet.state.value"] = "metered";
    const fetch = countingFetch();
    startWithTestHooks({ minZoom: 8, maxZoom: 12, fetch: fetch.fn });
    plugin.registerWithRouter(app.router);
    const onDelta = app.getDeltaHandlers()[0];

    // Default allowRecoveryOnMetered: true -> recovery runs on metered
    onDelta(positionDelta(0, 0));
    onDelta(positionDelta(0.02, 0));
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    assert.ok(fetch.calls.length > 0);
  });

  test("recovery suspends on metered when disallowed", async () => {
    app.selfTree["network.internet.state.value"] = "metered";
    const fetch = countingFetch();
    startWithTestHooks({
      minZoom: 8,
      maxZoom: 12,
      fetch: fetch.fn,
      sleep: yieldSleep,
      allowRecoveryOnMetered: false,
    });
    plugin.registerWithRouter(app.router);
    const onDelta = app.getDeltaHandlers()[0];

    onDelta(positionDelta(0, 0));
    onDelta(positionDelta(0.02, 0));
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.suspended === true;
    });
    const res = makeRes();
    route(app, "get", "/status")({}, res);
    assert.equal(res.body.jobType, "recovery");
    assert.equal(fetch.calls.length, 0);

    const cancel = makeRes();
    route(app, "post", "/cancel")({}, cancel);
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return !s.body.isDownloading;
    });
  });

  test("passage fetch preempts a suspended recovery job", async () => {
    app.selfTree["network.internet.state.value"] = "offline";
    const fetch = countingFetch();
    startWithTestHooks({
      minZoom: 8,
      maxZoom: 12,
      fetch: fetch.fn,
      sleep: yieldSleep,
    });
    plugin.registerWithRouter(app.router);
    const onDelta = app.getDeltaHandlers()[0];

    // Recovery job starts but suspends offline
    onDelta(positionDelta(0, 0));
    onDelta(positionDelta(0.02, 0));
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.suspended === true && s.body.jobType === "recovery";
    });

    // The user's passage download is not blocked by the safety cache
    const started = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )(
      {
        body: {
          coordinates: [
            { lat: 0.05, lon: 0.1 },
            { lat: 0.05, lon: 0.2 },
          ],
        },
      },
      started,
    );
    assert.equal(started.statusCode, 200);
    let res = makeRes();
    route(app, "get", "/status")({}, res);
    assert.equal(res.body.jobType, "passage");
    assert.ok(res.body.recoveryPending > 0);

    // Connectivity returns: recovery tiles drain first, passage completes
    app.selfTree["network.internet.state.value"] = "online";
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    res = makeRes();
    route(app, "get", "/status")({}, res);
    assert.equal(res.body.recoveryPending, 0);
    assert.ok(res.body.completed >= started.body.totalTiles);

    const reader = new DatabaseSync(dbPath);
    const rows = reader.prepare("SELECT COUNT(*) AS n FROM tiles").get();
    reader.close();
    assert.ok(rows.n >= started.body.totalTiles);
  });

  test("circuit breaker suspends on offline and resumes on online", async () => {
    app.selfTree["network.internet.state.value"] = "offline";
    startWithTestHooks({ sleep: yieldSleep });
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )(
      {
        body: {
          coordinates: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
          ],
        },
      },
      res,
    );
    assert.equal(res.statusCode, 200);

    // Suspended: running, but nothing fetched
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.suspended === true;
    });
    const suspended = makeRes();
    route(app, "get", "/status")({}, suspended);
    assert.equal(suspended.body.completed, 0);
    assert.equal(suspended.body.suspendReason, "offline");

    // Connectivity returns; the job completes on its own
    app.selfTree["network.internet.state.value"] = "online";
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    const done = makeRes();
    route(app, "get", "/status")({}, done);
    assert.equal(done.body.completed, res.body.totalTiles);
    assert.equal(done.body.suspended, false);
  });

  test("metered connection suspends unless forceOnMetered is sent", async () => {
    app.selfTree["network.internet.state.value"] = "metered";
    startWithTestHooks({ sleep: yieldSleep });
    plugin.registerWithRouter(app.router);

    // Without the override the job suspends
    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
    assert.equal(res.statusCode, 200);
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.suspended === true;
    });

    // Cancel it, then start with the metered override: it completes
    route(app, "post", "/cancel")({}, makeRes());
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return !s.body.isDownloading;
    });

    const forced = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )(
      {
        body: {
          coordinates: [{ lat: 0, lon: 0 }],
          forceOnMetered: true,
        },
      },
      forced,
    );
    assert.equal(forced.statusCode, 200);
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
    const done = makeRes();
    route(app, "get", "/status")({}, done);
    assert.equal(done.body.forceOnMetered, true);
    assert.equal(done.body.completed, forced.body.totalTiles);
  });

  describe("restart resume", () => {
    /** Path of the restart journal inside the mock data dir. */
    function pendingJobFile() {
      return path.join(app.dataDir, pluginFactory.PENDING_JOB_FILENAME);
    }

    /**
     * Fetch stub whose responses are released one by one by the test,
     * so a job can be stopped with exactly N tiles landed.
     */
    function gatedFetch() {
      const gates = [];
      const fn = () => {
        let resolve;
        const promise = new Promise((r) => {
          resolve = r;
        });
        gates.push(resolve);
        return promise.then(() => ({
          ok: true,
          status: 200,
          headers: pngHeaders,
          arrayBuffer: async () => PNG,
        }));
      };
      return { gates, fn };
    }

    test("stop() keeps the journal; a restart resumes only missing tiles", async () => {
      const fetch1 = gatedFetch();
      startWithTestHooks({ fetch: fetch1.fn });
      plugin.registerWithRouter(app.router);

      const res = makeRes();
      route(
        app,
        "post",
        "/fetch-target",
      )(
        {
          body: {
            coordinates: [
              { lat: 0, lon: 0 },
              { lat: 0, lon: 0.5 },
            ],
          },
        },
        res,
      );
      assert.equal(res.statusCode, 200);
      const total = res.body.totalTiles;
      assert.ok(total >= 2, "corridor has multiple tiles");

      // Land exactly one tile, leave the second in flight
      await waitUntil(() => fetch1.gates.length > 0);
      fetch1.gates[0]();
      await waitUntil(() => fetch1.gates.length === 2);

      // The running job is journaled: restart-safe
      const running = makeRes();
      route(app, "get", "/status")({}, running);
      assert.equal(running.body.resumable, true);

      // Simulate a restart: stop keeps the journal (unlike /cancel)
      plugin.stop();
      assert.ok(fs.existsSync(pendingJobFile()));
      const intent = JSON.parse(fs.readFileSync(pendingJobFile(), "utf8"));
      assert.equal(intent.version, 2);
      assert.equal(intent.routeName, "Custom target");
      assert.equal(intent.outputPath, dbPath);
      assert.equal(intent.coordinates.length, 2);
      assert.equal(intent.minZoom, 1);
      assert.equal(intent.maxZoom, 1);
      // v2 journals persist the source list with derived paths and
      // per-source zoom caps (BATHYMETRY.md STEP 7)
      assert.ok(Array.isArray(intent.sources));
      assert.equal(intent.sources.length, 1);
      assert.equal(intent.sources[0].id, "seamap");
      assert.equal(intent.sources[0].path, dbPath);
      assert.equal(intent.sources[0].maxZoom, 1);

      // Fresh plugin instance over the same cache and journal (the
      // mock router must forget the stopped instance's handlers)
      app.router.routes.length = 0;
      const fetch2 = countingFetch();
      plugin = pluginFactory(app);
      startWithTestHooks({ fetch: fetch2.fn });
      plugin.registerWithRouter(app.router);

      await waitUntil(() => {
        const s = makeRes();
        route(app, "get", "/status")({}, s);
        return s.body.state === "completed";
      });
      const done = makeRes();
      route(app, "get", "/status")({}, done);
      assert.equal(done.body.routeName, "Custom target");
      assert.equal(done.body.completed, total - 1);
      // Only the tiles the interrupted job still lacked were fetched
      assert.equal(fetch2.calls.length, total - 1);
      assert.ok(!fs.existsSync(pendingJobFile()));
      assert.equal(done.body.resumable, false);
    });

    test("user cancel retires the journal; no resurrection after restart", async () => {
      const fetch1 = gatedFetch();
      startWithTestHooks({ fetch: fetch1.fn });
      plugin.registerWithRouter(app.router);
      const res = makeRes();
      route(
        app,
        "post",
        "/fetch-target",
      )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
      assert.equal(res.statusCode, 200);
      await waitUntil(() => fetch1.gates.length > 0);

      route(app, "post", "/cancel")({}, makeRes());
      fetch1.gates[0]();
      await waitUntil(() => {
        const s = makeRes();
        route(app, "get", "/status")({}, s);
        return !s.body.isDownloading;
      });
      assert.ok(!fs.existsSync(pendingJobFile()));

      // Restart: nothing resumes
      app.router.routes.length = 0;
      const fetch2 = countingFetch();
      plugin = pluginFactory(app);
      startWithTestHooks({ fetch: fetch2.fn });
      plugin.registerWithRouter(app.router);
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      assert.equal(s.body.state, "idle");
      assert.equal(fetch2.calls.length, 0);
    });

    test("resume rebuilds the corridor from the journaled geometry", async () => {
      const fetch1 = gatedFetch();
      startWithTestHooks({ fetch: fetch1.fn });
      plugin.registerWithRouter(app.router);
      const res = makeRes();
      route(
        app,
        "post",
        "/fetch-target",
      )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
      await waitUntil(() => fetch1.gates.length > 0);
      plugin.stop();

      // Restart with a wider zoom range in the live config: the
      // resumed corridor keeps the journaled z1 shape
      app.router.routes.length = 0;
      const fetch2 = countingFetch();
      plugin = pluginFactory(app);
      startWithTestHooks({ fetch: fetch2.fn, maxZoom: 3 });
      plugin.registerWithRouter(app.router);
      await waitUntil(() => {
        const s = makeRes();
        route(app, "get", "/status")({}, s);
        return s.body.state === "completed";
      });
      assert.ok(fetch2.calls.length > 0);
      assert.ok(
        fetch2.calls.every((url) => /\/1\/\d+\/\d+\.png$/.test(url)),
        "only journaled z1 tiles fetched",
      );
      assert.equal(fetch2.calls.length, res.body.totalTiles);
    });

    test("corrupt journals are discarded on startup", () => {
      fs.mkdirSync(app.dataDir, { recursive: true });
      fs.writeFileSync(pendingJobFile(), "{not json");
      const fetch = countingFetch();
      startWithTestHooks({ fetch: fetch.fn });
      plugin.registerWithRouter(app.router);

      const s = makeRes();
      route(app, "get", "/status")({}, s);
      assert.equal(s.body.state, "idle");
      assert.equal(fetch.calls.length, 0);
      assert.ok(!fs.existsSync(pendingJobFile()));
    });

    test("journals for another output path are kept but not resumed", () => {
      fs.mkdirSync(app.dataDir, { recursive: true });
      fs.writeFileSync(
        pendingJobFile(),
        JSON.stringify({
          version: 1,
          outputPath: "/tmp/elsewhere.mbtiles",
          routeName: "Old cache",
          forceOnMetered: false,
          coordinates: [{ lat: 0, lon: 0 }],
          minZoom: 1,
          maxZoom: 1,
          strategicMarginNM: 0.1,
          tacticalMarginNM: 0.1,
          approachRadiusNM: 0.1,
        }),
      );
      const fetch = countingFetch();
      startWithTestHooks({ fetch: fetch.fn });
      plugin.registerWithRouter(app.router);

      const s = makeRes();
      route(app, "get", "/status")({}, s);
      assert.equal(s.body.state, "idle");
      assert.equal(fetch.calls.length, 0);
      // Kept: resumes if the configuration is switched back
      assert.ok(fs.existsSync(pendingJobFile()));
      assert.equal(s.body.resumable, true);
    });

    test("jobs run without persistence when no data directory exists", async () => {
      app.dataDir = null;
      const fetch = countingFetch();
      startWithTestHooks({ fetch: fetch.fn });
      plugin.registerWithRouter(app.router);
      const res = makeRes();
      route(
        app,
        "post",
        "/fetch-target",
      )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
      assert.equal(res.statusCode, 200);
      await waitUntil(() => {
        const s = makeRes();
        route(app, "get", "/status")({}, s);
        return s.body.state === "completed";
      });
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      assert.equal(s.body.completed, res.body.totalTiles);
      assert.equal(s.body.resumable, false);
    });
  });
});

describe("configuration", () => {
  test("defaults match the SPEC", () => {
    const config = pluginFactory.resolveConfig({});
    assert.equal(config.strategicMarginNM, 50);
    assert.equal(config.tacticalMarginNM, 15);
    assert.equal(config.approachRadiusNM, 3);
    assert.equal(config.allowRecoveryOnMetered, true);
    assert.equal(config.minZoom, 8);
    assert.equal(config.maxZoom, 14);
    assert.equal(config.throttleMs, 500);
    // The vector Open Waters Seamap provider is the default (its
    // native zoom ceiling clamps maxZoom to 14)
    assert.equal(config.tileProvider, "Open Waters Seamap");
    assert.equal(config.format, "pbf");
    assert.ok(Array.isArray(config.sources));
    assert.equal(config.sources.length, 6);
    assert.equal(
      config.styleUrl,
      "https://tiles.openwaters.io/seamap/style.json",
    );
    assert.deepEqual(config.vectorLayers, [
      "land",
      "light",
      "sea_area",
      "seamark",
      "water",
      "waterway",
      "wetland",
    ]);
    assert.equal(
      config.tileServerUrl,
      "https://tiles.openwaters.io/seamap/{z}/{x}/{y}.pbf",
    );
    assert.equal(config.userAgent, "SignalK-Corridor-Downloader/1.0");
    assert.ok(config.outputPath.endsWith("passage_cache.mbtiles"));
  });

  test("tile provider selection drives the default URL template (Addendum 6)", () => {
    const providers = pluginFactory.TILE_PROVIDERS;
    const openSeaMap = pluginFactory.resolveConfig({
      tileProvider: "OpenSeaMap",
    });
    assert.equal(openSeaMap.tileProvider, "OpenSeaMap");
    assert.equal(openSeaMap.tileServerUrl, providers.OpenSeaMap.urlTemplate);
    assert.equal(openSeaMap.format, "png");
    assert.equal(openSeaMap.vectorLayers, null);

    const openWaters = pluginFactory.resolveConfig({
      tileProvider: "Open Waters Seamap",
    });
    assert.equal(openWaters.tileServerUrl, openWaters.tileServerUrl);
    assert.equal(openWaters.format, "pbf");
    assert.ok(openWaters.vectorLayers.includes("seamark"));

    // A stored default template is derived, not custom: it follows the
    // provider selection
    const switched = pluginFactory.resolveConfig({
      tileServerUrl: providers.OpenSeaMap.urlTemplate,
    });
    assert.equal(switched.tileServerUrl, providers.OpenSeaMap.urlTemplate);

    // A custom template overrides the provider default
    const custom = pluginFactory.resolveConfig({
      tileServerUrl: "https://tiles.example.org/{z}/{x}/{y}.png",
    });
    assert.equal(
      custom.tileServerUrl,
      "https://tiles.example.org/{z}/{x}/{y}.png",
    );

    // Legacy configs naming the retired Open Waters *raster* endpoint
    // (the pre-vector .png default) follow the selection to the current
    // vector template instead of clinging to the dead endpoint
    const legacy = pluginFactory.resolveConfig({
      tileProvider: "Open Waters Seamap",
      tileServerUrl: "https://tiles.openwaters.io/seamap/{z}/{x}/{y}.png",
    });
    assert.equal(legacy.tileProvider, "Open Waters Seamap");
    assert.equal(
      legacy.tileServerUrl,
      providers["Open Waters Seamap"].urlTemplate,
    );
    assert.equal(legacy.format, "pbf");

    // Unknown values fall back to the default provider
    assert.equal(
      pluginFactory.resolveConfig({ tileProvider: "Nope" }).tileProvider,
      pluginFactory.DEFAULT_TILE_PROVIDER,
    );
  });

  test("the vector provider's native zoom ceiling clamps maxZoom", () => {
    const config = pluginFactory.resolveConfig({
      tileProvider: "Open Waters Seamap",
      minZoom: 10,
      maxZoom: 20,
    });
    // Ceiling is the highest native source maxZoom: z18 (the DEM)
    assert.equal(config.maxZoom, 18);
    assert.equal(config.minZoom, 10);

    // The raster provider has no ceiling beyond the general clamp
    const raster = pluginFactory.resolveConfig({
      tileProvider: "OpenSeaMap",
      minZoom: 10,
      maxZoom: 17,
    });
    assert.equal(raster.maxZoom, 17);
  });

  test("custom URLs infer the format from the template", () => {
    const vector = pluginFactory.resolveConfig({
      tileServerUrl: "https://tiles.example.org/mvt/{z}/{x}/{y}.pbf",
    });
    assert.equal(vector.format, "pbf");
    assert.equal(vector.vectorLayers, null); // schema unknown to us

    const raster = pluginFactory.resolveConfig({
      tileServerUrl: "https://tiles.example.org/{z}/{x}/{y}.png",
    });
    assert.equal(raster.format, "png");
  });

  test("legacy configs without tileProvider keep their OpenSeaMap source", () => {
    const config = pluginFactory.resolveConfig({
      tileServerUrl: pluginFactory.TILE_PROVIDERS.OpenSeaMap.urlTemplate,
    });
    assert.equal(config.tileProvider, "OpenSeaMap");
    assert.equal(config.format, "png");
    assert.equal(
      config.tileServerUrl,
      pluginFactory.TILE_PROVIDERS.OpenSeaMap.urlTemplate,
    );
  });

  test("custom tileServerUrl overrides the provider default", () => {
    const config = pluginFactory.resolveConfig({
      tileProvider: "OpenSeaMap",
      tileServerUrl: "https://tiles.example/{z}/{x}/{y}.png",
    });
    assert.equal(config.tileProvider, "OpenSeaMap");
    assert.equal(config.tileServerUrl, "https://tiles.example/{z}/{x}/{y}.png");
  });

  test("expandHome resolves ~ to the home directory", () => {
    const expanded = pluginFactory.expandHome("~/charts/cache.mbtiles");
    assert.ok(!expanded.startsWith("~"));
    // path.join uses the platform separator (backslash on Windows), so
    // compare against the canonical expanded form rather than a literal
    // forward-slash suffix.
    assert.equal(expanded, path.join(os.homedir(), "charts/cache.mbtiles"));
  });

  test("zoom order is normalized and bad URL templates fall back", () => {
    const config = pluginFactory.resolveConfig({
      minZoom: 14,
      maxZoom: 8,
      tileServerUrl: "https://tiles.example/no-placeholders.png",
    });
    assert.deepEqual([config.minZoom, config.maxZoom], [8, 14]);
    assert.equal(
      config.tileServerUrl,
      pluginFactory.TILE_PROVIDERS[pluginFactory.DEFAULT_TILE_PROVIDER]
        .urlTemplate,
    );
  });
});
