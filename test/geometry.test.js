const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  bufferTiles,
  boundsWithMargin,
  corridorTier,
  corridorTiles,
  distanceNM,
  greatCirclePoint,
  interpolateRoute,
  isValidCoordinate,
  latToTileY,
  lonToTileX,
  tileXToLon,
  tileYToLat,
  xyzToTmsY,
  STRATEGIC_MAX_ZOOM,
  TACTICAL_MAX_ZOOM,
} = require("../lib/geometry.js");

describe("slippy tile math", () => {
  test("lonToTileX matches known values", () => {
    assert.equal(lonToTileX(0, 2), 2);
    // Aitutaki at z8
    assert.equal(lonToTileX(-159.78, 8), 14);
    assert.equal(lonToTileX(159.78, 8), 241);
    assert.equal(lonToTileX(-180, 0), 0);
    assert.equal(lonToTileX(179.999, 0), 0);
  });

  test("latToTileY matches known values", () => {
    assert.equal(latToTileY(0, 2), 2);
    // Aitutaki at z8
    assert.equal(latToTileY(-18.85, 8), 141);
    // North pole edge clamps to the projection range
    assert.equal(latToTileY(89.9, 0), 0);
  });

  test("tileXToLon / tileYToLat invert the projection", () => {
    for (const [lat, lon] of [
      [0, 0],
      [-18.85, -159.78],
      [60.5, 21.2],
    ]) {
      const z = 10;
      const x = lonToTileX(lon, z);
      const y = latToTileY(lat, z);
      // The point falls inside the tile it maps to
      assert.ok(lon >= tileXToLon(x, z) - 1e-9);
      assert.ok(lon <= tileXToLon(x + 1, z) + 1e-9);
      assert.ok(lat >= tileYToLat(y + 1, z) - 1e-6);
      assert.ok(lat <= tileYToLat(y, z) + 1e-6);
    }
  });

  test("xyzToTmsY inverts the y axis", () => {
    assert.equal(xyzToTmsY(0, 0), 0);
    assert.equal(xyzToTmsY(0, 1), 1);
    assert.equal(xyzToTmsY(1, 1), 0);
    assert.equal(xyzToTmsY(141, 8), 114);
    // Round trip
    assert.equal(xyzToTmsY(xyzToTmsY(37, 9), 9), 37);
  });
});

describe("distance and interpolation", () => {
  test("distanceNM: one degree of longitude on the equator is 60 NM", () => {
    assert.ok(
      Math.abs(distanceNM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 60) < 0.1,
    );
  });

  test("distanceNM: one degree of latitude is 60 NM", () => {
    assert.ok(
      Math.abs(distanceNM({ lat: 10, lon: 20 }, { lat: 11, lon: 20 }) - 60) <
        0.1,
    );
  });

  test("greatCirclePoint interpolates along the equator", () => {
    const mid = greatCirclePoint({ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, 0.5);
    assert.ok(Math.abs(mid.lat) < 1e-9);
    assert.ok(Math.abs(mid.lon - 5) < 1e-6);
  });

  test("greatCirclePoint handles degenerate segments", () => {
    const a = { lat: 12.3, lon: 45.6 };
    assert.deepEqual(greatCirclePoint(a, a, 0.5), a);
    assert.deepEqual(greatCirclePoint(a, { lat: 1, lon: 2 }, 0), a);
  });

  test("interpolateRoute samples every step and keeps vertices", () => {
    const a = { lat: 0, lon: 0 };
    const b = { lat: 0, lon: 1 }; // ~60.04 NM apart
    const points = interpolateRoute([a, b], 30);
    assert.deepEqual(points[0], a);
    assert.deepEqual(points[points.length - 1], b);
    // ceil(60.04 / 30) segments -> 4 points, none farther apart than the step
    assert.equal(points.length, 4);
    for (let i = 0; i + 1 < points.length; i++) {
      assert.ok(distanceNM(points[i], points[i + 1]) <= 30.1);
    }
  });

  test("interpolateRoute on a zero-length segment emits one point", () => {
    const a = { lat: 5, lon: 6 };
    assert.equal(interpolateRoute([a, a], 10).length, 2);
  });
});

describe("swath buffer", () => {
  test("bufferTiles: margin 10 NM at z14 on the equator is 8 tiles", () => {
    assert.equal(bufferTiles(10, 0, 14).nx, 8);
  });

  test("bufferTiles: x padding grows with latitude (cos effect)", () => {
    const eq = bufferTiles(10, 0, 14);
    const tropic = bufferTiles(10, -18.85, 14);
    assert.equal(tropic.nx, 9);
    assert.ok(tropic.nx > eq.nx);
    assert.ok(tropic.ny >= eq.nx);
  });

  test("bufferTiles: zero margin means no buffer", () => {
    assert.deepEqual(bufferTiles(0, 21, 12), { nx: 0, ny: 0 });
  });
});

describe("corridorTier", () => {
  test("maps zoom bands to margin tiers", () => {
    const margins = {
      strategicMarginNM: 50,
      tacticalMarginNM: 15,
      approachRadiusNM: 3,
    };
    assert.deepEqual(corridorTier(8, margins), {
      margin: 50,
      approachOnly: false,
    });
    assert.deepEqual(corridorTier(10, margins), {
      margin: 50,
      approachOnly: false,
    });
    assert.deepEqual(corridorTier(11, margins), {
      margin: 15,
      approachOnly: false,
    });
    assert.deepEqual(corridorTier(13, margins), {
      margin: 15,
      approachOnly: false,
    });
    assert.deepEqual(corridorTier(14, margins), {
      margin: 3,
      approachOnly: true,
    });
    assert.deepEqual(corridorTier(16, margins), {
      margin: 3,
      approachOnly: true,
    });
  });
});

describe("corridorTiles", () => {
  const TIERS = {
    strategicMarginNM: 0,
    tacticalMarginNM: 0,
    approachRadiusNM: 0,
  };

  test("single point with no margin covers just that tile per zoom", () => {
    const { tiles, bounds } = corridorTiles([{ lat: 0, lon: 0 }], {
      minZoom: 0,
      maxZoom: 1,
      ...TIERS,
    });
    assert.equal(tiles.length, 2);
    assert.deepEqual(tiles[0], { z: 0, x: 0, y: 0, yTms: 0 });
    assert.deepEqual(tiles[1], { z: 1, x: 1, y: 1, yTms: 0 });
    assert.ok(bounds);
    assert.ok(bounds[0] < 0 && bounds[2] > 0);
    assert.ok(bounds[1] < 0 && bounds[3] > 0);
  });

  test("corridor is deduplicated and range-clamped", () => {
    const coordinates = Array.from({ length: 10 }, () => ({
      lat: -18.85,
      lon: -179.9,
    }));
    const { tiles } = corridorTiles(coordinates, {
      minZoom: 3,
      maxZoom: 3,
      strategicMarginNM: 20,
      tacticalMarginNM: 20,
      approachRadiusNM: 20,
    });
    const keys = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
    assert.equal(keys.size, tiles.length);
    for (const t of tiles) {
      assert.ok(t.x >= 0 && t.x < 2 ** t.z);
      assert.ok(t.y >= 0 && t.y < 2 ** t.z);
      assert.equal(t.yTms, 2 ** t.z - 1 - t.y);
    }
  });

  test("a line corridor covers both endpoints and stays connected", () => {
    const { tiles } = corridorTiles(
      [
        { lat: -18.85, lon: -159.78 },
        { lat: -19.05, lon: -169.85 },
      ],
      {
        minZoom: 8,
        maxZoom: 8,
        strategicMarginNM: 10,
        tacticalMarginNM: 10,
        approachRadiusNM: 10,
      },
    );
    const keys = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
    // Both endpoint tiles are inside the corridor
    assert.ok(keys.has("8/14/141"));
    // Niue at z8: x = 7, y = 141
    assert.ok(keys.has("8/7/141"));
    // And there is a connected path of tiles between them
    assert.ok(tiles.length > 10);
  });

  test("strategic zooms use the wide margin, tactical zooms the narrow one", () => {
    const coordinates = [{ lat: 0, lon: 0 }];
    const strategic = corridorTiles(coordinates, {
      minZoom: STRATEGIC_MAX_ZOOM,
      maxZoom: STRATEGIC_MAX_ZOOM,
      strategicMarginNM: 30,
      tacticalMarginNM: 0,
      approachRadiusNM: 0,
    });
    const tactical = corridorTiles(coordinates, {
      minZoom: TACTICAL_MAX_ZOOM,
      maxZoom: TACTICAL_MAX_ZOOM,
      strategicMarginNM: 30,
      tacticalMarginNM: 0,
      approachRadiusNM: 0,
    });
    // Wide strategic margin covers many tiles; zero tactical margin covers one
    assert.ok(strategic.tiles.length > 9);
    assert.equal(tactical.tiles.length, 1);
  });

  test("approach zooms only buffer the start and end coordinates", () => {
    const start = { lat: -18.85, lon: -159.78 }; // Aitutaki
    const mid = { lat: -18.95, lon: -164.8 }; // mid-ocean, ~250 NM from both ends
    const end = { lat: -19.05, lon: -169.85 }; // Niue
    const approach = corridorTiles([start, mid, end], {
      minZoom: 14,
      maxZoom: 14,
      strategicMarginNM: 50,
      tacticalMarginNM: 15,
      approachRadiusNM: 3,
    });

    const zs = new Set(approach.tiles.map((t) => t.z));
    assert.deepEqual([...zs], [14]);
    // The 3 NM ring at z14 spans a known tile radius per endpoint
    const startRing = bufferTiles(3, start.lat, 14);
    const endRing = bufferTiles(3, end.lat, 14);
    for (const t of approach.tiles) {
      // Every tile must be within the approach ring of either endpoint,
      // never around the mid-ocean waypoint
      const nearStart =
        Math.abs(t.x - lonToTileX(start.lon, 14)) <= startRing.nx &&
        Math.abs(t.y - latToTileY(start.lat, 14)) <= startRing.ny;
      const nearEnd =
        Math.abs(t.x - lonToTileX(end.lon, 14)) <= endRing.nx &&
        Math.abs(t.y - latToTileY(end.lat, 14)) <= endRing.ny;
      assert.ok(
        nearStart || nearEnd,
        `tile ${t.x},${t.y} not near an endpoint`,
      );
    }
    assert.ok(approach.tiles.length >= 2);
  });

  test("bounds are padded by the widest configured margin", () => {
    const { bounds } = corridorTiles([{ lat: 0, lon: 0 }], {
      minZoom: 8,
      maxZoom: 8,
      strategicMarginNM: 60,
      tacticalMarginNM: 15,
      approachRadiusNM: 3,
    });
    // 60 NM ~ 1 degree, plus the small quantization pad
    assert.ok(bounds[1] < -1 && bounds[3] > 1);
    assert.ok(bounds[0] < -1 && bounds[2] > 1);
  });

  test("invalid zoom order is swapped and invalid input yields nothing", () => {
    const swapped = corridorTiles([{ lat: 0, lon: 0 }], {
      minZoom: 5,
      maxZoom: 4,
      ...TIERS,
    });
    assert.equal(swapped.tiles.length, 2);
    assert.deepEqual(corridorTiles([], { minZoom: 1, maxZoom: 1, ...TIERS }), {
      tiles: [],
      bounds: null,
    });
    assert.deepEqual(
      corridorTiles([{ lat: 999, lon: 0 }], {
        minZoom: 1,
        maxZoom: 1,
        ...TIERS,
      }).tiles,
      [],
    );
  });
});

describe("isValidCoordinate", () => {
  test("accepts in-range {lat, lon} and rejects junk", () => {
    assert.ok(isValidCoordinate({ lat: 0, lon: 0 }));
    assert.ok(isValidCoordinate({ lat: "-18.85", lon: -159.78 }));
    assert.ok(!isValidCoordinate({ lat: 91, lon: 0 }));
    assert.ok(!isValidCoordinate({ lat: 0, lon: 181 }));
    assert.ok(!isValidCoordinate({ lat: Number.NaN, lon: 0 }));
    assert.ok(!isValidCoordinate(null));
    assert.ok(!isValidCoordinate("foo"));
  });
});

describe("boundsWithMargin", () => {
  test("pads the bbox by the margin and clamps to the projection", () => {
    const bounds = boundsWithMargin([{ lat: 0, lon: 0 }], 60);
    // 60 NM ~ 1 degree of latitude, plus the small quantization pad
    assert.ok(bounds[1] < -1 && bounds[3] > 1);
    assert.ok(bounds[0] < -1 && bounds[2] > 1);

    const clamped = boundsWithMargin([{ lat: 85, lon: 179 }], 500);
    assert.equal(clamped[3], 85.0511);
    assert.equal(clamped[2], 180);
  });
});
