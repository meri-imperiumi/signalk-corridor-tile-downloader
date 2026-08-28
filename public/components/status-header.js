/**
 * Status header: live badges for backend connection, job state, active
 * route and cache size, driven by the /status poll (spec §8B).
 *
 * Granular DOM updates only (spec §1): references cached in the
 * constructor, `update()` touches textContent/className exclusively.
 *
 * @file components/status-header.js
 */

import { formatSI } from "../format.js";
import { panelCss } from "./panel.js";

class CtdStatusHeader extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${panelCss(`
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
          gap: 1rem 1.5rem;
        }
        .cell .label { margin-bottom: 0.35rem; }
        .cell .value {
          display: block;
          font-size: clamp(1rem, 0.9rem + 0.6vw, 1.3rem);
          font-weight: 700;
          overflow-wrap: anywhere;
        }
      `)}</style>
      <div class="sk-card theme-teal" id="card">
        <div class="grid">
          <div class="cell">
            <span class="label">Backend</span>
            <span class="value" id="backend">—</span>
          </div>
          <div class="cell">
            <span class="label">Job</span>
            <span class="value" id="job">IDLE</span>
          </div>
          <div class="cell">
            <span class="label">Route</span>
            <span class="value" id="route">—</span>
          </div>
          <div class="cell">
            <span class="label">Cache</span>
            <span class="value" id="cache">—</span>
          </div>
        </div>
      </div>
    `;
    /** @type {HTMLElement} */
    this.cardEl = shadow.getElementById("card");
    /** @type {HTMLElement} */
    this.backendEl = shadow.getElementById("backend");
    /** @type {HTMLElement} */
    this.jobEl = shadow.getElementById("job");
    /** @type {HTMLElement} */
    this.routeEl = shadow.getElementById("route");
    /** @type {HTMLElement} */
    this.cacheEl = shadow.getElementById("cache");
  }

  /**
   * @param {object|null} status - /status payload (null when the poll
   *   failed and only the backend badge should change)
   * @param {boolean} online - Backend reachable
   */
  update(status, online) {
    this.backendEl.textContent = online ? "ONLINE" : "OFFLINE";
    if (status) {
      this.jobEl.textContent = jobLabel(status);
      this.routeEl.textContent = status.activeRouteName || "—";
      this.cacheEl.textContent = formatSI(status.dbSizeBytes, "B");
      this.cardEl.className = `sk-card ${themeFor(status, online)}`;
    } else if (!online) {
      this.jobEl.textContent = "—";
      this.cardEl.className = "sk-card theme-red";
    }
  }
}

/** Maps job state to the header badge text. */
function jobLabel(status) {
  if (status.isDownloading) {
    return status.suspended
      ? `SUSPENDED (${status.suspendReason || "?"})`
      : "DOWNLOADING";
  }
  switch (status.state) {
    case "completed":
      return status.failed > 0 ? `DONE (${status.failed} FAILED)` : "COMPLETE";
    case "cancelled":
      return "CANCELLED";
    default:
      return "IDLE";
  }
}

/** Maps job state + backend connectivity to a theme class. */
function themeFor(status, online) {
  if (!online) return "theme-red";
  if (status.suspended) return "theme-orange";
  if (status.isDownloading) return "theme-orange";
  if (status.state === "completed") return "theme-green";
  if (status.state === "cancelled") return "theme-red";
  return "theme-teal";
}

customElements.define("ctd-status-header", CtdStatusHeader);

export { CtdStatusHeader };
