/**
 * Manual target coordinate panel: fetch trigger for a single lat/lon
 * target (no active route or GPX file needed). Validates input locally
 * and POSTs one coordinate to /fetch-target; the backend prepends
 * the vessel's current position so the corridor follows the great
 * circle from the vessel to the target (or buffers a bubble around
 * the target alone when no GPS fix is available).
 *
 * The magnitude inputs are `type="text"` with
 * `inputmode="decimal"` (the right mobile keypad, no `type="number"
 * quirks) paired with hemisphere toggle buttons (`N/S`, `E/W`):
 * the compact decimal and numeric keypads on iOS have NO minus key,
 * and several Android keyboards hide it even in the plain
 * numbers-and-punctuation layout, so signs are entered via the
 * toggles and never typed (spec §7 caveat).
 *
 * @file components/target-panel.js
 */

import {
  hemisphereText,
  parseTargetCoordinate,
  targetLabel,
} from "../target.js";
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
        .entry {
          display: flex;
          align-items: stretch;
          gap: 0.5rem;
        }
        .entry input {
          flex: 1;
          min-width: 0;
        }
        /* Hemisphere toggles: bracketed [ N ]/[ S ] buttons. The
           negative hemisphere gets the inverted (filled) look via
           aria-pressed, mirroring the [ ON ]/[ OFF ] toggle style. */
        button.hemi {
          min-width: 4.25rem;
          padding: 0 0.5rem;
        }
        button.hemi[aria-pressed="true"] {
          background-color: var(--theme-color);
          color: var(--bg-base);
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          min-width: 11rem;
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
            <div class="entry">
              <input id="lat" type="text" inputmode="decimal"
                     placeholder="0 … 90" autocomplete="off" />
              <button id="latHemi" class="hemi" type="button"
                      aria-pressed="false" title="Toggle N/S hemisphere">[ N ]</button>
            </div>
          </div>
          <div class="field">
            <label for="lon">Longitude</label>
            <div class="entry">
              <input id="lon" type="text" inputmode="decimal"
                     placeholder="0 … 180" autocomplete="off" />
              <button id="lonHemi" class="hemi" type="button"
                      aria-pressed="false" title="Toggle E/W hemisphere">[ E ]</button>
            </div>
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
    this.latHemiEl = shadow.getElementById("latHemi");
    /** @type {HTMLButtonElement} */
    this.lonHemiEl = shadow.getElementById("lonHemi");
    /** @type {HTMLButtonElement} */
    this.fetchEl = shadow.getElementById("fetch");
    /** @type {HTMLElement} */
    this.resultEl = shadow.getElementById("result");

    this._busy = false;
    /** Shared metered-connection override, synced by the app host. */
    this.metered = false;

    this.fetchEl.addEventListener("click", () => this.fetchTarget());
    this.latHemiEl.addEventListener("click", () =>
      this.toggleHemisphere(this.latHemiEl, "N", "S"),
    );
    this.lonHemiEl.addEventListener("click", () =>
      this.toggleHemisphere(this.lonHemiEl, "E", "W"),
    );
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
    this.latHemiEl.disabled = this._busy;
    this.lonHemiEl.disabled = this._busy;
  }

  /**
   * Flips a hemisphere toggle between its positive (N/E) and
   * negative (S/W) label.
   *
   * @param {HTMLButtonElement} btn
   * @param {string} positive
   * @param {string} negative
   */
  toggleHemisphere(btn, positive, negative) {
    const isNegative = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(isNegative));
    btn.textContent = `[ ${isNegative ? negative : positive} ]`;
  }

  /** Reads, validates, and uploads the entered coordinate. */
  async fetchTarget() {
    if (this._busy) return;
    const coord = parseTargetCoordinate(
      hemisphereText(
        this.latEl.value,
        this.latHemiEl.getAttribute("aria-pressed") === "true",
      ),
      hemisphereText(
        this.lonEl.value,
        this.lonHemiEl.getAttribute("aria-pressed") === "true",
      ),
    );
    if (!coord) {
      this.showResult(
        "Enter a valid latitude (0…90) and longitude (0…180)",
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
