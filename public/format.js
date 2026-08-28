/**
 * Shared formatting helpers for the Corridor Tile Downloader webapp.
 *
 * Values scale with ISO prefixes instead of hardcoded magnitudes and
 * times render as local ship time with no timezone suffix (spec §2).
 * Pure functions only (no DOM), so they are unit-testable in Node.
 *
 * @file format.js
 */

/**
 * Scales a numeric value with ISO prefixes and appends the unit
 * (e.g. `45120000 B` -> `45.1 MB`).
 *
 * @param {number|null} value - Value in base units
 * @param {string} [unit] - Unit symbol
 * @returns {string} Formatted string, or `—` for missing values
 */
function formatSI(value, unit = "") {
  if (value == null || Number.isNaN(value)) return "—";
  const steps = [
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  const abs = Math.abs(value);
  for (const [factor, prefix] of steps) {
    if (abs >= factor) {
      return `${trim(value / factor)} ${prefix}${unit}`;
    }
  }
  return `${trim(value)} ${unit}`.trim();
}

/**
 * Drops a trailing `.0` so scaled values read like telemetry.
 *
 * @param {number} n
 * @returns {string}
 */
function trim(n) {
  return String(Number(n.toFixed(1)));
}

/**
 * Formats a duration for an ETA readout: `42s`, `12m 34s`, `1h 05m`.
 *
 * @param {number|null} ms - Duration in milliseconds
 * @returns {string} `—` when unknown
 */
function formatEta(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/**
 * Formats a timestamp as local ship time: `YYYY-MM-DD HH:mm`, with no
 * timezone specifier and ISO-style dates (spec §2).
 *
 * @param {number|string|Date} ts - Epoch ms, ISO string, or Date
 * @returns {string}
 */
function formatLocalTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

export { formatEta, formatLocalTime, formatSI };
