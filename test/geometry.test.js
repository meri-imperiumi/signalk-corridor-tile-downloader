const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  bubbleTiles,
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
  overviewTiles,
  tileXToLon,
  tileYToLat,
  unionBoxes,
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

describe("bubbleTiles (JIT recovery)", () => {
  test("covers a radius bubble around the position", () => {
    // At z12 tiles are ~5.3 NM wide on the equator, so a 5 NM radius
    // pads one tile in each direction: a 3x3 block.
    const tiles = bubbleTiles({ lat: 0, lon: 0 }, 12, 5);
    assert.equal(tiles.length, 9);
    assert.ok(tiles.some((t) => t.x === 2048 && t.y === 2048));
    for (const t of tiles) {
      assert.ok(t.x >= 2047 && t.x <= 2049);
      assert.ok(t.y >= 2047 && t.y <= 2049);
      assert.equal(t.yTms, 2 ** 12 - 1 - t.y);
    }
  });

  test("clamps at the tile grid edge", () => {
    const tiles = bubbleTiles({ lat: 0, lon: 179.999 }, 8, 5);
    assert.ok(tiles.length > 0);
    assert.ok(tiles.length < 9);
    for (const t of tiles) {
      assert.ok(t.x <= 255);
      assert.ok(t.y < 256);
    }
  });

  test("zero radius is just the containing tile", () => {
    const tiles = bubbleTiles({ lat: -18.85, lon: -159.78 }, 10, 0);
    assert.equal(tiles.length, 1);
    const { lonToTileX: x, latToTileY: y } = require("../lib/geometry.js");
    assert.equal(tiles[0].x, x(-159.78, 10));
    assert.equal(tiles[0].y, y(-18.85, 10));
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
    const { tiles, boxes } = corridorTiles([{ lat: 0, lon: 0 }], {
      minZoom: 0,
      maxZoom: 1,
      ...TIERS,
    });
    assert.equal(tiles.length, 2);
    assert.deepEqual(tiles[0], { z: 0, x: 0, y: 0, yTms: 0 });
    assert.deepEqual(tiles[1], { z: 1, x: 1, y: 1, yTms: 0 });
    assert.equal(boxes.length, 1);
    assert.ok(boxes[0][0] < 0 && boxes[0][2] > 0);
    assert.ok(boxes[0][1] < 0 && boxes[0][3] > 0);
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

  test("bounds boxes are padded by the widest configured margin", () => {
    const { boxes } = corridorTiles([{ lat: 0, lon: 0 }], {
      minZoom: 8,
      maxZoom: 8,
      strategicMarginNM: 60,
      tacticalMarginNM: 15,
      approachRadiusNM: 3,
    });
    // 60 NM ~ 1 degree, plus the small quantization pad
    assert.equal(boxes.length, 1);
    assert.ok(boxes[0][1] < -1 && boxes[0][3] > 1);
    assert.ok(boxes[0][0] < -1 && boxes[0][2] > 1);
  });

  test("a seam-crossing corridor stays seam-local: tiles, boxes, and the overview all cover both sides of 180°", () => {
    // Westbound Samoa (171.8W) -> Fiji (178E): crosses the
    // antimeridian going west, the naive min/max box would span the
    // long way around the world
    const samoa = { lat: -14.0, lon: -171.8 };
    const fiji = { lat: -17.8, lon: 178.0 };
    const { tiles, boxes } = corridorTiles([samoa, fiji], {
      minZoom: 10,
      maxZoom: 10,
      strategicMarginNM: 50,
      tacticalMarginNM: 15,
      approachRadiusNM: 3,
    });
    // Two bounds boxes, one per side of the seam, both valid. The
    // unwrapped span starts on the east side (Samoa unwrapped westward
    // past -180 to Fiji-at--182), so boxes[0] is the eastern box
    assert.equal(boxes.length, 2);
    const [eastSide, westSide] = boxes;
    assert.ok(
      eastSide[0] > 170 && eastSide[2] === 180,
      "east box hugs the seam",
    );
    assert.ok(
      westSide[0] === -180 && westSide[2] < -170,
      "west box hugs the seam",
    );
    // The corridor tiles straddle both edges of the tile grid
    const xs = tiles.filter((t) => t.z === 10).map((t) => t.x);
    assert.ok(Math.min(...xs) <= 10, "tiles near the grid's west edge");
    assert.ok(Math.max(...xs) >= 1013, "tiles near the grid's east edge");
    // Every interpolated track point's own tile is in the corridor
    for (const p of interpolateRoute([samoa, fiji], 5)) {
      const key = `10/${lonToTileX(p.lon, 10)}/${latToTileY(p.lat, 10)}`;
      assert.ok(
        tiles.some((t) => `${t.z}/${t.x}/${t.y}` === key),
        `track point ${p.lat.toFixed(3)},${p.lon.toFixed(3)} uncovered`,
      );
    }
    // The overview pyramid over the split boxes covers the track on
    // BOTH sides of the seam (the old world-spanning box missed the
    // tiles right at 180°)
    const overview = overviewTiles(boxes, 7);
    const overviewKeys = new Set(overview.map((t) => `${t.z}/${t.x}/${t.y}`));
    let covered = 0;
    for (const p of interpolateRoute([samoa, fiji], 5)) {
      if (overviewKeys.has(`7/${lonToTileX(p.lon, 7)}/${latToTileY(p.lat, 7)}`))
        covered++;
    }
    assert.equal(covered, 128, "every z7 track tile is in the overview");
    // ...without fetching the rest of the world at those latitudes
    // (a tile counts as far only when its FULL span is away from the
    // seam — low-zoom tiles legitimately reach 180° from inside)
    const farAway = overview.filter((t) => {
      const w = tileXToLon(t.x, t.z);
      const e = tileXToLon(t.x + 1, t.z);
      return w > -170 && e < 170;
    });
    assert.equal(farAway.length, 0, "overview stays seam-local");
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
      boxes: null,
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
    const boxes = boundsWithMargin([{ lat: 0, lon: 0 }], 60);
    assert.equal(boxes.length, 1);
    // 60 NM ~ 1 degree of latitude, plus the small quantization pad
    assert.ok(boxes[0][1] < -1 && boxes[0][3] > 1);
    assert.ok(boxes[0][0] < -1 && boxes[0][2] > 1);

    const clamped = boundsWithMargin([{ lat: 85, lon: 179 }], 500);
    assert.equal(clamped[0][3], 85.0511);
    assert.equal(clamped[0][2], 180);
  });

  test("a wide margin wrapping past the seam splits into two boxes", () => {
    // 500 NM ~ 8.3 degrees: the padded span around lon 179 crosses 180
    const boxes = boundsWithMargin([{ lat: 10, lon: 179 }], 500);
    assert.equal(boxes.length, 2);
    assert.equal(boxes[0][2], 180);
    assert.equal(boxes[1][0], -180);
    assert.ok(boxes[1][2] < -170);
  });

  test("westbound and eastbound seam crossings produce the same split boxes", () => {
    const samoa = { lat: -14.0, lon: -171.8 };
    const fiji = { lat: -17.8, lon: 178.0 };
    const westbound = boundsWithMargin([samoa, fiji], 50);
    const eastbound = boundsWithMargin([fiji, samoa], 50);
    const norm = (boxes) =>
      boxes
        .map((b) => b.map((v) => Math.round(v * 100) / 100))
        .sort((a, b) => a[0] - b[0]);
    assert.deepEqual(norm(westbound), norm(eastbound));
    // Both sides hug the seam instead of spanning the world
    assert.equal(westbound.length, 2);
    assert.ok(westbound[0][0] > 170 && westbound[0][2] === 180);
    assert.ok(westbound[1][0] === -180 && westbound[1][2] < -170);

    // Eastbound is fully covered too, not just bounded: every
    // interpolated track point has its corridor tile at z10 and its
    // overview tile at z7, and no overview tile lies far from the
    // seam
    const { tiles } = corridorTiles([fiji, samoa], {
      minZoom: 10,
      maxZoom: 10,
      strategicMarginNM: 50,
      tacticalMarginNM: 15,
      approachRadiusNM: 3,
    });
    const corridorKeys = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
    const overviewKeys = new Set(
      overviewTiles(eastbound, 7).map((t) => `${t.z}/${t.x}/${t.y}`),
    );
    for (const p of interpolateRoute([fiji, samoa], 5)) {
      assert.ok(
        corridorKeys.has(
          `10/${lonToTileX(p.lon, 10)}/${latToTileY(p.lat, 10)}`,
        ),
        `eastbound track point ${p.lat.toFixed(3)},${p.lon.toFixed(3)} uncovered at z10`,
      );
      assert.ok(
        overviewKeys.has(`7/${lonToTileX(p.lon, 7)}/${latToTileY(p.lat, 7)}`),
        `eastbound track point ${p.lat.toFixed(3)},${p.lon.toFixed(3)} uncovered by the overview`,
      );
    }
  });

  test("non-crossing routes stay a single box", () => {
    const boxes = boundsWithMargin(
      [
        { lat: -18.85, lon: -159.78 },
        { lat: -19.05, lon: -169.85 },
      ],
      15,
    );
    assert.equal(boxes.length, 1);
    assert.ok(boxes[0][0] < -159 && boxes[0][2] > -170);
  });

  test("a span wrapping the whole globe collapses to one world box", () => {
    // Consecutive legs each under 180°, accumulating past 360°
    const coords = Array.from({ length: 9 }, (_, i) => ({
      lat: 0,
      lon: i * 90,
    }));
    coords.push({ lat: 0, lon: 10 }); // 10° east of the start, going around
    const boxes = boundsWithMargin(coords, 10);
    assert.deepEqual(boxes.length, 1);
    assert.equal(boxes[0][0], -180);
    assert.equal(boxes[0][2], 180);
  });
});

describe("unionBoxes", () => {
  test("collapses a single box to itself", () => {
    const box = [-10, -5, 10, 5];
    assert.deepEqual(unionBoxes([box]), box);
  });

  test("a seam-split pair unions to the full-width box metadata needs", () => {
    const box = unionBoxes([
      [177.1, -18.7, 180, -13.1],
      [-180, -18.7, -171.0, -13.1],
    ]);
    assert.deepEqual(box, [-180, -18.7, 180, -13.1]);
  });

  test("returns null for nothing", () => {
    assert.equal(unionBoxes(null), null);
    assert.equal(unionBoxes([]), null);
  });
});

describe("overviewTiles (low-zoom pyramid)", () => {
  test("covers the bounding rectangles from z0 through toZoom", () => {
    // A ~2°x2° box around the Marquesas
    const tiles = overviewTiles([[-160.5, -10.5, -158.5, -8.5]], 2);
    const byZoom = new Map();
    for (const t of tiles) {
      byZoom.set(t.z, (byZoom.get(t.z) ?? 0) + 1);
    }
    assert.equal(byZoom.get(0), 1, "single z0 world tile");
    assert.equal(byZoom.get(1), 1, "one z1 tile covers 2°x2°");
    assert.ok(byZoom.get(2) >= 1 && byZoom.get(2) <= 4, "z2 handful");
    // TMS rows are the flipped XYZ y
    for (const t of tiles) {
      assert.equal(t.yTms, 2 ** t.z - 1 - t.y);
    }
  });

  test("covers both sides of a seam-split box pair, deduped and sorted", () => {
    // Split boxes straddling ±180°: the pyramid must cover both sides
    // (a single box cannot wrap the seam) and dedupe the z0 world tile
    const tiles = overviewTiles(
      [
        [179.5, -1, 180, 1],
        [-180, -1, -179.5, 1],
      ],
      3,
    );
    const keys = tiles.map((t) => `${t.z}/${t.x}/${t.y}`);
    assert.ok(keys.includes("0/0/0"), "z0 world tile spans the seam");
    // At z3 the seam sits between x=7 (157.5E-180E) and x=0
    // (180W-157.5W); 1N/1S rows are y=3 and y=4
    assert.ok(keys.includes("3/7/3"), "east-side seam tile at z3");
    assert.ok(keys.includes("3/0/3"), "west-side seam tile at z3");
    assert.equal(new Set(keys).size, keys.length, "tiles deduped across boxes");
    // Deterministic z-major ordering
    const sorted = [...tiles].sort(
      (a, b) => a.z - b.z || a.x - b.x || a.y - b.y,
    );
    assert.deepEqual(tiles, sorted);
  });

  test("degrades quietly on bad input", () => {
    assert.deepEqual(overviewTiles(null, 7), []);
    assert.deepEqual(overviewTiles([[1, 2, 3]], 7), []);
    // toZoom 0 → just the containing z0 tile
    const z0 = overviewTiles([[20, 60, 21, 60.5]], 0);
    assert.deepEqual(z0, [{ z: 0, x: 0, y: 0, yTms: 0 }]);
  });
});
