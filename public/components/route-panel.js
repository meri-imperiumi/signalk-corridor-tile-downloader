/**
 * Active route trigger panel: one-click corridor fetch for Signal K's
 * active navigation route (spec §8B). Hosts the metered-connection
 * override toggle (SPEC Addendum 4) that both fetch triggers honor.
 *
 * @file components/route-panel.js
 */

import { panelCss } from "./panel.js";

const API_BASE = "/plugins/signalk-corridor-tile-downloader";

class CtdRoutePanel extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${panelCss(`
        .desc {
          margin: 0 0 1rem;
          font-size: 0.85rem;
          color: var(--text-muted);
        }
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          flex-wrap: wrap;
        }
        #route-name {
          font-family: ui-monospace, "Fira Code", monospace;
          font-variant-numeric: tabular-nums;
          font-size: 1rem;
          color: var(--text-main);
          overflow-wrap: anywhere;
        }
        .toggle {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          margin-top: 1rem;
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted);
          cursor: pointer;
          min-height: 48px;
        }
        .toggle button {
          min-width: 4.5rem;
        }
        .result {
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: 0.85rem;
          color: var(--text-muted);
          margin-top: 0.9rem;
          min-height: 1.2em;
          font-variant-numeric: tabular-nums;
        }
        .result.error { color: var(--color-red); }
      `)}</style>
      <div class="sk-card theme-teal">
        <h2 class="label">Active route corridor</h2>
        <p class="desc">
          Fetches a multi-tier tile corridor (strategic / tactical /
          approach) along the route activated in Signal K.
        </p>
        <div class="row">
          <span id="route-name">—</span>
          <button id="fetch" disabled>[ Fetch active route ]</button>
        </div>
        <label class="toggle">
          <button id="metered" aria-pressed="false">[ OFF ]</button>
          Force download on metered connection
        </label>
        <div class="result" id="result"></div>
      </div>
    `;
    /** @type {HTMLElement} */
    this.routeNameEl = shadow.getElementById("route-name");
    /** @type {HTMLButtonElement} */
    this.fetchEl = shadow.getElementById("fetch");
    /** @type {HTMLButtonElement} */
    this.meteredEl = shadow.getElementById("metered");
    /** @type {HTMLElement} */
    this.resultEl = shadow.getElementById("result");

    this._busy = true;
    this._metered = false;

    this.fetchEl.addEventListener("click", () => this.fetchActiveRoute());
    this.meteredEl.addEventListener("click", () => {
      this.metered = !this._metered;
      this.dispatchEvent(
        new CustomEvent("ctd:metered", {
          bubbles: true,
          composed: true,
          detail: { checked: this._metered },
        }),
      );
    });
  }

  /** @param {boolean} value */
  set metered(value) {
    this._metered = value === true;
    this.meteredEl.textContent = this._metered ? "[ ON ]" : "[ OFF ]";
    this.meteredEl.setAttribute("aria-pressed", String(this._metered));
  }

  get metered() {
    return this._metered;
  }

  /** @param {object} status */
  update(status) {
    if (!status) return;
    // A background recovery job must not block a user-triggered
    // passage download (the backend preempts it).
    this._busy = status.isDownloading === true && status.jobType !== "recovery";
    this.fetchEl.disabled = this._busy;
    if (status.activeRouteName) {
      this.routeNameEl.textContent = status.activeRouteName;
    }
  }

  async fetchActiveRoute() {
    if (this._busy) return;
    this.fetchEl.disabled = true;
    this.showResult("Contacting server…");
    try {
      const res = await fetch(`${API_BASE}/fetch-active-route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceOnMetered: this._metered }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.showResult(`${body.message || `HTTP ${res.status}`}`, true);
      } else {
        this.showResult(`Job started: ${body.totalTiles} tiles queued`);
        this.dispatchEvent(
          new CustomEvent("ctd:refresh", { bubbles: true, composed: true }),
        );
      }
    } catch (e) {
      this.showResult(`Fetch failed: ${e.message}`, true);
    } finally {
      this.update({ isDownloading: this._busy });
    }
  }

  /**
   * @param {string} text
   * @param {boolean} isError
   */
  showResult(text, isError = false) {
    this.resultEl.textContent = text;
    this.resultEl.className = isError ? "result error" : "result";
  }
}

customElements.define("ctd-route-panel", CtdRoutePanel);

export { API_BASE, CtdRoutePanel };
