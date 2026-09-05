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
 * The value must be a complete, plain decimal number: partial
 * garbage such as "1.2.3" is rejected outright instead of being
 * silently truncated by parseFloat, which would target the wrong
 * point on the chart.
 *
 * @param {string} latText
 * @param {string} lonText
 * @returns {{lat: number, lon: number}|null} Null when either value is
 *   missing, not a finite number, or out of range
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * @param {string} text
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function parseDecimal(text, min, max) {
  const raw = String(text).trim();
  if (!DECIMAL_RE.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

/**
 * @param {string} latText
 * @param {string} lonText
 * @returns {{lat: number, lon: number}|null}
 */
function parseTargetCoordinate(latText, lonText) {
  const lat = parseDecimal(latText, -90, 90);
  const lon = parseDecimal(lonText, -180, 180);
  if (lat === null || lon === null) return null;
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

/**
 * Sign prefix combining an unsigned magnitude with a hemisphere
 * toggle state (the mobile keypad never needs a minus key).
 *
 * @param {string} magnitudeText
 * @param {boolean} isNegative - Southern (lat) or western (lon)
 *   hemisphere selected
 * @returns {string} e.g. "-18.85" or "24.94"
 */
function hemisphereText(magnitudeText, isNegative) {
  return isNegative
    ? `-${String(magnitudeText).trim()}`
    : String(magnitudeText).trim();
}

export { hemisphereText, parseTargetCoordinate, targetLabel };
