const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { MbTilesStore } = require("../lib/mbtiles.js");
const { bubbleTiles, xyzToTmsY } = require("../lib/geometry.js");

/**
 * Interop smoketests: replay signalk-charts-provider-simple's loader,
 * reader and housekeeping logic (src/charts-loader.ts,
 * src/utils/mbtiles-reader.ts, src/index.ts cleanupChartDirectory)
 * against the files this plugin produces, so the producer/consumer
 * contract cannot drift silently.
 */

let dir;
let dbPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interop-"));
  dbPath = path.join(dir, "passage_cache.mbtiles");
});

afterEach(() => {
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

/**
 * Mirrors charts-loader.ts `openMbtilesFile`: the loader gate drops any
 * chart whose metadata is empty or whose `bounds` row is missing.
 *
 * @returns {object|null} Parsed provider-style chart descriptor
 */
function loadLikeProvider() {
  const reader = openReadOnlyLikeProvider(dbPath);
  try {
    const metadata = getInfoLikeProvider(reader);
    if (
      !metadata ||
      Object.keys(metadata).length === 0 ||
      metadata.bounds === undefined
    ) {
      return null;
    }
    const identifier = "passage_cache";
    const KNOWN_CHART_TYPES = new Set([
      "tilelayer",
      "s-57",
      "mapstylejson",
      "tilejson",
      "wms",
      "wmts",
    ]);
    const type = KNOWN_CHART_TYPES.has(String(metadata.type).toLowerCase())
      ? metadata.type
      : "tilelayer";
    return {
      identifier,
      name: metadata.name ?? identifier,
      bounds: metadata.bounds,
      minzoom: metadata.minzoom,
      maxzoom: metadata.maxzoom,
      format: metadata.format ?? "png",
      type,
      vector_layers: metadata.vector_layers ?? [],
      chartLayers: metadata.vector_layers
        ? metadata.vector_layers.map((l) => l.id)
        : [],
    };
  } finally {
    reader.close();
  }
}

/** Mirrors MBTilesReader: a read-only connection with cached statements. */
function openReadOnlyLikeProvider(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  return {
    db,
    close() {
      db.close();
    },
  };
}

/** Mirrors MBTilesReader.getInfo() parsing of the metadata table. */
function getInfoLikeProvider(reader) {
  const rows = reader.db.prepare("SELECT name, value FROM metadata").all();
  const metadata = {};
  for (const { name, value } of rows) {
    switch (name) {
      case "bounds":
        metadata.bounds = value.split(",").map(Number);
        break;
      case "minzoom":
      case "maxzoom":
        metadata[name] = Number.parseInt(value, 10);
        break;
      case "vector_layers":
        metadata.vector_layers = JSON.parse(value);
        break;
      default:
        metadata[name] = value;
    }
  }
  return metadata;
}

/** Mirrors MBTilesReader.getRawTile: XYZ request flipped to a TMS row. */
function getRawTileLikeProvider(reader, z, x, yXyz) {
  const tmsY = (1 << z) - 1 - yXyz;
  const row = reader.db
    .prepare(
      "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
    )
    .get(z, x, tmsY);
  return row ? row.tile_data : null;
}

/** Mirrors cleanupChartDirectory's validity + orphan rules. */
function housekeepingLikeProvider() {
  const chart = loadLikeProvider();
  const sidecars = fs
    .readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith(".mbtiles-wal") ||
        f.endsWith(".mbtiles-journal") ||
        f.endsWith(".partial_tiles.db"),
    );
  return {
    keepsFile: chart !== null,
    wouldUnlinkSidecars: sidecars,
  };
}

describe("charts-provider-simple interop", () => {
  test("a filled corridor loads, serves and survives housekeeping", () => {
    const store = new MbTilesStore(dbPath);
    const bounds = [-170.1, -19.2, -159.1, -18.1];
    store.setBounds(bounds);
    store.setZoomLevels(8, 14);

    const tile = Buffer.alloc(600, 0x89);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      tile,
    ]);
    // Store via our TMS rows around Aitutaki at z14
    const bubble = bubbleTiles({ lat: -18.85, lon: -159.78 }, 14, 3);
    assert.ok(bubble.length > 0);
    for (const t of bubble) {
      assert.equal(store.insertTile(t.z, t.x, t.yTms, png), true);
    }
    store.close();

    // Our idle guarantee: once the writer's last connection closes (it
    // checkpoints), no WAL sidecars remain on disk for the provider's
    // orphan sweep to trip over. (SQLite read-only readers recreate
    // -wal/-shm while open; that's the provider's own lifecycle.)
    assert.deepEqual(
      fs
        .readdirSync(dir)
        .filter(
          (f) => f.endsWith(".mbtiles-wal") || f.endsWith(".mbtiles-shm"),
        ),
      [],
    );

    // Loader gate passes and the descriptor matches what Freeboard sees
    const chart = loadLikeProvider();
    assert.ok(chart, "provider loads the chart");
    assert.equal(chart.identifier, "passage_cache");
    assert.equal(chart.name, "Signal K Corridor Cache");
    assert.equal(chart.format, "png");
    assert.equal(chart.type, "tilelayer"); // 'overlay' resolves to tilelayer
    assert.deepEqual(chart.bounds, bounds);
    assert.equal(chart.minzoom, 8);
    assert.equal(chart.maxzoom, 14);

    // Reader serves every bubble tile through the XYZ->TMS flip
    const reader = openReadOnlyLikeProvider(dbPath);
    try {
      for (const t of bubble) {
        const data = getRawTileLikeProvider(reader, t.z, t.x, t.y);
        assert.ok(data, `tile ${t.z}/${t.x}/${t.y} served`);
        assert.equal(data[0], 0x89);
      }
      // A tile we never stored (outside the corridor) is a miss
      assert.equal(getRawTileLikeProvider(reader, 14, 0, 0), null);
    } finally {
      reader.close();
    }

    // Housekeeping: the file itself is a valid chart for the sweep
    assert.equal(housekeepingLikeProvider().keepsFile, true);
  });

  test("an empty cache file is still valid (not housekeeping-deleted)", () => {
    const store = new MbTilesStore(dbPath);
    store.close();

    // The placeholder bounds keep the file loadable even with zero tiles
    const chart = loadLikeProvider();
    assert.ok(chart, "provider loads the empty cache");
    assert.deepEqual(chart.bounds, [0, 0, 0, 0]);
    assert.equal(housekeepingLikeProvider().keepsFile, true);
  });

  test("new tiles are visible to an already-open reader (live updates)", () => {
    const store = new MbTilesStore(dbPath);
    store.setBounds([-170.1, -19.2, -159.1, -18.1]);
    store.setZoomLevels(8, 14);
    const png = Buffer.alloc(600, 0x89);
    const t = { z: 14, x: 9602, y: 15891 };
    store.insertTile(t.z, t.x, xyzToTmsY(t.y, t.z), png);
    store.close(); // writer closed: provider scans and opens its reader

    const reader = openReadOnlyLikeProvider(dbPath);
    try {
      // Provider serves the registered tile...
      assert.ok(getRawTileLikeProvider(reader, t.z, t.x, t.y));

      // ...our plugin reopens the file (WAL) and appends a neighboring
      // tile while the provider's reader stays open...
      const writer = new MbTilesStore(dbPath);
      const t2 = { z: 14, x: 9603, y: 15891 };
      writer.insertTile(t2.z, t2.x, xyzToTmsY(t2.y, t2.z), png);

      // ...the open reader sees it without any rescan (SPEC 6B)
      assert.ok(
        getRawTileLikeProvider(reader, t2.z, t2.x, t2.y),
        "live tile visible through the open reader",
      );
      writer.close();
    } finally {
      reader.close();
    }
  });

  test("a vector (pbf) corridor loads and serves like the provider does", () => {
    const { gzipSync, gunzipSync } = require("node:zlib");
    const mvt = Buffer.concat([
      Buffer.from([0x1a, 0x09, 0x12, 0x07]),
      Buffer.from("seamark"),
    ]);
    const store = new MbTilesStore(dbPath);
    store.setFormat("pbf");
    store.setVectorLayers(["land", "seamark", "water"]);
    store.setBounds([-170.1, -19.2, -159.1, -18.1]);
    store.setZoomLevels(8, 14);
    const bubble = bubbleTiles({ lat: -18.85, lon: -159.78 }, 14, 3);
    for (const t of bubble) {
      store.insertTile(t.z, t.x, t.yTms, gzipSync(mvt));
    }
    store.close();

    // Loader gate: the chart descriptor a MapLibre client discovers
    const chart = loadLikeProvider();
    assert.ok(chart, "provider loads the vector chart");
    assert.equal(chart.format, "pbf");
    assert.equal(chart.type, "tilelayer"); // seamap layers are not S-57
    assert.deepEqual(
      chart.vector_layers.map((l) => l.id),
      ["land", "seamark", "water"],
    );

    // Reader: gzipped blobs served with the provider's pbf headers
    const reader = openReadOnlyLikeProvider(dbPath);
    try {
      const first = bubble[0];
      const data = getRawTileLikeProvider(reader, first.z, first.x, first.y);
      assert.ok(data);
      assert.equal(data[0], 0x1f); // gzip magic
      assert.equal(data[1], 0x8b);
      assert.ok(gunzipSync(data).equals(mvt));
      // Mirrors MBTilesReader.getTile's pbf header logic
      const headers = {};
      headers["Content-Type"] = "application/x-protobuf";
      if (data[0] === 0x1f && data[1] === 0x8b) {
        headers["Content-Encoding"] = "gzip";
      }
      assert.equal(headers["Content-Encoding"], "gzip");
    } finally {
      reader.close();
    }

    // Mirrors sniffFormatFromTiles: gzip magic → pbf
    const sniffer = new DatabaseSync(dbPath, { readOnly: true });
    const b = sniffer
      .prepare("SELECT tile_data FROM tiles LIMIT 1")
      .get().tile_data;
    sniffer.close();
    assert.ok(b[0] === 0x1f && b[1] === 0x8b, "sniffs as pbf");
  });
});
