/**
 * MBTiles storage on top of `node:sqlite` (`DatabaseSync`).
 *
 * Writes a standard SQLite .mbtiles file (TMS tile scheme) that
 * `signalk-charts-provider-simple` can serve to Freeboard SK. WAL
 * journaling plus `INSERT OR IGNORE` keep the writer and any concurrent
 * reader (the consumer plugin) from blocking each other.
 *
 * The consumer's startup housekeeping deletes `*.mbtiles-wal` sidecars —
 * including live ones. Unlinking the WAL out from under an open
 * connection wedges the shared `-shm` wal-index: every fresh read-only
 * open (tile serving, the chart-metadata endpoint) then fails with
 * `SQLITE_IOERR` ("disk I/O error") until a read-write connection
 * rebuilds the index. This store therefore self-heals: the download
 * loop's per-tile touchpoints check that the sidecar still exists and
 * rebuild the handle (checkpointing the unlinked WAL's committed frames
 * into the main database first, so no downloaded tile is lost) when
 * charts-provider housekeeping has struck again.
 *
 * @file lib/mbtiles.js
 */

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Schema from the SPEC. `CREATE ... IF NOT EXISTS` makes (re)opening an
 * existing cache a no-op, preserving previously downloaded tiles.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metadata (name text, value text);
CREATE TABLE IF NOT EXISTS tiles (
  zoom_level integer,
  tile_column integer,
  tile_row integer,
  tile_data blob
);
CREATE UNIQUE INDEX IF NOT EXISTS tile_index ON tiles (zoom_level, tile_column, tile_row);
`;

/**
 * Required MBTiles metadata rows, (re)written on every open. Custom rows
 * a user may have added (e.g. `attribution`) are left untouched. The
 * `format` row is only seeded on a fresh file: a vector (`pbf`) cache
 * must keep its format across reopens (the consumer plugin picks its
 * Content-Type from it), so it is set explicitly at job start, never
 * reset to the png default here.
 */
const BASE_METADATA = new Map([
  ["name", "Signal K Corridor Cache"],
  ["type", "overlay"],
  ["version", "1.0.0"],
]);

/** Default tile format for a freshly created cache. */
const DEFAULT_FORMAT = "png";

/**
 * Is this a disk I/O error (the `SQLITE_IOERR` family)? node:sqlite
 * surfaces the extended result code as `errcode`; every IOERR variant
 * shares the low byte 10 (base 10, e.g. 522 = SQLITE_IOERR_SHORTREAD,
 * the wedged-wal-index signature).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isIoError(err) {
  const code = err?.errcode;
  return typeof code === "number" && (code & 0xff) === 10;
}

/**
 * Verifies the running Node.js supports `node:sqlite` (>= 22.5.0),
 * per the SPEC's compliance checklist.
 *
 * @returns {boolean}
 */
function nodeSupportsSqlite() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

/**
 * A handle to one .mbtiles file.
 */
class MbTilesStore {
  /**
   * Opens (or creates) the database, applies pragmas and schema, and
   * prepares all statements once for the store's lifetime.
   *
   * @param {string} filePath - Absolute path to the .mbtiles file
   * @param {object} [options]
   * @param {string} [options.name] - Base `name` metadata value
   *   (default "Signal K Corridor Cache"). Multi-source mirrors give
   *   each file its own name (e.g. "… — Bathymetry"); re-seeding it on
   *   every (re)open — including the self-healing reopen — keeps it
   *   stable without re-running job-start metadata.
   * @throws When node:sqlite is unavailable or the file cannot open
   */
  constructor(filePath, options = {}) {
    if (!nodeSupportsSqlite()) {
      throw new Error(
        `Node.js >= 22.5.0 required for node:sqlite (running ${process.versions.node})`,
      );
    }
    this.filePath = filePath;
    this.walPath = `${filePath}-wal`;
    this._baseMetadata = new Map(BASE_METADATA);
    if (options.name != null) {
      this._baseMetadata.set("name", String(options.name));
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this._open();
  }

  /**
   * Opens (or creates) the database, applies pragmas and schema, and
   * prepares all statements once for the handle's lifetime. Re-run by
   * the self-healing paths after the previous handle was closed.
   *
   * @throws When the file cannot open
   */
  _open() {
    this.db = new DatabaseSync(this.filePath);
    // WAL is mandatory for read/write concurrency with the consumer
    // plugin; busy_timeout rides out any residual lock contention.
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA synchronous=NORMAL;
    `);
    this.db.exec(SCHEMA_SQL);

    this._hasTile = this.db.prepare(
      "SELECT 1 AS hit FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
    );
    this._hasAnyTile = this.db.prepare("SELECT 1 AS hit FROM tiles LIMIT 1");
    this._getTile = this.db.prepare(
      "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
    );
    this._insertTile = this.db.prepare(
      "INSERT OR IGNORE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
    );
    // The metadata table deliberately carries no UNIQUE constraint on
    // `name` (matching the provider's expectations for imported files),
    // so INSERT OR REPLACE would silently append duplicate rows —
    // DELETE + INSERT keeps exactly one row per key.
    this._getMetadata = this.db.prepare(
      "SELECT value FROM metadata WHERE name = ?",
    );
    this._deleteMetadata = this.db.prepare(
      "DELETE FROM metadata WHERE name = ?",
    );
    this._setMetadata = this.db.prepare(
      "INSERT INTO metadata (name, value) VALUES (?, ?)",
    );

    for (const [name, value] of this._baseMetadata) {
      this.setMetadata(name, value);
    }
    if (this.getMetadata("format") == null) {
      this.setMetadata("format", DEFAULT_FORMAT);
    }

    // charts-provider-simple's loader drops .mbtiles files without a
    // `bounds` row, and its startup housekeeping DELETES such files (when
    // they carry no tiles to repair from). Seed a placeholder so an empty
    // cache is always a loadable chart file; the corridor bounds written
    // at the start of every fetch overwrite it.
    if (this.getMetadata("bounds") == null) {
      this.setMetadata("bounds", "0,0,0,0");
    }

    // Record the WAL sidecar's inode. The metadata seeding above wrote
    // through it, so it exists and carries our connection's WAL. An
    // externally recreated file cannot take this inode while our open
    // file descriptor references it, making inode identity a reliable
    // wedge detector (see _healIfSidecarWedged).
    this._walIno = 0;
    try {
      this._walIno = fs.statSync(this.walPath).ino ?? 0;
    } catch {
      // A fresh database creates the sidecar on first write, which
      // the seeding above performed; if it is somehow absent, the
      // existence check in _healIfSidecarWedged still covers deletion.
    }
  }

  /**
   * Rebuilds the database handle after external interference with the
   * WAL sidecars:
   *
   * 1. best-effort checkpoint — frames already committed to an unlinked
   *    WAL are still reachable through our file descriptor and land in
   *    the main database, so no downloaded tile is lost
   * 2. close, then discard both sidecar files — the stale `-shm`
   *    wal-index must not survive: a failed consumer connection (its
   *    chart-metadata endpoint leaks the handle it opened just before
   *    the error) keeps the wedged index pinned on its inode, and a
   *    plain reopen would reuse that inode and stay poisoned for every
   *    fresh read-only open
   * 3. reopen, recreating a consistent `-wal`/`-shm` pair for the
   *    consumer plugin's read-only connections
   */
  _reopenHealed() {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // The checkpoint may itself fail on a wedged wal-index; the
      // close-time checkpoint gets another chance at the data.
    }
    this.close();
    for (const sidecar of [this.walPath, `${this.filePath}-shm`]) {
      try {
        fs.unlinkSync(sidecar);
      } catch {
        // Already gone (or we were the last connection, whose close
        // removed them): nothing to discard.
      }
    }
    this._open();
  }

  /**
   * Detects WAL sidecar interference on the open connection
   * (charts-provider-simple's startup housekeeping unlinks live
   * `*.mbtiles-wal` files). Two signatures:
   *
   * - the sidecar is gone — deleted outright; or
   * - its inode differs from ours — a failed read-only open (the
   *   consumer's chart-metadata endpoint) recreates an *empty* `-wal`
   *   beside the stale wal-index, which a bare existence check cannot
   *   distinguish from a healthy sidecar.
   *
   * Either leaves a stale wal-index that fails every fresh read-only
   * open with SQLITE_IOERR until the handle is rebuilt. Called on the
   * download loop's per-tile touchpoints, where a stat is negligible
   * against the throttled fetch cadence.
   */
  _healIfSidecarWedged() {
    if (this.db == null) return;
    let stat;
    try {
      stat = fs.statSync(this.walPath);
    } catch {
      this._reopenHealed();
      return;
    }
    if (stat.ino > 0 && stat.ino !== this._walIno) {
      this._reopenHealed();
    }
  }

  /**
   * Runs a database operation, rebuilding the handle once when a disk
   * I/O error strikes — the sliver of wedge window between the sidecar
   * existence check and the statement.
   *
   * @template T
   * @param {() => T} fn - Operation closure, re-run on the healed handle
   * @returns {T}
   */
  _withIoRetry(fn) {
    try {
      return fn();
    } catch (err) {
      if (!isIoError(err)) throw err;
      this._reopenHealed();
      return fn();
    }
  }

  /**
   * Does this tile already exist in the cache?
   *
   * @param {number} z - Zoom level
   * @param {number} x - Tile column
   * @param {number} yTms - TMS tile row (bottom-left origin)
   * @returns {boolean}
   */
  hasTile(z, x, yTms) {
    this._healIfSidecarWedged();
    return this._withIoRetry(() => this._hasTile.get(z, x, yTms) != null);
  }

  /**
   * Reads a tile's blob data.
   *
   * @param {number} z
   * @param {number} x
   * @param {number} yTms
   * @returns {Uint8Array|null} Tile bytes, or null when not cached
   */
  getTile(z, x, yTms) {
    const row = this._getTile.get(z, x, yTms);
    return row ? row.tile_data : null;
  }

  /**
   * Atomic upsert via `INSERT OR IGNORE`: never overwrites an existing
   * tile, so concurrent jobs and re-runs are safe.
   *
   * @param {number} z
   * @param {number} x
   * @param {number} yTms
   * @param {Uint8Array} data - Tile blob
   * @returns {boolean} True when a new row was inserted
   */
  insertTile(z, x, yTms, data) {
    this._healIfSidecarWedged();
    const result = this._withIoRetry(() =>
      this._insertTile.run(z, x, yTms, data),
    );
    return result.changes > 0;
  }

  /**
   * Does the cache hold any tile at all? Guards against mixing tile
   * formats in one file: an empty file may switch `format` freely, a
   * filled one must not (the consumer would serve png bytes as pbf or
   * vice versa).
   *
   * @returns {boolean}
   */
  hasAnyTile() {
    return this._hasAnyTile.get() != null;
  }

  /**
   * @param {string} name - Metadata key
   * @returns {string|null} Metadata value
   */
  getMetadata(name) {
    const row = this._getMetadata.get(name);
    return row ? row.value : null;
  }

  /**
   * @param {string} name - Metadata key
   * @param {string} value - Metadata value
   */
  setMetadata(name, value) {
    this._deleteMetadata.run(name);
    this._setMetadata.run(name, String(value));
  }

  /**
   * Records the tile format (`png` raster or `pbf` vector). The consumer
   * plugin serves tiles with the matching Content-Type (and
   * `Content-Encoding: gzip` for compressed pbf blobs), so this row must
   * match what the downloader actually stores.
   *
   * @param {"png"|"pbf"} format
   */
  setFormat(format) {
    this.setMetadata("format", format);
  }

  /**
   * Records the vector tile's source-layer ids (from the provider's
   * TileJSON `vector_layers`). charts-provider-simple surfaces them as
   * `chartLayers` on the chart resource so MapLibre clients can build a
   * style without fetching a tile first.
   *
   * @param {string[]} layerIds
   */
  setVectorLayers(layerIds) {
    this.setMetadata(
      "vector_layers",
      JSON.stringify(layerIds.map((id) => ({ id }))),
    );
  }

  /**
   * Updates the `bounds` metadata row to the geographic bounding box of
   * the corridor so the consumer plugin bounds the chart correctly.
   *
   * @param {[number, number, number, number]} bounds - [west, south, east, north]
   */
  setBounds(bounds) {
    this.setMetadata("bounds", bounds.join(","));
  }

  /**
   * Records the configured download range in the `minzoom`/`maxzoom`
   * metadata rows.
   *
   * @param {number} minZoom
   * @param {number} maxZoom
   */
  setZoomLevels(minZoom, maxZoom) {
    this.setMetadata("minzoom", String(minZoom));
    this.setMetadata("maxzoom", String(maxZoom));
  }

  /**
   * Size of the main database file on disk (excluding the WAL sidecar).
   *
   * @returns {number} Bytes, 0 when the file cannot be stat'ed
   */
  sizeBytes() {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Reclaims free pages. Must not run while a download job holds write
   * cycles; the REST layer enforces that.
   */
  vacuum() {
    this._healIfSidecarWedged();
    this._withIoRetry(() => this.db.exec("VACUUM;"));
  }

  /** Closes the database connection. */
  close() {
    try {
      this.db.close();
    } catch {
      // Already closed or never fully opened; nothing to do.
    }
    this.db = null;
  }
}

module.exports = { MbTilesStore, nodeSupportsSqlite, isIoError };
