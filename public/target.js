/**
 * Shared parsing/validation for manually entered target coordinates
 * (the fetch trigger used when there is no active route or GPX file).
 *
 * Pure functions only: this module is imported both by the UI component
 * and the Node test suite.
 *
 * @file target.js
 */

/**
 * Parses a lat/lon pair from text input into a validated coordinate.
 *
 * @param {string} latText
 * @param {string} lonText
 * @returns {{lat: number, lon: number}|null} Null when either value is
 *   missing, not a finite number, or out of range
 */
function parseTargetCoordinate(latText, lonText) {
  const lat = Number.parseFloat(String(latText).trim());
  const lon = Number.parseFloat(String(lonText).trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * Human-readable label for a manual target, shown as the job's route
 * name in the status header.
 *
 * @param {{lat: number, lon: number}} coord
 * @returns {string} e.g. "Target 60.1700, 24.9400"
 */
function targetLabel(coord) {
  return `Target ${coord.lat.toFixed(4)}, ${coord.lon.toFixed(4)}`;
}

export { parseTargetCoordinate, targetLabel };
