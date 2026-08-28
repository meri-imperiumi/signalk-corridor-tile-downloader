const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  backoffDelay,
  createDownloader,
  MIN_TILE_BYTES,
  RATE_LIMIT_PENALTY_BASE_MS,
  RATE_LIMIT_PENALTY_MAX_MS,
  SUSPEND_POLL_MS,
} = require("../lib/downloader.js");

/** A realistic tile body (>= MIN_TILE_BYTES). */
const PNG = Buffer.alloc(600, 7);

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
  const fetchFn = (url, init) => {
    calls.push({ url, init });
    const r = responses[i < responses.length ? i : responses.length - 1];
    i += 1;
    return typeof r === "function" ? r(url, init) : Promise.resolve(r);
  };
  const sleepFn = yieldingSleep(sleeps);
  const downloader = createDownloader({
    getStore: () => store,
    tileServerUrl: "https://tiles.example/seamark/{z}/{x}/{y}.png",
    userAgent: "TestUA/1.0",
    throttleMs: 0,
    maxRetries: 2,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    fetchFn,
    sleepFn,
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

  test("discards undersized 200 OK placeholder bodies (Addendum 2)", async () => {
    const store = fakeStore();
    const tiny = Buffer.alloc(MIN_TILE_BYTES - 1, 7);
    const { downloader, calls, sleeps } = makeDownloader(store, [
      okResponse(tiny),
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);

    // Placeholder: counted as a failure, never inserted, no retry
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(downloader.status().failed, 1);
    assert.equal(store.inserts.length, 0);
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

    // Tile 1: 429 (penalty 5 min), 503 (penalty 10 min), then success
    assert.deepEqual(sleeps.slice(0, 2), [
      RATE_LIMIT_PENALTY_BASE_MS,
      RATE_LIMIT_PENALTY_BASE_MS * 2,
    ]);
    // Success reset the penalty: the inter-tile throttle is back to config
    assert.equal(sleeps[2], 100);
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

  test("fails fast on permanent HTTP 404 without retries", async () => {
    const store = fakeStore();
    const { downloader, calls, sleeps } = makeDownloader(store, [
      { ok: false, status: 404, headers: undefined },
    ]);
    downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(downloader);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(downloader.status().failed, 1);
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
      tileServerUrl: "https://tiles.example/seamark/{z}/{x}/{y}.png",
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
      tileServerUrl: "https://tiles.example/seamark/{z}/{x}/{y}.png",
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
      tileServerUrl: "https://tiles.example/seamark/{z}/{x}/{y}.png",
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

  test("minTileBytes is configurable (Open Waters 300-byte rule)", async () => {
    const sparse = Buffer.alloc(400, 7); // above 300, below 500

    const permissive = fakeStore();
    const openWaters = makeDownloader(permissive, [okResponse(sparse)], {
      minTileBytes: 300,
    });
    openWaters.downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(openWaters.downloader);
    assert.equal(openWaters.downloader.status().completed, 1);

    // Under the default (OpenSeaMap, Addendum 2) baseline it is a
    // placeholder: counted as a failure, never inserted
    const strict = fakeStore();
    const baseline = makeDownloader(strict, [okResponse(sparse)]);
    baseline.downloader.start([{ z: 8, x: 1, y: 2, yTms: 3 }]);
    await jobSettled(baseline.downloader);
    assert.equal(baseline.downloader.status().failed, 1);
    assert.equal(strict.inserts.length, 0);
  });
});
