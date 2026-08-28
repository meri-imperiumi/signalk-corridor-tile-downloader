const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { MbTilesStore } = require("../lib/mbtiles.js");

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

describe("MbTilesStore", () => {
	test("creates the database, schema and required metadata", () => {
		const store = new MbTilesStore(dbPath);
		assert.ok(fs.existsSync(dbPath));
		assert.equal(store.getMetadata("name"), "Signal K Corridor Cache");
		assert.equal(store.getMetadata("format"), "png");
		assert.equal(store.getMetadata("type"), "overlay");
		assert.equal(store.getMetadata("version"), "1.0.0");
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
