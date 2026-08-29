/**
 * BATHYMETRY.md spec tests: six-source mirror, style/assets, transform.
 *
 * Covers the 11 test areas listed in BATHYMETRY.md TESTS.
 */

const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

const pluginFactory = require("../index.js");
const { MbTilesStore } = require("../lib/mbtiles.js");
const {
  createDownloader,
  DEFAULT_SOURCE,
  PNG_SIGNATURE,
} = require("../lib/downloader.js");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MVT = Buffer.concat([
  Buffer.from([0x1a, 0x09, 0x12, 0x07]),
  Buffer.from("seamark"),
]);

const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x4c,
]);

const PNG = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(592, 0x89)]);

const pbfHeaders = {
  get: (n) =>
    n.toLowerCase() === "content-type" ? "application/x-protobuf" : null,
};
const webpHeaders = {
  get: (n) => (n.toLowerCase() === "content-type" ? "image/webp" : null),
};
const pngHeaders = {
  get: (n) => (n.toLowerCase() === "content-type" ? "image/png" : null),
};
const jsonHeaders = {
  get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null),
};

const SPRITE_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(100, 0x44)]);

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
      {
        id: "depth",
        type: "symbol",
        source: "seascape-vector",
        layout: { "text-font": ["Noto Sans Italic"] },
      },
    ],
  };
}

/** URL-aware mock fetch for the full Open Waters mirror. */
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
      // Only the first range exists upstream
      if (Number(m[2]) > 0)
        return Promise.resolve({ ok: false, status: 404, headers: undefined });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: pbfHeaders,
        arrayBuffer: async () => gzipSync(MVT),
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

// ---------------------------------------------------------------------------
// Mock Signal K app (same pattern as plugin.test.js)
// ---------------------------------------------------------------------------

function createMockApp() {
  const deltaHandlers = [];
  const subscriptions = [];
  const router = {
    routes: [],
    get(p, h) {
      this.routes.push({ method: "get", path: p, handler: h });
    },
    post(p, h) {
      this.routes.push({ method: "post", path: p, handler: h });
    },
  };
  return {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    subscriptionmanager: {
      subscribe: (_s, _u, _e, onDelta) => {
        subscriptions.push(_s);
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
  const headers = {};
  return {
    statusCode: 200,
    body: null,
    headers,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(p) {
      this.body = p;
      return this;
    },
    set(name, value) {
      headers[name] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

function route(app, method, pathName) {
  const found = app.router.routes.find(
    (r) => r.method === method && r.path === pathName,
  );
  assert.ok(found, `route ${method} ${pathName} registered`);
  return found.handler;
}

/**
 * Matches a URL against the mock router's parameterized patterns and
 * returns a handler callable with (req, res) — params extracted from
 * the URL segments.
 */
function matchRoute(pattern, urlPath) {
  const pp = pattern.split("/");
  const up = urlPath.split("/");
  if (pp.length !== up.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) {
      params[pp[i].slice(1)] = decodeURIComponent(up[i]);
    } else if (pp[i] !== up[i]) {
      return null;
    }
  }
  return params;
}

/** Route lookup for parameterized routes (e.g. /assets/fonts/:fontstack/:range). */
function callRoute(app, method, urlPath) {
  for (const r of app.router.routes) {
    if (r.method !== method) continue;
    const params = matchRoute(r.path, urlPath);
    if (params) return (req, res) => r.handler({ ...req, params }, res);
  }
  assert.fail(`route ${method} ${urlPath} not found`);
}

function waitUntil(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out"));
        return;
      }
      setImmediate(check);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// TEST 1: sourcePath suffix derivation
// ---------------------------------------------------------------------------

describe("BATHYMETRY 1: sourcePath suffix derivation", () => {
  test("inserts suffix before the extension", () => {
    assert.equal(
      pluginFactory.sourcePath("/cache/passage_cache.mbtiles", "-bathy"),
      "/cache/passage_cache-bathy.mbtiles",
    );
    assert.equal(
      pluginFactory.sourcePath("/cache/passage_cache.mbtiles", "-coverage"),
      "/cache/passage_cache-coverage.mbtiles",
    );
    assert.equal(
      pluginFactory.sourcePath("/cache/passage_cache.mbtiles", "-dem"),
      "/cache/passage_cache-dem.mbtiles",
    );
  });

  test("empty suffix returns the path unchanged (seamap)", () => {
    assert.equal(
      pluginFactory.sourcePath("/cache/passage_cache.mbtiles", ""),
      "/cache/passage_cache.mbtiles",
    );
  });

  test("no extension appends suffix at the end", () => {
    assert.equal(
      pluginFactory.sourcePath("/cache/passage_cache", "-bathy"),
      "/cache/passage_cache-bathy",
    );
  });
});

// ---------------------------------------------------------------------------
// TEST 2: Provider resolution
// ---------------------------------------------------------------------------

describe("BATHYMETRY 2: provider resolution", () => {
  test("Open Waters ⇒ 6 sources + mirror + styleUrl", () => {
    const config = pluginFactory.resolveConfig({
      tileProvider: "Open Waters Seamap",
    });
    assert.ok(Array.isArray(config.sources));
    assert.equal(config.sources.length, 6);
    assert.equal(config.sources[0].id, "seamap");
    assert.equal(config.sources[1].id, "seascape-vector");
    assert.equal(config.sources[2].id, "seascape-coverage");
    assert.equal(config.sources[3].id, "versatiles-shortbread");
    assert.equal(config.sources[4].id, "elevation");
    assert.equal(config.sources[5].id, "seascape-dem");
    assert.equal(
      config.styleUrl,
      "https://tiles.openwaters.io/seamap/style.json",
    );
  });

  test("OpenSeaMap ⇒ single source, no mirror", () => {
    const config = pluginFactory.resolveConfig({ tileProvider: "OpenSeaMap" });
    assert.equal(config.sources, null);
    assert.equal(config.styleUrl, null);
    assert.equal(config.format, "png");
  });

  test("custom tileServerUrl ⇒ single source, no mirror", () => {
    const config = pluginFactory.resolveConfig({
      tileServerUrl: "https://tiles.example.org/{z}/{x}/{y}.png",
    });
    assert.equal(config.sources, null);
    assert.equal(config.styleUrl, null);
  });

  test("source paths derive correctly from the configured outputPath", () => {
    const config = pluginFactory.resolveConfig({
      tileProvider: "Open Waters Seamap",
      outputPath: "/charts/passage.mbtiles",
    });
    assert.equal(
      pluginFactory.sourcePath(config.outputPath, config.sources[0].fileSuffix),
      "/charts/passage.mbtiles",
    );
    assert.equal(
      pluginFactory.sourcePath(config.outputPath, config.sources[1].fileSuffix),
      "/charts/passage-bathy.mbtiles",
    );
    assert.equal(
      pluginFactory.sourcePath(config.outputPath, config.sources[5].fileSuffix),
      "/charts/passage-dem.mbtiles",
    );
  });
});

// ---------------------------------------------------------------------------
// TEST 3: Webp profile
// ---------------------------------------------------------------------------

describe("BATHYMETRY 3: webp tile profile", () => {
  function fakeStore() {
    const tiles = new Set();
    return {
      hasTile: () => false,
      insertTile: (z, x, y) => {
        tiles.add(`${z}/${x}/${y}`);
        return true;
      },
      tiles,
    };
  }

  test("accepts RIFF…WEBP bodies and stores them verbatim", async () => {
    const store = fakeStore();
    const dl = createDownloader({
      getStore: () => store,
      templates: {
        dem: "https://tiles.openwaters.io/seascape/{z}/{x}/{y}.webp",
      },
      formats: { dem: "webp" },
      format: "webp",
      throttleMs: 0,
      fetchFn: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: webpHeaders,
          arrayBuffer: async () => WEBP,
        }),
      sleepFn: () => Promise.resolve(),
      log: () => {},
    });
    dl.start([{ z: 10, x: 1, y: 2, yTms: 1021, source: "dem" }]);
    await new Promise((r) => {
      const check = () => {
        if (!dl.status().isDownloading) r();
        else setImmediate(check);
      };
      check();
    });
    assert.equal(dl.status().completed, 1);
    assert.equal(dl.status().failed, 0);
  });

  test("rejects PNG bodies labeled image/webp", async () => {
    const store = fakeStore();
    const dl = createDownloader({
      getStore: () => store,
      templates: {
        dem: "https://tiles.openwaters.io/seascape/{z}/{x}/{y}.webp",
      },
      formats: { dem: "webp" },
      format: "webp",
      maxRetries: 0,
      throttleMs: 0,
      fetchFn: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: webpHeaders,
          arrayBuffer: async () => PNG,
        }),
      sleepFn: () => Promise.resolve(),
      log: () => {},
    });
    dl.start([{ z: 10, x: 1, y: 2, yTms: 1021, source: "dem" }]);
    await new Promise((r) => {
      const check = () => {
        if (!dl.status().isDownloading) r();
        else setImmediate(check);
      };
      check();
    });
    assert.equal(dl.status().failed, 1);
    assert.equal(store.tiles.size, 0);
  });

  test("stores webp format metadata in the mbtiles store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webp-"));
    const dbPath = path.join(dir, "dem.mbtiles");
    try {
      const store = new MbTilesStore(dbPath);
      store.setFormat("webp");
      const dl = createDownloader({
        getStore: () => store,
        templates: {
          dem: "https://tiles.openwaters.io/seascape/{z}/{x}/{y}.webp",
        },
        formats: { dem: "webp" },
        format: "webp",
        throttleMs: 0,
        fetchFn: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            headers: webpHeaders,
            arrayBuffer: async () => WEBP,
          }),
        sleepFn: () => Promise.resolve(),
        log: () => {},
      });
      dl.start([{ z: 10, x: 1, y: 2, yTms: 1021, source: "dem" }]);
      await new Promise((r) => {
        const check = () => {
          if (!dl.status().isDownloading) r();
          else setImmediate(check);
        };
        check();
      });
      store.close();
      const reader = new DatabaseSync(dbPath);
      const meta = Object.fromEntries(
        reader
          .prepare("SELECT name, value FROM metadata")
          .all()
          .map((r) => [r.name, r.value]),
      );
      reader.close();
      assert.equal(meta.format, "webp");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 5: tileKey/tileUrl per source
// ---------------------------------------------------------------------------

describe("BATHYMETRY 5: tileKey and tileUrl per source", () => {
  test("tileUrl selects the template by source", async () => {
    const calls = [];
    const dl = createDownloader({
      getStore: () => ({ hasTile: () => false, insertTile: () => true }),
      templates: {
        seamap: "https://tiles.openwaters.io/seamap/{z}/{x}/{y}.pbf",
        dem: "https://tiles.openwaters.io/seascape/{z}/{x}/{y}.webp",
      },
      formats: { seamap: "pbf", dem: "webp" },
      format: "pbf",
      throttleMs: 0,
      fetchFn: (url) => {
        calls.push(url);
        if (url.includes(".webp"))
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: webpHeaders,
            arrayBuffer: async () => WEBP,
          });
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: pbfHeaders,
          arrayBuffer: async () => MVT,
        });
      },
      sleepFn: () => Promise.resolve(),
      log: () => {},
    });
    dl.start([
      { z: 8, x: 1, y: 2, yTms: 253, source: "seamap" },
      { z: 10, x: 3, y: 4, yTms: 1019, source: "dem" },
    ]);
    await new Promise((r) => {
      const check = () => {
        if (!dl.status().isDownloading) r();
        else setImmediate(check);
      };
      check();
    });
    assert.ok(
      calls.some((u) => u === "https://tiles.openwaters.io/seamap/8/1/2.pbf"),
    );
    assert.ok(
      calls.some(
        (u) => u === "https://tiles.openwaters.io/seascape/10/3/4.webp",
      ),
    );
  });

  test("tiles without a source default to seamap", async () => {
    const calls = [];
    const dl = createDownloader({
      getStore: () => ({ hasTile: () => false, insertTile: () => true }),
      templates: { [DEFAULT_SOURCE]: "https://tiles.example/{z}/{x}/{y}.pbf" },
      formats: { [DEFAULT_SOURCE]: "pbf" },
      format: "pbf",
      throttleMs: 0,
      fetchFn: (url) => {
        calls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: pbfHeaders,
          arrayBuffer: async () => MVT,
        });
      },
      sleepFn: () => Promise.resolve(),
      log: () => {},
    });
    dl.start([{ z: 8, x: 1, y: 2, yTms: 253 }]);
    await new Promise((r) => {
      const check = () => {
        if (!dl.status().isDownloading) r();
        else setImmediate(check);
      };
      check();
    });
    assert.ok(calls.some((u) => u === "https://tiles.example/8/1/2.pbf"));
  });
});

// ---------------------------------------------------------------------------
// TEST 4 + 6: Corridor, per-store metadata, format guard (plugin-level)
// ---------------------------------------------------------------------------

describe("BATHYMETRY 4+6: corridor and stores (plugin-level)", () => {
  let app, plugin, dir, dbPath;

  beforeEach(() => {
    app = createMockApp();
    plugin = pluginFactory(app);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-test-"));
    dbPath = path.join(dir, "passage_cache.mbtiles");
    app.dataDir = path.join(dir, "plugin-data");
  });

  afterEach(() => {
    plugin.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function startWithHooks(overrides = {}) {
    plugin.start({
      outputPath: dbPath,
      minZoom: 1,
      maxZoom: 1,
      strategicMarginNM: 0.1,
      tacticalMarginNM: 0.1,
      approachRadiusNM: 0.1,
      throttleMs: 0,
      fetch: okFetchDefault,
      sleep: () => Promise.resolve(),
      tileProvider: "Open Waters Seamap",
      ...overrides,
    });
  }

  function okFetchDefault(url) {
    if (url === "https://tiles.openwaters.io/seamap/style.json") {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: jsonHeaders,
        arrayBuffer: async () => Buffer.from(JSON.stringify(openWatersStyle())),
      });
    }
    if (url.includes("/sprites/")) {
      if (url.endsWith(".json"))
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: jsonHeaders,
          arrayBuffer: async () => Buffer.from("{}"),
        });
      if (url.endsWith(".png"))
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: pngHeaders,
          arrayBuffer: async () => SPRITE_PNG,
        });
    }
    if (url.includes("/fonts/")) {
      return Promise.resolve({ ok: false, status: 404, headers: undefined });
    }
    if (url.endsWith(".webp") || url.includes("/tiles/elevation/")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: webpHeaders,
        arrayBuffer: async () => WEBP,
      });
    }
    if (url.endsWith(".pbf") || url.includes("/tiles/osm/")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: pbfHeaders,
        arrayBuffer: async () => MVT,
      });
    }
    return Promise.resolve({ ok: false, status: 404, headers: undefined });
  }

  test("per-source zoom caps: each source clamped to its own ceiling", async () => {
    const ow = openWatersFetch();
    startWithHooks({ minZoom: 1, maxZoom: 18, fetch: ow.fn });
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

    // Each source fetched at most its own maxZoom: coverage ≤8, elevation ≤12
    const coverageUrls = ow.calls.filter((u) =>
      u.includes("/seascape/coverage/"),
    );
    const elevationUrls = ow.calls.filter((u) =>
      u.includes("/tiles/elevation/"),
    );
    const demUrls = ow.calls.filter(
      (u) => u.endsWith(".webp") && u.includes("/seascape/"),
    );

    const maxZoomOf = (urls) =>
      Math.max(
        0,
        ...urls.map((u) => Number(u.match(/\/(\d+)\/\d+\/\d+/)?.[1] ?? 0)),
      );
    assert.ok(maxZoomOf(coverageUrls) <= 8, "coverage ≤8");
    assert.ok(maxZoomOf(elevationUrls) <= 12, "elevation ≤12");
    assert.ok(maxZoomOf(demUrls) <= 18, "dem ≤18");
  });

  test("six stores are created with correct metadata", async () => {
    const ow = openWatersFetch();
    startWithHooks({ fetch: ow.fn });
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });

    const suffixes = ["", "-bathy", "-coverage", "-base", "-elevation", "-dem"];
    for (const suffix of suffixes) {
      const storePath = pluginFactory.sourcePath(dbPath, suffix);
      assert.ok(fs.existsSync(storePath), `${suffix || "seamap"} store exists`);
      const reader = new DatabaseSync(storePath);
      const meta = Object.fromEntries(
        reader
          .prepare("SELECT name, value FROM metadata")
          .all()
          .map((r) => [r.name, r.value]),
      );
      reader.close();
      assert.ok(meta.format, `${suffix || "seamap"} has format`);
      assert.ok(
        meta.bounds && meta.bounds !== "0,0,0,0",
        `${suffix || "seamap"} has bounds`,
      );
      assert.ok(
        meta.minzoom != null && meta.maxzoom != null,
        `${suffix || "seamap"} has zoom levels`,
      );
    }

    // Non-seamap stores carry their source id in the name
    const bathyReader = new DatabaseSync(
      pluginFactory.sourcePath(dbPath, "-bathy"),
    );
    const bathyMeta = Object.fromEntries(
      bathyReader
        .prepare("SELECT name, value FROM metadata")
        .all()
        .map((r) => [r.name, r.value]),
    );
    bathyReader.close();
    assert.equal(bathyMeta.name, "Signal K Corridor Cache — seascape-vector");
    assert.equal(bathyMeta.format, "pbf");
    assert.ok(bathyMeta.attribution.includes("Open Waters"));

    // Webp (dem) store has format=webp
    const demReader = new DatabaseSync(
      pluginFactory.sourcePath(dbPath, "-dem"),
    );
    const demMeta = Object.fromEntries(
      demReader
        .prepare("SELECT name, value FROM metadata")
        .all()
        .map((r) => [r.name, r.value]),
    );
    demReader.close();
    assert.equal(demMeta.format, "webp");
  });

  test("format guard names the offending file (per-store)", async () => {
    // Seed the bathy store with pbf tiles, then switch its source format
    const bathyPath = pluginFactory.sourcePath(dbPath, "-bathy");
    const seed = new MbTilesStore(bathyPath);
    seed.setFormat("webp");
    seed.insertTile(8, 1, 1, WEBP);
    seed.close();

    const ow = openWatersFetch();
    startWithHooks({ fetch: ow.fn });
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /holds webp tiles/);
    assert.match(res.body.message, /seascape-vector/);
  });
});

// ---------------------------------------------------------------------------
// TEST 7: Journal v2 round-trip
// ---------------------------------------------------------------------------

describe("BATHYMETRY 7: journal v2 round-trip", () => {
  test("PENDING_JOB_VERSION is 2", () => {
    assert.equal(pluginFactory.PENDING_JOB_VERSION, 2);
  });

  test("glyphRangeNames produces 256 ranges covering 0..65535", () => {
    const names = pluginFactory.glyphRangeNames();
    assert.equal(names.length, 256);
    assert.equal(names[0], "0-255");
    assert.equal(names[255], "65280-65535");
  });
});

// ---------------------------------------------------------------------------
// TEST 8: Style transform
// ---------------------------------------------------------------------------

describe("BATHYMETRY 8: style transform", () => {
  let app, plugin, dir, dbPath;

  beforeEach(() => {
    app = createMockApp();
    plugin = pluginFactory(app);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "transform-"));
    dbPath = path.join(dir, "passage_cache.mbtiles");
    app.dataDir = path.join(dir, "plugin-data");
  });

  afterEach(() => {
    plugin.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("cached sources rewritten to local URLs; uncached dropped; glyphs/sprite local; host from req", async () => {
    const ow = openWatersFetch();
    plugin.start({
      outputPath: dbPath,
      minZoom: 1,
      maxZoom: 1,
      strategicMarginNM: 0.1,
      tacticalMarginNM: 0.1,
      approachRadiusNM: 0.1,
      throttleMs: 0,
      fetch: ow.fn,
      sleep: () => Promise.resolve(),
      tileProvider: "Open Waters Seamap",
    });
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, res);
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });

    // Fetch the transformed style with a Host header
    const styleRes = makeRes();
    route(
      app,
      "get",
      "/assets/style.json",
    )({ headers: { host: "boat.local:3000" }, protocol: "https" }, styleRes);
    assert.equal(styleRes.statusCode, 200);
    const style = styleRes.body;

    // Every source that has tiles gets local chart URLs
    for (const [id, source] of Object.entries(style.sources)) {
      assert.ok(source.tiles, `${id} has tiles`);
      assert.ok(
        source.tiles[0].startsWith(
          "https://boat.local:3000/signalk/v1/api/resources/charts/",
        ),
        `${id} tiles local`,
      );
      assert.equal(source.url, undefined, `${id} url dropped`);
    }

    // Glyphs and sprites rewritten to local plugin routes
    assert.ok(
      style.glyphs.startsWith(
        "https://boat.local:3000/plugins/signalk-corridor-tile-downloader/assets/fonts/",
      ),
    );
    assert.ok(Array.isArray(style.sprite));
    assert.equal(style.sprite[0].id, "freenauticalchart");
    assert.ok(
      style.sprite[0].url.startsWith(
        "https://boat.local:3000/plugins/signalk-corridor-tile-downloader/assets/sprites/freenauticalchart",
      ),
    );

    // Background layer stays; symbol layers stay (all sources cached)
    assert.ok(style.layers.some((l) => l.id === "background"));
    assert.ok(style.layers.some((l) => l.id === "seamark"));
  });

  test("uncached source + its layers dropped (graceful degradation)", async () => {
    // Don't run a job — seed the style and seamap store directly
    plugin.start({
      outputPath: dbPath,
      minZoom: 1,
      maxZoom: 1,
      strategicMarginNM: 0.1,
      tacticalMarginNM: 0.1,
      approachRadiusNM: 0.1,
      throttleMs: 0,
      fetch: () => Promise.resolve({ ok: false, status: 404 }),
      sleep: () => Promise.resolve(),
      tileProvider: "Open Waters Seamap",
    });
    plugin.registerWithRouter(app.router);

    // Write the mirrored style directly (no job ran)
    const mirrorDir = path.join(app.dataDir, "mirror");
    fs.mkdirSync(mirrorDir, { recursive: true });
    fs.writeFileSync(
      path.join(mirrorDir, "style.json"),
      JSON.stringify(openWatersStyle()),
    );

    // Seed ONLY the seamap store with a tile
    const seamapStore = new MbTilesStore(dbPath);
    seamapStore.setFormat("pbf");
    seamapStore.insertTile(8, 1, 1, MVT);
    seamapStore.close();

    const styleRes = makeRes();
    route(
      app,
      "get",
      "/assets/style.json",
    )({ headers: { host: "boat.local" } }, styleRes);
    assert.equal(styleRes.statusCode, 200);
    const style = styleRes.body;

    // Only seamap source survives
    assert.deepEqual(Object.keys(style.sources), ["seamap"]);
    // Layers whose source was dropped are gone; background stays
    const layerSources = style.layers.map((l) => l.source).filter(Boolean);
    assert.deepEqual(layerSources, ["seamap"]);
    assert.ok(style.layers.some((l) => l.id === "background"));
  });
});

// ---------------------------------------------------------------------------
// TEST 9: Asset routes
// ---------------------------------------------------------------------------

describe("BATHYMETRY 9: asset routes", () => {
  let app, plugin, dir, dbPath;

  beforeEach(() => {
    app = createMockApp();
    plugin = pluginFactory(app);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-"));
    dbPath = path.join(dir, "passage_cache.mbtiles");
    app.dataDir = path.join(dir, "plugin-data");
  });

  afterEach(() => {
    plugin.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runJob() {
    const ow = openWatersFetch();
    plugin.start({
      outputPath: dbPath,
      minZoom: 1,
      maxZoom: 1,
      strategicMarginNM: 0.1,
      tacticalMarginNM: 0.1,
      approachRadiusNM: 0.1,
      throttleMs: 0,
      fetch: ow.fn,
      sleep: () => Promise.resolve(),
      tileProvider: "Open Waters Seamap",
    });
    plugin.registerWithRouter(app.router);
    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, makeRes());
  }

  async function waitForCompletion() {
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });
  }

  test("manifest has the expected shape", async () => {
    runJob();
    await waitForCompletion();

    const res = makeRes();
    route(
      app,
      "get",
      "/assets/manifest.json",
    )({ headers: { host: "boat.local" } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.style, "style URL present");
    assert.ok(res.body.sprites.freenauticalchart, "sprite entry");
    assert.ok(
      res.body.glyphs.includes("{fontstack}/{range}.pbf"),
      "glyphs template",
    );
    assert.ok(
      Array.isArray(res.body.fonts) && res.body.fonts.length > 0,
      "fonts list",
    );
    assert.ok(
      Array.isArray(res.body.sources) && res.body.sources.length === 6,
      "sources list",
    );
  });

  test("sprite .json route returns application/json", async () => {
    runJob();
    await waitForCompletion();

    const res = makeRes();
    callRoute(app, "get", "/assets/sprites/freenauticalchart.json")({}, res);
    assert.equal(res.statusCode, 200);
  });

  test("sprite .png route returns image/png", async () => {
    runJob();
    await waitForCompletion();

    const res = makeRes();
    callRoute(app, "get", "/assets/sprites/freenauticalchart.png")({}, res);
    assert.equal(res.statusCode, 200);
  });

  test("unknown sprite id → 404", async () => {
    runJob();
    await waitForCompletion();

    const res = makeRes();
    callRoute(app, "get", "/assets/sprites/evil.json")({}, res);
    assert.equal(res.statusCode, 404);
  });

  test("font range route serves the glyph file", async () => {
    runJob();
    await waitForCompletion();

    const res = makeRes();
    callRoute(app, "get", "/assets/fonts/Noto Sans Regular/0-255.pbf")({}, res);
    assert.equal(res.statusCode, 200);
  });

  test("unknown font stack → 404", async () => {
    runJob();
    await waitForCompletion();

    const res = makeRes();
    callRoute(app, "get", "/assets/fonts/Unknown Font/0-255.pbf")({}, res);
    assert.equal(res.statusCode, 404);
  });

  test("path traversal in fontstack → 404", async () => {
    runJob();
    await waitForCompletion();

    const res = makeRes();
    callRoute(app, "get", "/assets/fonts/..%2F..%2Fetc/0-255.pbf")({}, res);
    assert.equal(res.statusCode, 404);
  });

  test("invalid glyph range → 404", async () => {
    runJob();
    await waitForCompletion();

    const res = makeRes();
    callRoute(app, "get", "/assets/fonts/Noto Sans Regular/0-999.pbf")({}, res);
    assert.equal(res.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// TEST 10: Status per-source counts and assets state
// ---------------------------------------------------------------------------

describe("BATHYMETRY 10: status per-source counts and assets", () => {
  let app, plugin, dir, dbPath;

  beforeEach(() => {
    app = createMockApp();
    plugin = pluginFactory(app);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-"));
    dbPath = path.join(dir, "passage_cache.mbtiles");
    app.dataDir = path.join(dir, "plugin-data");
  });

  afterEach(() => {
    plugin.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("bySource has per-source counts; finished only when all drained", async () => {
    const ow = openWatersFetch();
    plugin.start({
      outputPath: dbPath,
      minZoom: 1,
      maxZoom: 1,
      strategicMarginNM: 0.1,
      tacticalMarginNM: 0.1,
      approachRadiusNM: 0.1,
      throttleMs: 0,
      fetch: ow.fn,
      sleep: () => Promise.resolve(),
      tileProvider: "Open Waters Seamap",
    });
    plugin.registerWithRouter(app.router);

    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, makeRes());
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });

    const s = makeRes();
    route(app, "get", "/status")({}, s);
    assert.equal(s.body.state, "completed");
    assert.ok(s.body.bySource, "bySource present");
    // Every configured source has a bySource entry
    for (const id of [
      "seamap",
      "seascape-vector",
      "seascape-coverage",
      "versatiles-shortbread",
      "elevation",
      "seascape-dem",
    ]) {
      assert.ok(s.body.bySource[id], `${id} in bySource`);
      assert.ok(s.body.bySource[id].totalQueued > 0, `${id} has queued tiles`);
    }
    // Top-level totals = sum of per-source
    const total = Object.values(s.body.bySource).reduce(
      (sum, c) => sum + c.totalQueued,
      0,
    );
    assert.equal(s.body.totalQueued, total);
    // outputPaths and dbSizeBytes per source
    assert.ok(s.body.outputPaths.seamap);
    assert.ok(s.body.outputPaths["seascape-dem"]);
    assert.equal(typeof s.body.dbSizeBytes.seamap, "number");
  });

  test("assets state is ready after a successful mirror", async () => {
    const ow = openWatersFetch();
    plugin.start({
      outputPath: dbPath,
      minZoom: 1,
      maxZoom: 1,
      strategicMarginNM: 0.1,
      tacticalMarginNM: 0.1,
      approachRadiusNM: 0.1,
      throttleMs: 0,
      fetch: ow.fn,
      sleep: () => Promise.resolve(),
      tileProvider: "Open Waters Seamap",
    });
    plugin.registerWithRouter(app.router);

    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, makeRes());
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });

    const s = makeRes();
    route(app, "get", "/status")({}, s);
    assert.ok(
      ["ready", "partial"].includes(s.body.assets.state),
      `assets state is ready or partial, got ${s.body.assets.state}`,
    );
  });
});

// ---------------------------------------------------------------------------
// TEST 11: Failures
// ---------------------------------------------------------------------------

describe("BATHYMETRY 11: failures", () => {
  let app, plugin, dir, dbPath;

  beforeEach(() => {
    app = createMockApp();
    plugin = pluginFactory(app);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fail-"));
    dbPath = path.join(dir, "passage_cache.mbtiles");
    app.dataDir = path.join(dir, "plugin-data");
  });

  afterEach(() => {
    plugin.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("webp tile 404 is a skip, not a failure", async () => {
    const ow = openWatersFetch();
    // Override: webp tiles 404
    const fn = (url) => {
      if (url.endsWith(".webp") || url.includes("/tiles/elevation/")) {
        return Promise.resolve({ ok: false, status: 404, headers: undefined });
      }
      return ow.fn(url);
    };
    plugin.start({
      outputPath: dbPath,
      minZoom: 1,
      maxZoom: 1,
      strategicMarginNM: 0.1,
      tacticalMarginNM: 0.1,
      approachRadiusNM: 0.1,
      throttleMs: 0,
      fetch: fn,
      sleep: () => Promise.resolve(),
      tileProvider: "Open Waters Seamap",
    });
    plugin.registerWithRouter(app.router);

    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, makeRes());
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });

    const s = makeRes();
    route(app, "get", "/status")({}, s);
    assert.equal(s.body.state, "completed");
    assert.ok(s.body.skipped > 0, "404 tiles skipped");
    assert.equal(s.body.failed, 0, "no failures");
  });

  test("style fetch failure → manifest without style, tiles proceed", async () => {
    const ow = openWatersFetch();
    // Override: style fetch 404
    const fn = (url) => {
      if (url === "https://tiles.openwaters.io/seamap/style.json") {
        return Promise.resolve({ ok: false, status: 404, headers: undefined });
      }
      return ow.fn(url);
    };
    plugin.start({
      outputPath: dbPath,
      minZoom: 1,
      maxZoom: 1,
      strategicMarginNM: 0.1,
      tacticalMarginNM: 0.1,
      approachRadiusNM: 0.1,
      throttleMs: 0,
      fetch: fn,
      sleep: () => Promise.resolve(),
      tileProvider: "Open Waters Seamap",
    });
    plugin.registerWithRouter(app.router);

    route(
      app,
      "post",
      "/fetch-target",
    )({ body: { coordinates: [{ lat: 0, lon: 0 }] } }, makeRes());
    await waitUntil(() => {
      const s = makeRes();
      route(app, "get", "/status")({}, s);
      return s.body.state === "completed";
    });

    // Tiles still completed
    const s = makeRes();
    route(app, "get", "/status")({}, s);
    assert.equal(s.body.state, "completed");
    assert.ok(s.body.completed > 0, "tiles proceeded despite style failure");

    // Manifest omits style (no mirror)
    const manifest = makeRes();
    route(app, "get", "/assets/manifest.json")({}, manifest);
    assert.equal(manifest.statusCode, 200);
    assert.equal(
      manifest.body.style,
      undefined,
      "manifest omits style when mirror incomplete",
    );

    // Style route 404s
    const styleRes = makeRes();
    route(app, "get", "/assets/style.json")({}, styleRes);
    assert.equal(styleRes.statusCode, 404);
  });
});
