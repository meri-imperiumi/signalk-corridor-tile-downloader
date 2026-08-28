/**
 * Browser-side GPX parsing (spec §8B: raw XML is never uploaded).
 *
 * `coordinatesFromDocument` is DOM-library agnostic (it only needs
 * `getElementsByTagName`/`getAttribute`), so it is unit-testable in
 * Node with document stubs; `parseGpxText` wires it to the native
 * DOMParser in the browser.
 *
 * Trackpoints win over route points, which win over waypoints: a
 * recorded track follows the vessel's actual line, a route defines the
 * planned line, and bare waypoints are a last resort.
 *
 * @file gpx.js
 */

/** GPX point elements in priority order. */
const POINT_TAGS = ["trkpt", "rtept", "wpt"];

/**
 * Extracts valid `{lat, lon}` coordinates from a parsed GPX document.
 *
 * @param {{getElementsByTagName: (tag: string) => ArrayLike<{getAttribute: (name: string) => string|null}>}} doc
 * @returns {{coordinates: Array<{lat: number, lon: number}>, source: string|null}}
 */
function coordinatesFromDocument(doc) {
  for (const tag of POINT_TAGS) {
    const points = doc.getElementsByTagName(tag);
    if (!points || points.length === 0) continue;
    const coordinates = [];
    for (const p of points) {
      const lat = Number(p.getAttribute("lat"));
      const lon = Number(p.getAttribute("lon"));
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180
      ) {
        coordinates.push({ lat, lon });
      }
    }
    if (coordinates.length > 0) {
      return { coordinates, source: tag };
    }
  }
  return { coordinates: [], source: null };
}

/**
 * Parses GPX XML text using the native DOMParser.
 *
 * @param {string} text - Raw .gpx file contents
 * @returns {Promise<{coordinates: Array<{lat: number, lon: number}>, source: string|null}>}
 * @throws When the XML is malformed or contains no usable points
 */
async function parseGpxText(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Invalid GPX: XML parse error");
  }
  const result = coordinatesFromDocument(doc);
  if (result.coordinates.length === 0) {
    throw new Error(
      "Invalid GPX: no trackpoints, route points or waypoints found",
    );
  }
  return result;
}

export { coordinatesFromDocument, POINT_TAGS, parseGpxText };
