const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { gunzipSync } = require("node:zlib");

const {
  backoffDelay,
  createDownloader,
  DEFAULT_SOURCE,
  defaultSleep,
  hostOf,
  isMvtBody,
  isPngBody,
  EMPTY_PBF,
  MIN_PNG_BYTES,
  parseRetryAfter,
  PNG_SIGNATURE,
  RATE_LIMIT_PENALTY_BASE_MS,
  RATE_LIMIT_PENALTY_MAX_MS,
  SUSPEND_POLL_MS,
} = require("../lib/downloader.js");

/** A realistic tile body: valid PNG signature plus payload. */
const PNG = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(592, 7)]);

/** A realistic empty-ocean overlay tile (fully transparent PNG). */
const EMPTY_OCEAN_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(326, 7)]);

/**
 * In-memory tile store recording writes, with optional pre-cached tiles.
 */
function fakeStore(precached = []) {
  const tiles = new Set(precached.map((t) => `${t.z}/${t.x}/${t.yTms}`));
  const inserts = [];
  return {
    tiles,
    inserts,
    hasTile(z, x, yTms) {
      return tiles.has(`${z}/${x}/${yTms}`);
    },
    insertTile(z, x, yTms, data) {
      const key = `${z}/${x}/${yTms}`;
      if (tiles.has(key)) return false;
      tiles.add(key);
      inserts.push({ z, x, yTms, data });
      return true;
    },
  };
}

/** Realistic image/png response headers. */
const pngHeaders = {
  get: (name) => (name.toLowerCase() === "content-type" ? "image/png" : null),
};

/** Response factory for the injected fetch. */
function okResponse(data = PNG) {
  return {
    ok: true,
    status: 200,
    headers: pngHeaders,
    arrayBuffer: async () => data,
  };
}

/** 200 OK with a non-png body: provider rate-limit style (Addendum 6). */
function bodyResponse(contentType, data = Buffer.from("[]")) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (n) => (n.toLowerCase() === "content-type" ? contentType : null),
    },
    arrayBuffer: async () => data,
  };
}

/** Resolves once the downloader's current job has settled. */
function jobSettled(downloader) {
  return new Promise((resolve) => {
    const check = () => {
      if (!downloader.status().isDownloading) resolve();
      else setImmediate(check);
    };
    check();
  });
}

/** Yields to the macrotask queue so tests can flip shared state. */
const yieldingSleep = (sleeps) => async (ms) => {
  sleeps.push(ms);
  await new Promise((r) => setImmediate(r));
};

/**
 * Sleep stub mirroring defaultSleep's semantics: polls the
 * cancellation predicate (so wake() interrupts) and also resolves
 * once the nominal delay elapses.
 */
const wakeableSleep = (sleeps) => (ms, isCancelled) =>
  new Promise((resolve) => {
    sleeps.push(ms);
    const start = Date.now();
    const timer = setInterval(() => {
      if (isCancelled() || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 2);
  });

function tiles3() {
  return [
    { z: 8, x: 1, y: 2, yTms: 3 },
    { z: 8, x: 4, y: 5, yTms: 6 },
    { z: 8, x: 7, y: 8, yTms: 9 },
  ];
}

function makeDownloader(store, responses, opts = {}) {
  const sleeps = [];
  const calls = [];
  let i = 0;
  let mockTime = 1000;
  const fetchFn = (url, init) => {
    calls.push({ url, init });
    const r = responses[i < responses.length ? i : responses.length - 1];
    i += 1;
    return typeof r === "function" ? r(url, init) : Promise.resolve(r);
  };
  // Mock clock: yieldingSleep advances mockTime so awaitThrottle sees
  // exact elapsed values without real-time jitter.
  const sleepFn = async (ms) => {
    sleeps.push(ms);
    mockTime += ms;
    await new Promise((r) => setImmediate(r));
  };
  const nowFn = () => mockTime;
  // tileServerUrl/format in opts (old API) are mapped to the new
  // per-source templates/formats maps so existing test call sites work
  // unchanged.
  const template =
    opts.tileServerUrl ?? "https://tiles.example/seamark/{z}/{x}/{y}.png";
  const formatProfile = opts.format ?? "png";
  const downloader = createDownloader({
    getStore: () => store,
    templates: { [DEFAULT_SOURCE]: template },
    formats: { [DEFAULT_SOURCE]: formatProfile },
    format: formatProfile,
    userAgent: "TestUA/1.0",
    throttleMs: 0,
    maxRetries: 2,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    fetchFn,
    sleepFn,
    nowFn,
    log: () => {},
    ...opts,
  });
  return { downloader, calls, sleeps };
}

describe("downloader", () => {
  test("downloads every tile with the right URL and headers", async () => {
    const store = fakeStore();
    const { downloader, calls } = makeDownloader(store, [okResponse()]);
    downloader.start(tiles3());
    await jobSettled(downloader);

    const s = downloader.status();
    assert.equal(s.state, "completed");
    assert.equal(s.completed, 3);
    assert.equal(s.failed, 0);
    assert.equal(s.isDownloading, false);
    // URL uses slippy XYZ y, not the TMS row
    assert.equal(calls[0].url, "https://tiles.example/seamark/8/1/2.png");
    assert.equal(calls[0].init.headers["User-Agent"], "TestUA/1.0");
    assert.equal(store.inserts.length, 3);
    assert.ok(store.inserts[0].data.equals(PNG));
  });

  test("throttles between HTTP requests only", async () => {
    const store = fakeStore();
    const { downloader, sleeps } = makeDownloader(store, [okResponse()], {
      throttleMs: 500,
    });
    downloader.start(tiles3());
    await jobSettled(downloader);
    assert.deepEqual(sleeps, [500, 500]);
  });

  test("skips tiles already in the store without fetching", async () => {
    const store = fakeStore([{ z: 8, x: 1, yTms: 3 }]);
    const { downloader, calls } = makeDownloader(store, [okResponse()]);
    downloader.start(tiles3());
    await jobSettled(downloader);
    const s = downloader.status();
    assert.equal(s.skipped, 1);
    assert.equal(s.completed, 2);
    assert.equal(calls.length, 2);
    assert.ok(!calls.some((c) => c.url.endsWith("/8/1/2.png")));
  });

  test("discards non-PNG bodies labeled image/png (placeholder defense)", async () => {
    const store = fakeStore();
    const junk = Buffer.alloc(600, 7); // wrong signature, generous size
    const { downloader, calls, sleeps } = makeDownloader(store, [
      okResponse(junk),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    // Placeholder: counted as a failure, never inserted, no retry
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(downloader.status().failed, 1);
    assert.equal(store.inserts.length, 0);
  });

  test("accepts tiny transparent ocean tiles (real OpenSeaMap payloads are 334 bytes)", async () => {
    const store = fakeStore();
    const { downloader } = makeDownloader(store, [okResponse(EMPTY_OCEAN_PNG)]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    // An empty sea tile is a success, not a placeholder failure
    assert.equal(downloader.status().failed, 0);
    assert.equal(downloader.status().completed, 1);
    assert.equal(store.inserts.length, 1);
  });

  test("429 escalates the throttle 5 min -> 10 min, then resets on success", async () => {
    const store = fakeStore();
    const responses = [
      { ok: false, status: 429, headers: undefined },
      { ok: false, status: 503, headers: undefined },
      okResponse(),
      okResponse(),
    ];
    const { downloader, calls, sleeps } = makeDownloader(store, responses, {
      throttleMs: 100,
    });
    downloader.start(tiles3().slice(0, 2));
    await jobSettled(downloader);

    // Tile 1: 429 (penalty 5 min, deferred), 503 (penalty 10 min,
    // deferred), then success. Each deferral sleeps the penalty (the
    // all-throttled branch) while other hosts could proceed.
    assert.deepEqual(sleeps.slice(0, 2), [
      RATE_LIMIT_PENALTY_BASE_MS,
      RATE_LIMIT_PENALTY_BASE_MS * 2,
    ]);
    // After tile 1's success, tile 2 fetches immediately after (no
    // 15-min gap in the new defer model), so the configured 100 ms
    // inter-tile throttle applies — a third, small sleep.
    assert.deepEqual(sleeps.slice(2), [100]);
    assert.equal(calls.length, 4);
    const s = downloader.status();
    assert.equal(s.completed, 2);
    assert.equal(s.failed, 0);
    assert.equal(s.throttleMs, 100);
  });

  test("retries transient network errors with exponential backoff", async () => {
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(store, [
      () => Promise.reject(new TypeError("network down")),
      () => Promise.reject(new TypeError("network down")),
      okResponse(),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
    assert.equal(downloader.status().completed, 1);
  });

  test("network errors exhaust retries and fail the tile", async () => {
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(store, [
      () => Promise.reject(new TypeError("network down")),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    // maxRetries=2 => 3 attempts
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
    const s = downloader.status();
    assert.equal(s.failed, 1);
    assert.equal(s.completed, 0);
    assert.equal(s.state, "completed");
  });

  test("skips permanent HTTP 404 tiles without retries (regional coverage)", async () => {
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(store, [
      { ok: false, status: 404, headers: undefined },
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);
    // 404 = per-tile skip, never a failure (BATHYMETRY.md FAILURES)
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(downloader.status().skipped, 1);
    assert.equal(downloader.status().failed, 0);
    assert.equal(downloader.status().completed, 0);
    assert.equal(store.inserts.length, 0);
  });

  test("persistent 429s fail the tile after the penalty-wait cap", async () => {
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(store, [
      { ok: false, status: 429, headers: undefined },
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    // 11 rate-limited attempts, 10 escalating penalty waits
    assert.equal(calls.length, 11);
    assert.equal(sleeps.length, 10);
    assert.ok(sleeps.every((ms) => ms >= RATE_LIMIT_PENALTY_BASE_MS));
    assert.ok(sleeps.every((ms) => ms <= RATE_LIMIT_PENALTY_MAX_MS));
    assert.equal(downloader.status().failed, 1);
  });

  test("429 with Retry-After: 1s is honored with no 5-minute floor", async () => {
    const store = fakeStore();
    const headers = {
      get: (n) => (n.toLowerCase() === "retry-after" ? "1" : null),
    };
    const { downloader, sleeps } = makeDownloader(store, [
      { ok: false, status: 429, headers },
      okResponse(),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    // The server said retry in 1s: we waited 1s, not the 5-minute ladder.
    assert.deepEqual(sleeps, [1000]);
    assert.equal(downloader.status().completed, 1);
  });

  test("429 with Retry-After is capped at the 30-minute ceiling", async () => {
    const store = fakeStore();
    const headers = {
      get: (n) =>
        n.toLowerCase() === "retry-after"
          ? String(2 * 60 * 60) // 2 hours
          : null,
    };
    const { downloader, sleeps } = makeDownloader(store, [
      { ok: false, status: 429, headers },
      okResponse(),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    assert.deepEqual(sleeps, [RATE_LIMIT_PENALTY_MAX_MS]);
    assert.equal(downloader.status().completed, 1);
  });

  test("429 with Retry-After: 0 falls back to the ladder (no tight loop)", async () => {
    // Retry-After: 0 means "retry now" — no usable delay. Honoring it
    // literally would set a 0-duration penalty and spin a tight
    // refetch loop. Falling back to the SPEC ladder (base 5 min)
    // avoids that while still honoring any positive Retry-After.
    const store = fakeStore();
    const headers = {
      get: (n) => (n.toLowerCase() === "retry-after" ? "0" : null),
    };
    const mockTime = 1000;
    const { downloader, sleeps } = makeDownloader(store, [
      { ok: false, status: 429, headers },
      okResponse(),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    // Fell back to the base penalty, not 0.
    assert.deepEqual(sleeps, [RATE_LIMIT_PENALTY_BASE_MS]);
    assert.equal(downloader.status().completed, 1);
  });

  test("429 on one host does not penalize another host's tiles", async () => {
    const store = fakeStore();
    const sleeps = [];
    const calls = [];
    let i = 0;
    let mockTime = 1000;
    // Host A 429s once, then recovers; host B always succeeds.
    const responses = [
      { ok: false, status: 429, headers: { get: () => null } }, // A
      okResponse(), // A (after the 1st-level penalty wait)
      okResponse(), // B
    ];
    const dl = createDownloader({
      getStore: () => store,
      templates: {
        a: "https://a.example/{z}/{x}/{y}.png",
        b: "https://b.example/{z}/{x}/{y}.png",
      },
      formats: { default: "png", a: "png", b: "png" },
      format: "png",
      userAgent: "TestUA/1.0",
      throttleMs: 0,
      fetchFn: (url, init) => {
        calls.push({ url, init });
        const r = responses[i++];
        return Promise.resolve(r);
      },
      sleepFn: async (ms) => {
        sleeps.push(ms);
        mockTime += ms;
        await new Promise((r) => setImmediate(r));
      },
      nowFn: () => mockTime,
      log: () => {},
    });
    dl.start([
      { z: 8, x: 1, y: 2, yTms: 3, source: "a" },
      { z: 8, x: 4, y: 5, yTms: 6, source: "b" },
    ]);
    await jobSettled(dl);

    // Only the A penalty wait (5 min) is slept; B's tile needed no
    // penalty wait — it fetched while A was throttled, incurring at
    // most the (0 ms) configured throttle.
    assert.deepEqual(sleeps, [RATE_LIMIT_PENALTY_BASE_MS]);
    assert.equal(calls.length, 3);
    assert.equal(dl.status().completed, 2);
    assert.equal(dl.status().failed, 0);
  });

  test("a successful fetch clears the host's penalty", async () => {
    // A 429 escalates A to 5 min; a success clears it, so the NEXT 429
    // (without Retry-After) starts fresh at 5 min — not doubled.
    const store = fakeStore();
    const sleeps = [];
    let i = 0;
    let mockTime = 1000;
    const responses = [
      { ok: false, status: 429, headers: { get: () => null } }, // 5m
      okResponse(), // success → penalty cleared
      { ok: false, status: 429, headers: { get: () => null } }, // fresh 5m
      okResponse(), // success
    ];
    const dl = createDownloader({
      getStore: () => store,
      templates: { [DEFAULT_SOURCE]: "https://a.example/{z}/{x}/{y}.png" },
      formats: { default: "png", [DEFAULT_SOURCE]: "png" },
      format: "png",
      userAgent: "TestUA/1.0",
      throttleMs: 0,
      fetchFn: () => Promise.resolve(responses[i++]),
      sleepFn: async (ms) => {
        sleeps.push(ms);
        mockTime += ms;
        await new Promise((r) => setImmediate(r));
      },
      nowFn: () => mockTime,
      log: () => {},
    });
    dl.start([
      { z: 8, x: 1, y: 2, yTms: 3 },
      { z: 8, x: 4, y: 5, yTms: 6 },
    ]);
    await jobSettled(dl);

    // Each tile: 429 (wait 5m), success. The success between them
    // cleared the penalty, so the second 429 is base — not doubled.
    assert.deepEqual(sleeps, [
      RATE_LIMIT_PENALTY_BASE_MS,
      RATE_LIMIT_PENALTY_BASE_MS,
    ]);
    assert.equal(dl.status().completed, 2);
  });

  test("wake() during a rate-limit penalty does not starve the event loop", async () => {
    // Regression: once a host was penalized, the penalty-wait branch
    // looped `await sleepFn(wait, () => cancelled || wakeRequested);
    // continue;`. defaultSleep returned a *microtask* when its
    // isCancelled gate was true, and wakeRequested — set by wake()
    // (a network.internet.state delta) or enqueueRecovery (the vessel
    // moving >1 NM) — was never cleared here, so the loop spun without
    // yielding. The event loop starved: no HTTP served, no timers fired,
    // the server hung for as long as the penalty lasted. The real
    // defaultSleep (production sleep) is used here, not a stub.
    const store = fakeStore();
    const dl = createDownloader({
      getStore: () => store,
      templates: {
        [DEFAULT_SOURCE]: "https://tiles.openwaters.io/seamap/{z}/{x}/{y}.pbf",
      },
      formats: { default: "pbf", [DEFAULT_SOURCE]: "pbf" },
      format: "pbf",
      userAgent: "TestUA/1.0",
      throttleMs: 0,
      // Wrong Content-Type for a pbf source → escalatePenalty (5 min),
      // tile deferred (rateLimited), all remaining tiles on the host.
      fetchFn: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: (n) =>
              n.toLowerCase() === "content-type" ? "image/png" : null,
          },
          arrayBuffer: async () => Buffer.from("nope"),
          body: { cancel: async () => {} },
        }),
      sleepFn: defaultSleep,
      getInternetState: () => null,
      log: () => {},
    });
    dl.start([
      { z: 8, x: 1, y: 2, yTms: 3 },
      { z: 8, x: 4, y: 5, yTms: 6 },
      { z: 8, x: 7, y: 8, yTms: 9 },
    ]);
    // Let the first fetch land and trigger the penalty.
    await new Promise((r) => setImmediate(r));
    dl.wake(); // as a network.internet.state delta would
    // This timer fires ONLY if the event loop is alive. Before the fix
    // the penalty-wait branch spun as microtasks and this never fired —
    // the test would hang until the node:test timeout.
    await new Promise((r) => setTimeout(r, 80));
    dl.cancel();
    await jobSettled(dl);
    assert.equal(dl.status().state, "cancelled");
  });

  test("cancel aborts the loop: no insert, no further fetches", async () => {
    const store = fakeStore();
    let resolveFirst;
    const firstFetch = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const { downloader, calls } = makeDownloader(store, [
      () => firstFetch.then(() => okResponse()),
      okResponse(),
    ]);
    downloader.start(tiles3());
    // Let the loop enter the first fetch
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);

    downloader.cancel();
    resolveFirst();
    await jobSettled(downloader);

    const s = downloader.status();
    assert.equal(s.state, "cancelled");
    // Tile fetched but discarded after cancel; remaining tiles untouched
    assert.equal(s.completed, 0);
    assert.equal(calls.length, 1);
    assert.equal(store.inserts.length, 0);
  });

  test("start refuses a second concurrent job", async () => {
    const store = fakeStore();
    let resolveFirst;
    const firstFetch = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const { downloader } = makeDownloader(store, [
      () => firstFetch.then(() => okResponse()),
    ]);
    assert.equal(downloader.start(tiles3()), true);
    assert.equal(downloader.start([{ z: 8, x: 9, y: 9, yTms: 9 }]), false);
    downloader.cancel();
    resolveFirst();
    await jobSettled(downloader);
  });

  test("idle status has a sane zeroed shape", () => {
    const { downloader } = makeDownloader(fakeStore(), []);
    const s = downloader.status();
    assert.equal(s.isDownloading, false);
    assert.equal(s.state, "idle");
    assert.equal(s.totalQueued, 0);
    assert.equal(s.routeName, null);
    assert.equal(s.etaMs, null);
    assert.equal(s.suspended, false);
    assert.equal(s.throttleMs, 0);
  });

  test("backoffDelay doubles and caps", () => {
    assert.equal(backoffDelay(0, 1000, 60000), 1000);
    assert.equal(backoffDelay(1, 1000, 60000), 2000);
    assert.equal(backoffDelay(5, 1000, 60000), 32000);
    assert.equal(backoffDelay(10, 1000, 60000), 60000);
  });
});

describe("recovery queue (Addendum 5)", () => {
  test("recovery tiles are fetched before remaining passage tiles", async () => {
    const store = fakeStore();
    const gates = [];
    const responses = [
      // First passage tile fetch parks on a gate
      () =>
        new Promise((resolve) => gates.push(resolve)).then(() => okResponse()),
      okResponse(),
      okResponse(),
    ];
    const { downloader, calls } = makeDownloader(store, responses);
    const passage = tiles3().slice(0, 2);
    downloader.start(passage);
    await new Promise((resolve) => {
      const check = () => {
        if (gates.length === 1) resolve();
        else setImmediate(check);
      };
      check();
    });

    // Recovery arrives while the first passage tile is in flight
    const recovery = { z: 8, x: 50, y: 50, yTms: 205 };
    assert.equal(downloader.enqueueRecovery([recovery]), 1);
    gates[0]();
    await jobSettled(downloader);

    // Order: passage t1 (gated), then recovery, then passage t2
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        "https://tiles.example/seamark/8/1/2.png",
        "https://tiles.example/seamark/8/50/50.png",
        "https://tiles.example/seamark/8/4/5.png",
      ],
    );
    const s = downloader.status();
    assert.equal(s.completed, 3);
    assert.equal(s.recoveryPending, 0);
  });

  test("enqueueRecovery with no running job starts a recovery job", async () => {
    const store = fakeStore();
    const { downloader, calls } = makeDownloader(store, [okResponse()]);
    assert.equal(
      downloader.enqueueRecovery([{ z: 8, x: 9, y: 9, yTms: 9 }]),
      1,
    );
    assert.equal(downloader.status().jobType, "recovery");
    await jobSettled(downloader);
    const s = downloader.status();
    assert.equal(s.state, "completed");
    assert.equal(s.jobType, "recovery");
    assert.equal(s.completed, 1);
    assert.equal(calls.length, 1);
  });

  test("enqueueRecovery drops duplicates of tiles already queued", async () => {
    const store = fakeStore();
    const gates = [];
    const responses = [
      () =>
        new Promise((resolve) => gates.push(resolve)).then(() => okResponse()),
      okResponse(),
      okResponse(),
    ];
    const { downloader, calls } = makeDownloader(store, responses);
    downloader.start(tiles3().slice(0, 1));
    await new Promise((resolve) => {
      const check = () => {
        if (gates.length === 1) resolve();
        else setImmediate(check);
      };
      check();
    });

    const recovery = { z: 8, x: 50, y: 50, yTms: 205 };
    assert.equal(downloader.enqueueRecovery([recovery]), 1);
    assert.equal(downloader.enqueueRecovery([recovery]), 0);
    gates[0]();
    await jobSettled(downloader);
    assert.equal(calls.filter((c) => c.url.endsWith("/8/50/50.png")).length, 1);
  });

  test("metered passage defers while recovery proceeds (wake)", async () => {
    const store = fakeStore();
    let netState = "metered";
    const calls = [];
    const dl = createDownloader({
      getStore: () => store,
      templates: {
        [DEFAULT_SOURCE]: "https://tiles.example/seamark/{z}/{x}/{y}.png",
      },
      userAgent: "TestUA/1.0",
      throttleMs: 0,
      fetchFn: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(okResponse());
      },
      sleepFn: wakeableSleep([]),
      getInternetState: () => netState,
      allowRecoveryOnMetered: true,
      log: () => {},
    });

    dl.start([{ z: 8, x: 1, y: 2, yTms: 3 }]); // passage, no override
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(calls.length, 0, "passage suspended on metered");
    assert.equal(dl.status().suspended, true);

    // Recovery tile allowed on metered: wakes the loop, jumps the queue
    assert.equal(dl.enqueueRecovery([{ z: 8, x: 7, y: 8, yTms: 9 }]), 1);
    await new Promise((resolve) => {
      const check = () => {
        if (dl.status().completed >= 1) resolve();
        else setImmediate(check);
      };
      check();
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://tiles.example/seamark/8/7/8.png");

    // Passage tile still deferred until the state clears; the wake
    // simulates the internet-state delta the plugin subscribes to
    assert.equal(dl.status().completed, 1);
    netState = "online";
    dl.wake();
    await jobSettled(dl);
    const s = dl.status();
    assert.equal(s.completed, 2);
    assert.equal(calls[1].url, "https://tiles.example/seamark/8/1/2.png");
  });

  test("passage start preempts a suspended recovery job", async () => {
    const store = fakeStore();
    let netState = "offline";
    const sleeps = [];
    const dl = createDownloader({
      getStore: () => store,
      templates: {
        [DEFAULT_SOURCE]: "https://tiles.example/seamark/{z}/{x}/{y}.png",
      },
      userAgent: "TestUA/1.0",
      throttleMs: 0,
      fetchFn: () => Promise.resolve(okResponse()),
      sleepFn: wakeableSleep(sleeps),
      getInternetState: () => netState,
      log: () => {},
    });

    dl.enqueueRecovery([{ z: 8, x: 50, y: 50, yTms: 205 }]);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(dl.status().suspended, true);

    // A user-triggered passage download preempts the recovery job
    assert.equal(dl.start([{ z: 8, x: 1, y: 2, yTms: 3 }]), true);
    const s = dl.status();
    assert.equal(s.jobType, "passage");
    assert.equal(s.recoveryPending, 1);
    assert.equal(s.totalQueued, 2);

    netState = "online";
    dl.wake();
    await jobSettled(dl);
    const done = dl.status();
    assert.equal(done.state, "completed");
    assert.equal(done.completed, 2);
    assert.equal(done.recoveryPending, 0);
  });

  test("recovery respects allowRecoveryOnMetered: false", async () => {
    const store = fakeStore();
    const netState = "metered";
    const sleeps = [];
    const dl = createDownloader({
      getStore: () => store,
      templates: {
        [DEFAULT_SOURCE]: "https://tiles.example/seamark/{z}/{x}/{y}.png",
      },
      userAgent: "TestUA/1.0",
      throttleMs: 0,
      fetchFn: () => Promise.resolve(okResponse()),
      sleepFn: yieldingSleep(sleeps),
      getInternetState: () => netState,
      allowRecoveryOnMetered: false,
      log: () => {},
    });
    dl.enqueueRecovery([{ z: 8, x: 9, y: 9, yTms: 9 }]);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(dl.status().suspended, true);
    dl.cancel();
    await jobSettled(dl);
  });
});

describe("network circuit breaker (Addendum 3)", () => {
  test("suspends while offline, polls every 10s, resumes when online", async () => {
    const store = fakeStore();
    let netState = "offline";
    const { downloader, calls, sleeps } = makeDownloader(
      store,
      [okResponse()],
      {
        getInternetState: () => netState,
      },
    );
    downloader.start(tiles3());

    // Suspended before any HTTP request
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(calls.length, 0);
    let s = downloader.status();
    assert.equal(s.suspended, true);
    assert.equal(s.suspendReason, "offline");
    assert.ok(sleeps.includes(SUSPEND_POLL_MS));

    netState = "online";
    await jobSettled(downloader);

    s = downloader.status();
    assert.equal(s.completed, 3);
    assert.equal(s.suspended, false);
  });

  test("metered suspends unless the job forces the override", async () => {
    const store = fakeStore();
    const netState = "metered";
    const forced = makeDownloader(store, [okResponse()], {
      getInternetState: () => netState,
    });
    forced.downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(forced.calls.length, 0);
    assert.equal(forced.downloader.status().suspended, true);

    // forceOnMetered bypasses the metered suspend
    const bypass = makeDownloader(fakeStore(), [okResponse()], {
      getInternetState: () => netState,
    });
    bypass.downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }], {
      forceOnMetered: true,
    });
    await jobSettled(bypass.downloader);
    assert.equal(bypass.downloader.status().completed, 1);
    assert.equal(bypass.downloader.status().forceOnMetered, true);

    // Original job still suspended; cancel it
    forced.downloader.cancel();
    await jobSettled(forced.downloader);
  });

  test("offline suspends even with the metered override", async () => {
    const store = fakeStore();
    const { downloader, calls } = makeDownloader(store, [okResponse()], {
      getInternetState: () => "offline",
    });
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }], {
      forceOnMetered: true,
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(calls.length, 0);
    assert.equal(downloader.status().suspended, true);
    downloader.cancel();
    await jobSettled(downloader);
  });

  test("absent connectivity plugin never suspends", async () => {
    const store = fakeStore();
    const { downloader } = makeDownloader(store, [okResponse()]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);
    assert.equal(downloader.status().completed, 1);
    assert.equal(downloader.status().suspended, false);
  });
});

describe("payload validation (Addendum 6)", () => {
  test("drops 200 OK JSON bodies and backs off before retrying", async () => {
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(store, [
      bodyResponse("application/json", Buffer.from('{"error":"rate limited"}')),
      okResponse(),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    // The JSON payload was dropped (never inserted), the retry waited
    // out the first rate-limit penalty, then the real PNG landed
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [RATE_LIMIT_PENALTY_BASE_MS]);
    const s = downloader.status();
    assert.equal(s.completed, 1);
    assert.equal(s.failed, 0);
    assert.equal(store.inserts.length, 1);
    assert.ok(store.inserts[0].data.equals(PNG));
  });

  test("drops 200 OK HTML bodies the same way", async () => {
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(store, [
      bodyResponse("text/html", Buffer.alloc(600, 0x3c)),
      bodyResponse("application/json"),
      okResponse(),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    // Both bogus payloads dropped; penalty escalates between them
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [
      RATE_LIMIT_PENALTY_BASE_MS,
      RATE_LIMIT_PENALTY_BASE_MS * 2,
    ]);
    assert.equal(downloader.status().completed, 1);
    assert.equal(store.inserts.length, 1);
  });

  test("persistent wrong Content-Type fails the tile after the cap", async () => {
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(store, [
      bodyResponse("application/json"),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    assert.equal(calls.length, 11);
    assert.equal(sleeps.length, 10);
    assert.ok(sleeps.every((ms) => ms >= RATE_LIMIT_PENALTY_BASE_MS));
    assert.equal(downloader.status().failed, 1);
    assert.equal(store.inserts.length, 0);
  });

  test("accepts image/png regardless of case and parameters", async () => {
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(store, [
      bodyResponse("Image/PNG; charset=binary", PNG),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(downloader.status().completed, 1);
  });

  test("missing Content-Type header is rejected, not guessed", async () => {
    const store = fakeStore();
    const headerless = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => PNG,
    };
    const { downloader, calls } = makeDownloader(store, [
      headerless,
      okResponse(),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    assert.equal(calls.length, 2);
    assert.equal(downloader.status().completed, 1);
  });

  test("structural PNG minimum: shorter than a valid PNG is rejected", async () => {
    const truncated = Buffer.concat([
      PNG_SIGNATURE,
      Buffer.alloc(MIN_PNG_BYTES - 9, 7),
    ]);
    assert.ok(!isPngBody(truncated));

    const store = fakeStore();
    const { downloader } = makeDownloader(store, [okResponse(truncated)]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);
    assert.equal(downloader.status().failed, 1);
    assert.equal(store.inserts.length, 0);
  });
});

/** A realistic small Mapbox Vector Tile: one layer named "seamark". */
const MVT = Buffer.concat([
  Buffer.from([0x1a, 0x09, 0x12, 0x07]), // field 3 (layers) → field 2 (name)
  Buffer.from("seamark"),
]);

/** Realistic application/x-protobuf response headers. */
const pbfHeaders = {
  get: (name) =>
    name.toLowerCase() === "content-type" ? "application/x-protobuf" : null,
};

/** Response factory for the vector profile. */
function okPbfResponse(data = MVT) {
  return {
    ok: true,
    status: 200,
    headers: pbfHeaders,
    arrayBuffer: async () => data,
  };
}

describe("vector tiles (Open Waters Seamap)", () => {
  test("stores protobuf bodies gzip-wrapped (MBTiles convention)", async () => {
    const store = fakeStore();
    const { downloader, calls } = makeDownloader(store, [okPbfResponse()], {
      tileServerUrl: "https://tiles.openwaters.io/seamap/{z}/{x}/{y}.pbf",
      format: "pbf",
    });
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    assert.equal(downloader.status().completed, 1);
    assert.equal(store.inserts.length, 1);
    const stored = store.inserts[0].data;
    // Gzip magic: charts-provider-simple serves it with
    // Content-Encoding: gzip and sniffs format=pbf from it
    assert.equal(stored[0], 0x1f);
    assert.equal(stored[1], 0x8b);
    assert.ok(gunzipSync(stored).equals(MVT));
    // The vector Accept header was sent
    assert.match(calls[0].init.headers.Accept, /x-protobuf/);
  });

  test("a body that is already gzipped is validated and stored as-is", async () => {
    const store = fakeStore();
    const { gzipSync } = require("node:zlib");
    const body = gzipSync(MVT);
    const { downloader } = makeDownloader(store, [okPbfResponse(body)], {
      format: "pbf",
    });
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    assert.equal(downloader.status().completed, 1);
    assert.ok(store.inserts[0].data.equals(body));
  });

  test("HTTP 204 over open ocean stores a gzipped empty tile", async () => {
    const store = fakeStore();
    const { downloader } = makeDownloader(
      store,
      [
        {
          ok: true,
          status: 204,
          headers: pbfHeaders,
          arrayBuffer: async () => Buffer.alloc(0),
        },
      ],
      { format: "pbf" },
    );
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    // An empty vector tile is a *success*: re-runs and recovery checks
    // must find it cached instead of refetching forever
    assert.equal(downloader.status().completed, 1);
    assert.equal(downloader.status().failed, 0);
    assert.ok(store.inserts[0].data.equals(EMPTY_PBF));
  });

  test("204 stays a failure on the raster profile", async () => {
    const store = fakeStore();
    const { downloader, sleeps } = makeDownloader(
      store,
      [
        {
          ok: true,
          status: 204,
          headers: { get: () => null },
          arrayBuffer: async () => Buffer.alloc(0),
        },
        bodyResponse("application/json"),
      ],
      { maxRetries: 0, format: "png" },
    );
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);
    assert.equal(downloader.status().failed, 1);
    assert.equal(store.inserts.length, 0);
    assert.ok(sleeps.length > 0);
  });

  test("drops 200 OK JSON bodies and retries after the penalty", async () => {
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(
      store,
      [bodyResponse("application/json"), okPbfResponse()],
      { format: "pbf" },
    );
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [RATE_LIMIT_PENALTY_BASE_MS]);
    assert.equal(downloader.status().completed, 1);
    assert.equal(store.inserts.length, 1);
  });

  test("protobuf media types the provider actually uses are accepted", async () => {
    for (const contentType of [
      "application/x-protobuf",
      "application/vnd.mapbox-vector-tile",
      "application/octet-stream",
    ]) {
      const store = fakeStore();
      const { downloader } = makeDownloader(
        store,
        [bodyResponse(contentType, MVT)],
        { format: "pbf" },
      );
      downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
      await jobSettled(downloader);
      assert.equal(downloader.status().completed, 1, `${contentType} accepted`);
    }
  });

  test("accepts versatiles' non-standard Content-Type missing the application/ prefix", async () => {
    // tiles.versatiles.org returns `Content-Type: vnd.mapbox-vector-tile`
    // (no `application/` tree prefix) for its pbf tiles. Without
    // normalization every such tile is rejected as a wrong-Content-Type
    // rate limit and penalizes the whole host — blocking the sibling
    // elevation source too. The body is a valid (tiny) raw MVT.
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(
      store,
      [bodyResponse("vnd.mapbox-vector-tile", MVT)],
      { format: "pbf" },
    );
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);
    assert.equal(downloader.status().completed, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(store.inserts.length, 1);
  });

  test("a protobuf body mislabeled image/png is rejected", async () => {
    const store = fakeStore();
    const { downloader } = makeDownloader(
      store,
      [bodyResponse("image/png", MVT)],
      { format: "pbf", maxRetries: 0 },
    );
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);
    assert.equal(downloader.status().failed, 1);
    assert.equal(store.inserts.length, 0);
  });
});

describe("MVT body sniffing", () => {
  test("accepts real vector tiles and the empty tile", () => {
    assert.ok(isMvtBody(MVT));
    assert.ok(isMvtBody(Buffer.alloc(0)));
    // A varint-heavy field followed by exact-length payload walks clean
    assert.ok(
      isMvtBody(Buffer.from([0x08, 0x96, 0x01])), // field 1 varint 150
    );
  });

  test("rejects JSON, HTML and truncated protobuf", () => {
    assert.ok(!isMvtBody(Buffer.from('{"error":1}')));
    assert.ok(!isMvtBody(Buffer.from("<html>rate limited</html>")));
    // Tag promises a 9-byte layer but the body ends early
    assert.ok(!isMvtBody(Buffer.from([0x1a, 0x09, 0x12])));
    // Wire type 3 (group) is not valid MVT
    assert.ok(!isMvtBody(Buffer.from([0x7b, 0x00])));
  });
});

describe("hostOf", () => {
  test("extracts host and port from a URL", () => {
    assert.equal(
      hostOf("https://tiles.openwaters.io/seamap/8/1/2.pbf"),
      "tiles.openwaters.io",
    );
    assert.equal(
      hostOf("http://127.0.0.1:3000/charts/8/1/2.png"),
      "127.0.0.1:3000",
    );
  });

  test("returns empty string for an unparseable URL", () => {
    assert.equal(hostOf("not a url"), "");
    assert.equal(hostOf(""), "");
  });
});

describe("parseRetryAfter", () => {
  test("parses delta-seconds into milliseconds", () => {
    const h = {
      get: (n) => (n.toLowerCase() === "retry-after" ? "120" : null),
    };
    assert.equal(parseRetryAfter(h, 1000), 120000);
  });

  test("parses an HTTP-date relative to now", () => {
    const now = Date.now();
    // 60 seconds in the future
    const future = new Date(now + 60000).toUTCString();
    const h = {
      get: (n) => (n.toLowerCase() === "retry-after" ? future : null),
    };
    const ms = parseRetryAfter(h, now);
    assert.ok(ms >= 55000 && ms <= 65000, `expected ~60000, got ${ms}`);
  });

  test("a past HTTP-date (retry now) yields no usable delay (null)", () => {
    const now = Date.now();
    const past = new Date(now - 10000).toUTCString();
    const h = { get: (n) => (n.toLowerCase() === "retry-after" ? past : null) };
    // A past date means "retry now" — returning null falls back to the
    // SPEC ladder instead of a 0-duration penalty that would spin a
    // tight refetch loop.
    assert.equal(parseRetryAfter(h, now), null);
  });

  test("returns null when the header is absent", () => {
    assert.equal(parseRetryAfter({ get: () => null }, 1000), null);
    assert.equal(parseRetryAfter(undefined, 1000), null);
  });

  test("returns null for an unparseable value", () => {
    const h = {
      get: (n) => (n.toLowerCase() === "retry-after" ? "soon" : null),
    };
    assert.equal(parseRetryAfter(h, 1000), null);
  });
});
