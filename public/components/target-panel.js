/**
 * Manual target coordinate panel: fetch trigger for a single lat/lon
 * target (no active route or GPX file needed). Validates input locally
 * and POSTs one coordinate to /fetch-target; the backend prepends
 * the vessel's current position so the corridor follows the great
 * circle from the vessel to the target (or buffers a bubble around
 * the target alone when no GPS fix is available).
 *
 * @file components/target-panel.js
 */

import { parseTargetCoordinate, targetLabel } from "../target.js";
import { panelCss } from "./panel.js";

const API_BASE = "/plugins/signalk-corridor-tile-downloader";

class CtdTargetPanel extends HTMLElement {
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
          align-items: stretch;
          justify-content: flex-start;
          gap: 0.75rem;
          flex-wrap: wrap;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          min-width: 9rem;
          flex: 1;
        }
        .field label {
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: var(--text-muted);
        }
        .field input {
          appearance: none;
          -webkit-appearance: none;
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: 1rem;
          font-variant-numeric: tabular-nums;
          color: var(--text-main);
          background: var(--bg-panel-muted);
          border: 1px solid rgba(var(--theme-color-rgb), 0.45);
          min-height: 48px;
          padding: 0 0.75rem;
        }
        .field input:focus-visible {
          outline: none;
          border-color: var(--theme-color);
        }
        .field input:disabled {
          color: var(--color-grey);
          border-color: var(--color-grey);
          cursor: not-allowed;
          opacity: 0.7;
        }
        .row > button {
          align-self: flex-end;
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
        <h2 class="label">Target coordinate corridor</h2>
        <p class="desc">
          Fetches the great-circle corridor from the vessel's current
          position to a target point — no active route or GPX file
          needed.
        </p>
        <div class="row">
          <div class="field">
            <label for="lat">Latitude</label>
            <input id="lat" type="number" step="any" min="-90" max="90"
                   placeholder="-90 … 90" inputmode="decimal" autocomplete="off" />
          </div>
          <div class="field">
            <label for="lon">Longitude</label>
            <input id="lon" type="number" step="any" min="-180" max="180"
                   placeholder="-180 … 180" inputmode="decimal" autocomplete="off" />
          </div>
          <button id="fetch">[ Fetch target ]</button>
        </div>
        <div class="result" id="result"></div>
      </div>
    `;
    /** @type {HTMLInputElement} */
    this.latEl = shadow.getElementById("lat");
    /** @type {HTMLInputElement} */
    this.lonEl = shadow.getElementById("lon");
    /** @type {HTMLButtonElement} */
    this.fetchEl = shadow.getElementById("fetch");
    /** @type {HTMLElement} */
    this.resultEl = shadow.getElementById("result");

    this._busy = false;
    /** Shared metered-connection override, synced by the app host. */
    this.metered = false;

    this.fetchEl.addEventListener("click", () => this.fetchTarget());
    this.latEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.fetchTarget();
    });
    this.lonEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.fetchTarget();
    });
  }

  /** @param {object} status */
  update(status) {
    if (!status) return;
    // A background recovery job must not block a user-triggered
    // target download (the backend preempts it).
    this._busy = status.isDownloading === true && status.jobType !== "recovery";
    this.fetchEl.disabled = this._busy;
    this.latEl.disabled = this._busy;
    this.lonEl.disabled = this._busy;
  }

  /** Reads, validates, and uploads the entered coordinate. */
  async fetchTarget() {
    if (this._busy) return;
    const coord = parseTargetCoordinate(this.latEl.value, this.lonEl.value);
    if (!coord) {
      this.showResult(
        "Enter a valid latitude (-90…90) and longitude (-180…180)",
        true,
      );
      return;
    }
    this.fetchEl.disabled = true;
    this.showResult(`Contacting server for ${targetLabel(coord)}…`);
    try {
      const res = await fetch(`${API_BASE}/fetch-target`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coordinates: [coord],
          name: targetLabel(coord),
          forceOnMetered: this.metered,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.showResult(body.message || `HTTP ${res.status}`, true);
      } else {
        this.showResult(`Job started: ${body.totalTiles} tiles queued`);
        this.dispatchEvent(
          new CustomEvent("ctd:refresh", { bubbles: true, composed: true }),
        );
      }
    } catch (e) {
      this.showResult(`Fetch failed: ${e.message}`, true);
    } finally {
      this.fetchEl.disabled = this._busy;
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

customElements.define("ctd-target-panel", CtdTargetPanel);

export { API_BASE, CtdTargetPanel };
