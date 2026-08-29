const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const {
  MbTilesStore,
  CHECKPOINT_INTERVAL,
  isIoError,
  extentFromTilesFile,
} = require("../lib/mbtiles.js");

let dir;
let dbPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbtiles-test-"));
  dbPath = path.join(dir, "passage_cache.mbtiles");
});

afterEach(() => {
  // Best effort; WAL sidecars may linger on some platforms
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

/** Build an error shaped like a node:sqlite failure. */
function sqliteErr(errcode) {
  const err = new Error("simulated");
  err.errcode = errcode;
  return err;
}

describe("MbTilesStore", () => {
  test("creates the database, schema and required metadata", () => {
    const store = new MbTilesStore(dbPath);
    assert.ok(fs.existsSync(dbPath));
    assert.equal(store.getMetadata("name"), "Signal K Corridor Cache");
    assert.equal(store.getMetadata("format"), "png");
    assert.equal(store.getMetadata("type"), "overlay");
    assert.equal(store.getMetadata("version"), "1.0.0");
    // Placeholder bounds keep the empty file loadable for
    // charts-provider-simple (which drops, and housekeeping-deletes,
    // bounds-less files); a real corridor overwrites them at fetch start.
    assert.equal(store.getMetadata("bounds"), "0,0,0,0");
    store.close();
  });

  test("runs in WAL journal mode", () => {
    const store = new MbTilesStore(dbPath);
    const mode = store.db.prepare("PRAGMA journal_mode").get();
    assert.equal(mode.journal_mode, "wal");
    store.close();
  });

  test("insertTile stores blobs and is an atomic upsert", () => {
    const store = new MbTilesStore(dbPath);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    assert.equal(store.hasTile(8, 14, 114), false);
    assert.equal(store.insertTile(8, 14, 114, png), true);
    // Re-insert of the same tile is ignored, first blob wins
    assert.equal(store.insertTile(8, 14, 114, Buffer.from([0, 0])), false);
    assert.equal(store.hasTile(8, 14, 114), true);

    const data = store.getTile(8, 14, 114);
    assert.ok(data);
    assert.equal(data.length, png.length);
    assert.equal(data[0], 0x89);
    assert.equal(store.getTile(8, 14, 113), null);
    store.close();
  });

  test("setBounds and setZoomLevels update metadata rows", () => {
    const store = new MbTilesStore(dbPath);
    store.setBounds([-170.1, -19.2, -159.1, -18.1]);
    assert.equal(store.getMetadata("bounds"), "-170.1,-19.2,-159.1,-18.1");
    store.setZoomLevels(8, 14);
    assert.equal(store.getMetadata("minzoom"), "8");
    assert.equal(store.getMetadata("maxzoom"), "14");
    store.close();
  });

  test("vector caches: setFormat/setVectorLayers and format preservation", () => {
    const store = new MbTilesStore(dbPath);
    assert.equal(store.getMetadata("format"), "png"); // fresh default
    store.setFormat("pbf");
    store.setVectorLayers(["land", "seamark", "water"]);
    assert.equal(store.getMetadata("format"), "pbf");
    assert.deepEqual(
      JSON.parse(store.getMetadata("vector_layers")).map((l) => l.id),
      ["land", "seamark", "water"],
    );
    store.close();

    // Reopening must not reset a pbf cache to the png default: the
    // consumer serves tiles with the format's Content-Type
    const reopened = new MbTilesStore(dbPath);
    assert.equal(reopened.getMetadata("format"), "pbf");
    assert.equal(reopened.getMetadata("name"), "Signal K Corridor Cache");
    reopened.close();
  });

  test("hasAnyTile distinguishes empty caches from filled ones", () => {
    const store = new MbTilesStore(dbPath);
    assert.equal(store.hasAnyTile(), false);
    store.insertTile(8, 1, 1, Buffer.from([1]));
    assert.equal(store.hasAnyTile(), true);
    store.close();
  });

  test("reopening does not duplicate metadata rows", () => {
    const first = new MbTilesStore(dbPath);
    first.setBounds([-170.1, -19.2, -159.1, -18.1]);
    first.close();

    const second = new MbTilesStore(dbPath);
    const rows = second.db
      .prepare("SELECT name, COUNT(*) AS n FROM metadata GROUP BY name")
      .all();
    second.close();
    for (const row of rows) {
      assert.equal(row.n, 1, `metadata key ${row.name} has ${row.n} rows`);
    }
  });

  test("a second connection can read while the writer is open (WAL)", () => {
    const writer = new MbTilesStore(dbPath);
    writer.insertTile(8, 14, 114, Buffer.from([1, 2, 3]));

    // The consumer plugin (charts-provider-simple) reads concurrently
    const reader = new DatabaseSync(dbPath);
    const rows = reader.prepare("SELECT COUNT(*) AS n FROM tiles").get();
    assert.equal(rows.n, 1);
    reader.close();
    writer.close();
  });

  test("reopening preserves downloaded tiles", () => {
    const first = new MbTilesStore(dbPath);
    first.insertTile(10, 200, 300, Buffer.from([9, 9]));
    first.close();

    const second = new MbTilesStore(dbPath);
    assert.equal(second.hasTile(10, 200, 300), true);
    second.close();
  });

  test("periodic checkpoint flushes tiles into the main database", () => {
    // Committed tiles live in the `-wal` sidecar until a checkpoint
    // moves them into the main database. charts-provider-simple's
    // startup housekeeping deletes sidecars, and a crash before the
    // close-time checkpoint loses them. Periodic PASSIVE checkpoints
    // (every CHECKPOINT_INTERVAL inserts) flush tiles into the main db
    // during the download so a restart loses at most that many — not
    // the whole session.
    const store = new MbTilesStore(dbPath);
    const baseline = fs.statSync(dbPath).size;
    // Just under the interval: tiles stay in the WAL, main db holds
    // only the schema (one page).
    for (let i = 0; i < CHECKPOINT_INTERVAL - 1; i++) {
      store.insertTile(8, i, i, Buffer.alloc(600, i));
    }
    assert.equal(fs.statSync(dbPath).size, baseline);
    // One more insert trips the periodic checkpoint: the queued tiles
    // flush into the main database, so its file size jumps well past
    // the schema-only baseline.
    store.insertTile(
      8,
      CHECKPOINT_INTERVAL - 1,
      CHECKPOINT_INTERVAL - 1,
      Buffer.alloc(600, 0xff),
    );
    assert.ok(
      fs.statSync(dbPath).size > baseline + 10000,
      "periodic checkpoint did not flush tiles into the main database",
    );
    store.close();
  });

  test("vacuum reclaims space without losing tiles", () => {
    const store = new MbTilesStore(dbPath);
    store.insertTile(8, 1, 1, Buffer.alloc(4096, 7));
    const sizeBefore = store.sizeBytes();
    store.vacuum();
    assert.ok(store.hasTile(8, 1, 1));
    assert.ok(store.sizeBytes() > 0);
    assert.ok(sizeBefore > 0);
    store.close();
  });
});

describe("MbTilesStore WAL sidecar self-healing", () => {
  // This scenario unlinks a WAL sidecar the store still holds open.
  // POSIX lets an open file's inode survive unlinking, so committed
  // frames stay stranded in the deleted WAL and wedge the wal-index
  // (fresh read-only opens fail with SQLITE_IOERR). Windows refuses
  // the unlink outright with EBUSY — and so does the consumer plugin's
  // housekeeping in production on Windows, meaning the wedged-wal-index
  // condition this test simulates cannot arise there. Skip on Windows.
  const liveWalHealTest = process.platform === "win32" ? test.skip : test;

  liveWalHealTest(
    "heals when charts-provider housekeeping deletes the live WAL",
    () => {
      const store = new MbTilesStore(dbPath);
      store.insertTile(10, 200, 300, Buffer.from([1, 2, 3]));

      // The consumer plugin's startup cleanup unlinks live *.mbtiles-wal
      // sidecars. With committed frames stranded in the unlinked WAL, the
      // stale wal-index (-shm) wedges fresh read-only opens — its
      // chart-metadata endpoint — with SQLITE_IOERR "disk I/O error".
      fs.unlinkSync(`${dbPath}-wal`);
      assert.equal(fs.existsSync(`${dbPath}-wal`), false);
      assert.throws(
        () => {
          const poisoned = new DatabaseSync(dbPath, { readOnly: true });
          poisoned.prepare("SELECT COUNT(*) AS n FROM tiles").get();
          poisoned.close();
        },
        (err) => err.errcode === 522 || err.errcode === 10,
        "expected the wedged wal-index to fail read-only opens",
      );

      // The endpoint leaks its failed connection (the query threw before
      // its close), pinning the stale wal-index. The heal must still work
      // around it.
      const leaked = new DatabaseSync(dbPath, { readOnly: true });

      // The next per-tile touchpoint detects the missing sidecar and
      // rebuilds the handle: the heal checkpoints the unlinked WAL's
      // frames into the main database (the tile survives), discards the
      // pinned wal-index and recreates a consistent -wal/-shm pair.
      assert.equal(store.hasTile(10, 200, 300), true);
      assert.ok(fs.existsSync(`${dbPath}-wal`));

      const reader = new DatabaseSync(dbPath, { readOnly: true });
      assert.equal(
        reader.prepare("SELECT COUNT(*) AS n FROM tiles").get().n,
        1,
      );
      reader.close();
      try {
        leaked.close();
      } catch {
        // The leaked connection is already broken beyond closing
      }

      // Reads keep working after the leak is gone too
      const afterLeak = new DatabaseSync(dbPath, { readOnly: true });
      assert.equal(
        afterLeak.prepare("SELECT COUNT(*) AS n FROM tiles").get().n,
        1,
      );
      afterLeak.close();

      // Writes continue on the healed handle and stay visible to readers
      assert.equal(store.insertTile(10, 200, 301, Buffer.from([4])), true);
      const after = new DatabaseSync(dbPath, { readOnly: true });
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM tiles").get().n, 2);
      after.close();
      store.close();
    },
  );

  test("insertTile retries once after a transient SQLITE_IOERR", () => {
    const store = new MbTilesStore(dbPath);
    let threw = false;
    // Poison the prepared statement: the first run fails with the
    // wedged-wal-index signature, forcing the store to rebuild its
    // handle and re-run the insert on the fresh one.
    store._insertTile = {
      run() {
        threw = true;
        throw sqliteErr(522);
      },
    };

    assert.equal(store.insertTile(8, 1, 1, Buffer.from([9])), true);
    assert.ok(threw);
    // The healed handle re-prepared the statement and holds the tile
    assert.equal(store.hasTile(8, 1, 1), true);
    store.close();
  });

  test("isIoError recognizes the SQLITE_IOERR family", () => {
    assert.equal(isIoError(sqliteErr(10)), true); // base SQLITE_IOERR
    assert.equal(isIoError(sqliteErr(522)), true); // SHORTREAD
    assert.equal(isIoError(sqliteErr(266)), true); // READ
    assert.equal(isIoError(sqliteErr(1546)), true); // TRUNCATE
    assert.equal(isIoError(sqliteErr(1)), false); // SQLITE_ERROR
    assert.equal(isIoError(sqliteErr(6)), false); // SQLITE_LOCKED
    assert.equal(isIoError(new Error("disk I/O error")), false);
    assert.equal(isIoError(null), false);
  });
});

describe("MbTilesStore extent derivation", () => {
  let dir;
  let dbPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbtiles-extent-"));
    dbPath = path.join(dir, "passage_cache.mbtiles");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("derives the envelope of stored tiles (TMS rows, all zooms)", () => {
    const store = new MbTilesStore(dbPath);
    assert.equal(store.extentFromTiles(), null, "empty store → null");
    assert.equal(extentFromTilesFile(dbPath), null, "file variant → null");

    // z1 x0 y0 (TMS bottom-left): lon [-180, 0], lat [-85.05, 0]
    store.insertTile(1, 0, 0, Buffer.from([1]));
    // z2 x2 y1 (TMS): lon [0, 90], lat [-66.51, 0]
    store.insertTile(2, 2, 1, Buffer.from([2]));

    const extent = store.extentFromTiles();
    assert.ok(extent, "derived extent");
    assert.ok(Math.abs(extent.bounds[0] - -180) < 1e-4, "west -180");
    assert.ok(Math.abs(extent.bounds[1] - -85.0511) < 1e-3, "south -85.05");
    assert.ok(Math.abs(extent.bounds[2] - 90) < 1e-4, "east 90");
    assert.ok(Math.abs(extent.bounds[3] - 0) < 1e-4, "north 0");
    assert.equal(extent.minzoom, 1);
    assert.equal(extent.maxzoom, 2);

    // The read-only file variant agrees
    store.close();
    const fromFile = extentFromTilesFile(dbPath);
    assert.deepEqual(fromFile, extent);
  });

  test("file variant is quiet on missing files", () => {
    assert.equal(extentFromTilesFile(path.join(dir, "nope.mbtiles")), null);
  });
});
