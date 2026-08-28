const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const pluginFactory = require("../index.js");

const PNG = Buffer.alloc(600, 0x89);

/**
 * Mock Signal K app: plugin status/error recorders, configurable
 * getSelfPath/getPath trees, and a stub router recording REST routes.
 */
function createMockApp() {
  let status = "";
  let error = "";
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
    selfTree: {},
    getSelfPath(p) {
      return this.selfTree[p];
    },
    pathTree: {},
    getPath(p) {
      return this.pathTree[p];
    },
    router,
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

function okFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: undefined,
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
  });

  afterEach(() => {
    plugin.stop();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore
      }
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      // ignore
    }
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
      ...overrides,
    });
  }

  test("registers REST routes and reports idle status", () => {
    startWithTestHooks();
    plugin.registerWithRouter(app.router);

    const res = makeRes();
    route(app, "get", "/status")({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isDownloading, false);
    assert.equal(res.body.state, "idle");
    assert.equal(typeof res.body.dbSizeBytes, "number");
    assert.equal(res.body.outputPath, dbPath);
    assert.equal(res.body.activeRouteName, null);
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
    assert.ok(s.body.dbSizeBytes > 0);

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
        headers: undefined,
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
});

describe("configuration", () => {
  test("defaults match the SPEC", () => {
    const config = pluginFactory.resolveConfig({});
    assert.equal(config.strategicMarginNM, 50);
    assert.equal(config.tacticalMarginNM, 15);
    assert.equal(config.approachRadiusNM, 3);
    assert.equal(config.minZoom, 8);
    assert.equal(config.maxZoom, 14);
    assert.equal(config.throttleMs, 500);
    assert.equal(
      config.tileServerUrl,
      "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
    );
    assert.equal(config.userAgent, "SignalK-Corridor-Downloader/1.0");
    assert.ok(config.outputPath.endsWith("passage_cache.mbtiles"));
  });

  test("expandHome resolves ~ to the home directory", () => {
    const expanded = pluginFactory.expandHome("~/charts/cache.mbtiles");
    assert.ok(!expanded.startsWith("~"));
    assert.ok(expanded.endsWith("charts/cache.mbtiles"));
  });

  test("zoom order is normalized and bad URL templates fall back", () => {
    const config = pluginFactory.resolveConfig({
      minZoom: 14,
      maxZoom: 8,
      tileServerUrl: "https://tiles.example/no-placeholders.png",
    });
    assert.deepEqual([config.minZoom, config.maxZoom], [8, 14]);
    assert.equal(config.tileServerUrl, pluginFactory.DEFAULT_TILE_URL);
  });
});
