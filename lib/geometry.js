/**
 * Geospatial and tile mathematics for the corridor downloader.
 *
 * Pure functions only (no I/O) so everything is unit-testable in Node.
 * Implements the SPEC's tile engine:
 *
 * - Slippy-map XYZ conversion (origin top-left)
 * - MBTiles TMS y-axis inversion (origin bottom-left)
 * - Multi-tier swath buffers (SPEC Addendum 1): a physical margin in
 *   nautical miles translated into a per-point tile padding at a given
 *   latitude and zoom, with strategic / tactical / approach tiers
 * - Great-circle route interpolation so long ocean passages are
 *   sampled along the actual track, not the rhumb line
 *
 * @file lib/geometry.js
 */

/** Mean Earth radius in nautical miles (6371 km / 1.852). */
const EARTH_RADIUS_NM = 3440.065;

/** Web Mercator latitude clamp (the projection's valid range). */
const MAX_MERCATOR_LAT = 85.0511;

/**
 * Upper bound for the per-point tile buffer. Without a cap the buffer
 * explodes near the poles (`cos(lat) -> 0`), producing enormous tile
 * squares from a small physical margin.
 */
const MAX_BUFFER_TILES = 64;

/**
 * Multi-tier margin strategy (SPEC Addendum 1):
 *
 * - Strategic swath, zooms <= 10: wide margin for weather routing and
 *   major deviations (default 50 NM)
 * - Tactical swath, zooms 11-13: standard tacking margin (default 15 NM)
 * - Approach rings, zooms >= 14: small radius strictly around the
 *   route's start and end points for reef/anchorage detail (default 3 NM)
 */
const STRATEGIC_MAX_ZOOM = 10;
const TACTICAL_MAX_ZOOM = 13;

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * Longitude to slippy-map tile x at zoom z.
 *
 * @param {number} lon - Longitude in degrees
 * @param {number} z - Zoom level (0-22)
 * @returns {number} Tile x (unclamped; callers range-check)
 */
function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

/**
 * Latitude to slippy-map tile y at zoom z (origin top-left).
 *
 * @param {number} lat - Latitude in degrees
 * @param {number} z - Zoom level
 * @returns {number} Tile y (unclamped; callers range-check)
 */
function latToTileY(lat, z) {
  const l = Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, lat));
  const s = Math.sin(rad(l));
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
  return Math.floor(y);
}

/**
 * Tile x to the longitude of the tile's western edge.
 *
 * @param {number} x
 * @param {number} z
 * @returns {number} Longitude in degrees
 */
function tileXToLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}

/**
 * Tile y to the latitude of the tile's southern edge (slippy orientation).
 *
 * @param {number} y
 * @param {number} z
 * @returns {number} Latitude in degrees
 */
function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return deg(Math.atan(Math.sinh(n)));
}

/**
 * Converts a slippy-map (XYZ) y coordinate to the MBTiles (TMS) row.
 * XYZ origins at the top-left; TMS at the bottom-left.
 *
 * @param {number} y - XYZ tile y
 * @param {number} z - Zoom level
 * @returns {number} TMS tile row
 */
function xyzToTmsY(y, z) {
  return 2 ** z - 1 - y;
}

/**
 * Great-circle distance between two points in nautical miles.
 *
 * @param {{lat: number, lon: number}} a
 * @param {{lat: number, lon: number}} b
 * @returns {number} Distance in NM
 */
function distanceNM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Interpolates a point along the great circle between a and b.
 *
 * @param {{lat: number, lon: number}} a - Start point
 * @param {{lat: number, lon: number}} b - End point
 * @param {number} f - Fraction (0 = a, 1 = b)
 * @returns {{lat: number, lon: number}} Interpolated point
 */
function greatCirclePoint(a, b, f) {
  if (f <= 0) return { lat: a.lat, lon: a.lon };
  if (f >= 1) return { lat: b.lat, lon: b.lon };
  const phi1 = rad(a.lat);
  const lambda1 = rad(a.lon);
  const phi2 = rad(b.lat);
  const lambda2 = rad(b.lon);
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((phi2 - phi1) / 2) ** 2 +
          Math.cos(phi1) *
            Math.cos(phi2) *
            Math.sin((lambda2 - lambda1) / 2) ** 2,
      ),
    );
  if (d === 0) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x =
    A * Math.cos(phi1) * Math.cos(lambda1) +
    B * Math.cos(phi2) * Math.cos(lambda2);
  const y =
    A * Math.cos(phi1) * Math.sin(lambda1) +
    B * Math.cos(phi2) * Math.sin(lambda2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);
  return {
    lat: deg(Math.atan2(z, Math.hypot(x, y))),
    lon: deg(Math.atan2(y, x)),
  };
}

/**
 * Is this a usable navigation coordinate?
 *
 * @param {unknown} c - Anything; accepts `{lat, lon}` objects
 * @returns {boolean}
 */
function isValidCoordinate(c) {
  return (
    typeof c === "object" &&
    c !== null &&
    Number.isFinite(Number(c.lat)) &&
    Number.isFinite(Number(c.lon)) &&
    Number(c.lat) >= -90 &&
    Number(c.lat) <= 90 &&
    Number(c.lon) >= -180 &&
    Number(c.lon) <= 180
  );
}

/**
 * Samples a route into points at most `stepNM` apart along the great
 * circle of every segment, always including all vertices and the final
 * point. Consecutive samples closer together than the swath buffer
 * guarantee a continuous corridor.
 *
 * @param {{lat: number, lon: number}[]} coordinates - Route vertices
 * @param {number} stepNM - Maximum spacing between samples in NM
 * @returns {{lat: number, lon: number}[]} Interpolated points
 */
function interpolateRoute(coordinates, stepNM) {
  const points = [];
  for (let i = 0; i + 1 < coordinates.length; i++) {
    const a = coordinates[i];
    const b = coordinates[i + 1];
    const d = distanceNM(a, b);
    const n = Math.max(1, Math.ceil(d / Math.max(stepNM, 0.001)));
    for (let k = 0; k < n; k++) {
      points.push(greatCirclePoint(a, b, k / n));
    }
  }
  if (coordinates.length > 0) {
    const last = coordinates[coordinates.length - 1];
    points.push({ lat: last.lat, lon: last.lon });
  }
  return points;
}

/**
 * Swath buffer math: translates a physical margin in nautical miles at
 * latitude `lat` and zoom `z` into tile counts for the x and y axes.
 *
 * The x (longitude) tile width shrinks with `cos(lat)`; the y (latitude)
 * tile height is derived from the actual Mercator tile the point falls
 * into, which grows toward the poles.
 *
 * @param {number} marginNM - Corridor buffer radius in nautical miles
 * @param {number} lat - Latitude of the sample point
 * @param {number} z - Zoom level
 * @returns {{nx: number, ny: number}} Tile padding per axis, each >= 0
 */
function bufferTiles(marginNM, lat, z) {
  if (!(marginNM > 0)) return { nx: 0, ny: 0 };
  const tileLonNM = (360 / 2 ** z) * 60 * Math.cos(rad(lat));
  const nx =
    tileLonNM > 0
      ? Math.min(Math.ceil(marginNM / tileLonNM), MAX_BUFFER_TILES)
      : MAX_BUFFER_TILES;
  const y = latToTileY(lat, z);
  const tileLatNM = Math.abs(tileYToLat(y, z) - tileYToLat(y + 1, z)) * 60;
  const ny =
    tileLatNM > 0
      ? Math.min(Math.ceil(marginNM / tileLatNM), MAX_BUFFER_TILES)
      : MAX_BUFFER_TILES;
  return { nx, ny };
}

/**
 * Normalizes an unwrapped longitude into [-180, 180).
 *
 * @param {number} lon - Longitude, possibly outside [-180, 180]
 * @returns {number}
 */
function normLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Geographic bounds boxes of the route padded by the corridor margin
 * (margin converted to degrees; 1 degree of latitude = 60 NM),
 * clamped to the Web Mercator valid range.
 *
 * Antimeridian-aware (westbound Pacific passages cross 180°): the
 * naive min/max-of-longitude box spans the long way around the world
 * for a route crossing the seam, missing the corridor itself while
 * claiming near-global coverage. Instead the longitudes are unwrapped — each
 * vertex shifted by ±360° to stay within 180° of its predecessor,
 * matching the great-circle engine's short-way segment choice — so the
 * bounds stay a contiguous span. A span crossing the seam is split
 * into two valid boxes, one per side (a single box cannot express
 * wrapping in MBTiles/TileJSON).
 *
 * @param {{lat: number, lon: number}[]} coordinates
 * @param {number} marginNM
 * @returns {Array<[number, number, number, number]>} [west, south,
 *   east, north] boxes: one normally, two when the padded span
 *   crosses the antimeridian, one full-width box when it wraps the
 *   whole globe (>= 360°)
 */
function boundsWithMargin(coordinates, marginNM) {
  let south = 90;
  let north = -90;
  let ref = Number(coordinates[0].lon);
  let west = ref;
  let east = ref;
  for (let i = 0; i < coordinates.length; i++) {
    const c = coordinates[i];
    south = Math.min(south, c.lat);
    north = Math.max(north, c.lat);
    if (i > 0) {
      let lon = Number(c.lon);
      while (lon - ref > 180) lon -= 360;
      while (lon - ref < -180) lon += 360;
      ref = lon;
      west = Math.min(west, lon);
      east = Math.max(east, lon);
    }
  }
  // Margin in degrees, plus a small constant so tile quantization at
  // low zooms cannot clip the actual fetched tiles out of the bounds.
  const pad = marginNM / 60 + 0.05;
  south = Math.max(-MAX_MERCATOR_LAT, south - pad);
  north = Math.min(MAX_MERCATOR_LAT, north + pad);
  west -= pad;
  east += pad;
  if (east - west >= 360) {
    return [[-180, south, 180, north]];
  }
  // Split the unwrapped span at the antimeridian into normalized
  // boxes. At most two: a span under 360° crosses the seam once.
  const boxes = [];
  let start = normLon(west);
  let left = east - west;
  while (left > 1e-9) {
    const take = Math.min(left, 180 - start);
    if (take <= 0) break;
    boxes.push([start, south, Math.min(180, start + take), north]);
    left -= take;
    start = -180;
  }
  return boxes.length > 0 ? boxes : [[-180, south, 180, north]];
}

/**
 * Collapses split bounds boxes into the single [west, south, east,
 * north] box the MBTiles `bounds` metadata row and TileJSON consumers
 * expect. A seam-crossing pair collapses to the full-width box: the
 * metadata cannot express wrapping, and full width never lets a
 * clipping consumer (Freeboard) blank cached tiles on either side of
 * the seam.
 *
 * @param {Array<[number, number, number, number]>|null} boxes
 * @returns {[number, number, number, number]|null}
 */
function unionBoxes(boxes) {
  if (!Array.isArray(boxes) || boxes.length === 0) return null;
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const b of boxes) {
    west = Math.min(west, b[0]);
    south = Math.min(south, b[1]);
    east = Math.max(east, b[2]);
    north = Math.max(north, b[3]);
  }
  return [west, south, east, north];
}

/**
 * Every tile from z0 through `toZoom` intersecting the geographic
 * bounds boxes — the low-zoom "overview pyramid" each corridor job
 * fetches below its configured minimum, so zooming out always finds
 * cached context instead of blanking below the corridor. A covering
 * rectangle (not a corridor buffer): at these zooms the whole route
 * spans a handful of tiles, and the rectangles are what the chart's
 * bounds advertise anyway. Takes the split boxes from
 * `boundsWithMargin`, so a seam-crossing corridor gets its pyramid on
 * both sides of the antimeridian. Bounded by construction — the
 * widest possible corridor bounds at z0-z7 are a few hundred tiles.
 *
 * @param {Array<[number, number, number, number]>} boxes - Split
 *   [west, south, east, north] boxes; invalid entries are skipped
 * @param {number} toZoom - Inclusive top of the pyramid (>= 0)
 * @returns {Array<{z: number, x: number, y: number, yTms: number}>}
 */
function overviewTiles(boxes, toZoom) {
  if (!Array.isArray(boxes)) return [];
  const top = Math.min(22, Math.max(0, Math.trunc(Number(toZoom) || 0)));
  const seen = new Set();
  const tiles = [];
  for (const bounds of boxes) {
    if (!Array.isArray(bounds) || bounds.length !== 4) continue;
    const [west, south, east, north] = bounds;
    for (let z = 0; z <= top; z++) {
      const n = 2 ** z;
      const x0 = Math.max(0, lonToTileX(west, z));
      const x1 = Math.min(n - 1, lonToTileX(east, z));
      // XYZ y grows southward: the north edge starts the range
      const y0 = Math.max(0, latToTileY(north, z));
      const y1 = Math.min(n - 1, latToTileY(south, z));
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = `${z}/${x}/${y}`;
          if (!seen.has(key)) {
            seen.add(key);
            tiles.push({ z, x, y, yTms: xyzToTmsY(y, z) });
          }
        }
      }
    }
  }
  return tiles.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
}

/**
 * Tiles covering a radius bubble around a single position at one zoom
 * level (JIT position recovery, SPEC Addendum 5). Clamped to the valid
 * tile grid; the swath buffer translates the physical radius into
 * tile padding at the position's latitude.
 *
 * @param {{lat: number, lon: number}} position
 * @param {number} z - Zoom level
 * @param {number} radiusNM - Bubble radius in nautical miles
 * @returns {Array<{z: number, x: number, y: number, yTms: number}>}
 */
function bubbleTiles(position, z, radiusNM) {
  const n = 2 ** z;
  const x = lonToTileX(position.lon, z);
  const y = latToTileY(position.lat, z);
  if (x < 0 || x >= n || y < 0 || y >= n) return [];
  const { nx, ny } = bufferTiles(radiusNM, position.lat, z);
  const out = [];
  for (let dx = -nx; dx <= nx; dx++) {
    const tx = x + dx;
    if (tx < 0 || tx >= n) continue;
    for (let dy = -ny; dy <= ny; dy++) {
      const ty = y + dy;
      if (ty < 0 || ty >= n) continue;
      out.push({ z, x: tx, y: ty, yTms: xyzToTmsY(ty, z) });
    }
  }
  return out;
}

/**
 * Resolves the margin tier for a zoom level.
 *
 * @param {number} z - Zoom level
 * @param {{strategicMarginNM: number, tacticalMarginNM: number, approachRadiusNM: number}} margins
 * @returns {{margin: number, approachOnly: boolean}}
 */
function corridorTier(z, margins) {
  if (z <= STRATEGIC_MAX_ZOOM) {
    return { margin: margins.strategicMarginNM, approachOnly: false };
  }
  if (z <= TACTICAL_MAX_ZOOM) {
    return { margin: margins.tacticalMarginNM, approachOnly: false };
  }
  return { margin: margins.approachRadiusNM, approachOnly: true };
}

/**
 * Builds the full corridor tile set for a route across every zoom level
 * in [minZoom, maxZoom] using the multi-tier margin strategy: strategic
 * and tactical swaths follow the whole interpolated route; the approach
 * tier only buffers the start and end coordinates. Tiles are deduped,
 * clamped to the valid tile grid, and returned with TMS rows plus the
 * metadata bounds boxes (padded by the widest configured margin,
 * split at the antimeridian when the corridor crosses it).
 *
 * @param {Array<unknown>} coordinates - `{lat, lon}` vertices (invalid
 *   entries are dropped)
 * @param {{minZoom: number, maxZoom: number, strategicMarginNM: number, tacticalMarginNM: number, approachRadiusNM: number}} options
 * @returns {{tiles: Array<{z: number, x: number, y: number, yTms: number}>, boxes: Array<[number, number, number, number]>|null}}
 */
function corridorTiles(coordinates, options) {
  const clampZoom = (v) =>
    Math.min(22, Math.max(0, Math.trunc(Number(v) || 0)));
  let minZoom = clampZoom(options.minZoom);
  let maxZoom = clampZoom(options.maxZoom);
  if (minZoom > maxZoom) [minZoom, maxZoom] = [maxZoom, minZoom];
  const positive = (v) =>
    Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0;
  const margins = {
    strategicMarginNM: positive(options.strategicMarginNM),
    tacticalMarginNM: positive(options.tacticalMarginNM),
    approachRadiusNM: positive(options.approachRadiusNM),
  };

  const valid = (coordinates || []).filter(isValidCoordinate).map((c) => ({
    lat: Number(c.lat),
    lon: Number(c.lon),
  }));
  if (valid.length === 0) return { tiles: [], boxes: null };

  const seen = new Map();
  for (let z = minZoom; z <= maxZoom; z++) {
    const { margin, approachOnly } = corridorTier(z, margins);

    let points;
    if (approachOnly) {
      // Approach rings: strictly the start and end coordinates
      points =
        valid.length === 1 ? [valid[0]] : [valid[0], valid[valid.length - 1]];
    } else {
      // Sample spacing: every margin NM. Each sample covers +/- the
      // margin in tiles, so consecutive samples are guaranteed to
      // overlap and the corridor stays connected.
      points = interpolateRoute(valid, Math.max(1, margin || 1));
    }

    const n = 2 ** z;
    for (const p of points) {
      const x = lonToTileX(p.lon, z);
      const y = latToTileY(p.lat, z);
      if (x < 0 || x >= n || y < 0 || y >= n) continue;
      const { nx, ny } = bufferTiles(margin, p.lat, z);
      for (let dx = -nx; dx <= nx; dx++) {
        const tx = x + dx;
        if (tx < 0 || tx >= n) continue;
        for (let dy = -ny; dy <= ny; dy++) {
          const ty = y + dy;
          if (ty < 0 || ty >= n) continue;
          const key = `${z}/${tx}/${ty}`;
          if (!seen.has(key)) {
            seen.set(key, { z, x: tx, y: ty, yTms: xyzToTmsY(ty, z) });
          }
        }
      }
    }
  }

  const tiles = [...seen.values()].sort(
    (a, b) => a.z - b.z || a.x - b.x || a.y - b.y,
  );
  const widestMargin = Math.max(
    margins.strategicMarginNM,
    margins.tacticalMarginNM,
    margins.approachRadiusNM,
  );
  return { tiles, boxes: boundsWithMargin(valid, widestMargin) };
}

module.exports = {
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
  MAX_BUFFER_TILES,
  STRATEGIC_MAX_ZOOM,
  TACTICAL_MAX_ZOOM,
};
