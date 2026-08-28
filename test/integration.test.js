const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { MbTilesStore } = require("../lib/mbtiles.js");
const { createDownloader } = require("../lib/downloader.js");

/** A realistic tile body (>= 500 bytes). */
const PNG = Buffer.alloc(600, 0x89);

describe("downloader integration (real fetch + real store)", () => {
	let server;
	let baseUrl;
	let dir;
	let dbPath;
	const requests = [];

	beforeEach(async () => {
		server = http.createServer((req, res) => {
			requests.push({ url: req.url, userAgent: req.headers["user-agent"] });
			res.writeHead(200, { "Content-Type": "image/png" });
			res.end(PNG);
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${server.address().port}`;
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "integration-"));
		dbPath = path.join(dir, "cache.mbtiles");
	});

	afterEach(async () => {
		await new Promise((resolve) => server.close(resolve));
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

	test("downloads over real HTTP into a real MBTiles file", async () => {
		const store = new MbTilesStore(dbPath);
		const downloader = createDownloader({
			store,
			tileServerUrl: `${baseUrl}/seamark/{z}/{x}/{y}.png`,
			userAgent: "IntegrationTest/1.0",
			throttleMs: 1,
			sleepFn: () => Promise.resolve(),
		});

		const tiles = [
			{ z: 8, x: 14, y: 141, yTms: 114 },
			{ z: 8, x: 7, y: 141, yTms: 114 },
		];
		assert.equal(downloader.start(tiles), true);

		await new Promise((resolve, reject) => {
			const check = () => {
				if (!downloader.status().isDownloading) resolve();
				else if (requests.length > 10) reject(new Error("runaway loop"));
				else setImmediate(check);
			};
			check();
		});

		const status = downloader.status();
		assert.equal(status.state, "completed");
		assert.equal(status.completed, 2);
		assert.equal(status.failed, 0);
		assert.deepEqual(
			requests.map((r) => r.url),
			["/seamark/8/14/141.png", "/seamark/8/7/141.png"],
		);
		assert.ok(
			requests.every((r) => r.userAgent === "IntegrationTest/1.0"),
			"custom User-Agent sent",
		);

		// Tiles are readable through a second (consumer-style) connection
		const { DatabaseSync } = require("node:sqlite");
		const reader = new DatabaseSync(dbPath);
		const rows = reader.prepare("SELECT COUNT(*) AS n FROM tiles").get();
		reader.close();
		assert.equal(rows.n, 2);
		store.close();
	});
});
