/**
 * MBTiles storage on top of `node:sqlite` (`DatabaseSync`).
 *
 * Writes a standard SQLite .mbtiles file (TMS tile scheme) that
 * `signalk-charts-provider-simple` can serve to Freeboard SK. WAL
 * journaling plus `INSERT OR IGNORE` keep the writer and any concurrent
 * reader (the consumer plugin) from blocking each other.
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
 * a user may have added (e.g. `attribution`) are left untouched.
 */
const BASE_METADATA_SQL = `
INSERT OR REPLACE INTO metadata (name, value) VALUES
  ('name', 'Signal K Corridor Cache'),
  ('format', 'png'),
  ('type', 'overlay'),
  ('version', '1.0.0');
`;

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
   * @throws When node:sqlite is unavailable or the file cannot open
   */
  constructor(filePath) {
    if (!nodeSupportsSqlite()) {
      throw new Error(
        `Node.js >= 22.5.0 required for node:sqlite (running ${process.versions.node})`,
      );
    }
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    // WAL is mandatory for read/write concurrency with the consumer
    // plugin; busy_timeout rides out any residual lock contention.
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA synchronous=NORMAL;
    `);
    this.db.exec(SCHEMA_SQL);
    this.db.exec(BASE_METADATA_SQL);

    this._hasTile = this.db.prepare(
      "SELECT 1 AS hit FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
    );
    this._getTile = this.db.prepare(
      "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
    );
    this._insertTile = this.db.prepare(
      "INSERT OR IGNORE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
    );
    this._getMetadata = this.db.prepare(
      "SELECT value FROM metadata WHERE name = ?",
    );
    this._setMetadata = this.db.prepare(
      "INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)",
    );
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
    return this._hasTile.get(z, x, yTms) != null;
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
    const result = this._insertTile.run(z, x, yTms, data);
    return result.changes > 0;
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
    this._setMetadata.run(name, String(value));
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
    this.db.exec("VACUUM;");
  }

  /** Closes the database connection. */
  close() {
    try {
      this.db.close();
    } catch {
      // Already closed or never fully opened; nothing to do.
    }
  }
}

module.exports = { MbTilesStore, nodeSupportsSqlite };
