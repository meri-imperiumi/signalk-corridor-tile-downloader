/**
 * Database storage management panel (spec §8B): shows the on-disk size
 * of the MBTiles cache and offers a VACUUM trigger guarded by a
 * confirm() dialog.
 *
 * @file components/storage-panel.js
 */

import { formatSI } from "../format.js";
import { panelCss } from "./panel.js";

const API_BASE = "/plugins/signalk-corridor-tile-downloader";

class CtdStoragePanel extends HTMLElement {
	constructor() {
		super();
		const shadow = this.attachShadow({ mode: "open" });
		shadow.innerHTML = `
      <style>${panelCss(`
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          flex-wrap: wrap;
        }
        .size {
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: clamp(1.4rem, 1.2rem + 1vw, 2rem);
          font-weight: 700;
          color: var(--text-main);
          font-variant-numeric: tabular-nums;
        }
        .path {
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: 0.75rem;
          color: var(--text-muted);
          margin-top: 0.6rem;
          overflow-wrap: anywhere;
        }
        .result {
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: 0.85rem;
          color: var(--text-muted);
          margin-top: 0.9rem;
          min-height: 1.2em;
        }
        .result.error { color: var(--color-red); }
      `)}</style>
      <div class="sk-card theme-teal">
        <h2 class="label">Cache storage</h2>
        <div class="row">
          <span class="size" id="size">—</span>
          <button id="vacuum">[ Vacuum / free space ]</button>
        </div>
        <div class="path" id="path"></div>
        <div class="result" id="result"></div>
      </div>
    `;
		/** @type {HTMLElement} */
		this.sizeEl = shadow.getElementById("size");
		/** @type {HTMLElement} */
		this.pathEl = shadow.getElementById("path");
		/** @type {HTMLButtonElement} */
		this.vacuumEl = shadow.getElementById("vacuum");
		/** @type {HTMLElement} */
		this.resultEl = shadow.getElementById("result");

		this._busy = false;
		this.vacuumEl.addEventListener("click", () => this.vacuum());
	}

	/** @param {object} status */
	update(status) {
		if (!status) return;
		this._busy = status.isDownloading === true;
		this.vacuumEl.disabled = this._busy;
		this.sizeEl.textContent = formatSI(status.dbSizeBytes, "B");
		this.pathEl.textContent = status.outputPath || "";
	}

	async vacuum() {
		if (this._busy) return;
		// Guarded trigger (spec §8B)
		if (
			!window.confirm(
				"VACUUM the tile cache now? Rebuilding the database file may take a moment.",
			)
		) {
			return;
		}
		this.vacuumEl.disabled = true;
		this.showResult("Vacuuming…");
		try {
			const res = await fetch(`${API_BASE}/vacuum`, { method: "POST" });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				this.showResult(body.message || `HTTP ${res.status}`, true);
			} else {
				this.showResult("Vacuum complete");
				this.dispatchEvent(
					new CustomEvent("ctd:refresh", { bubbles: true, composed: true }),
				);
			}
		} catch (e) {
			this.showResult(`Vacuum failed: ${e.message}`, true);
		} finally {
			this.vacuumEl.disabled = this._busy;
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

customElements.define("ctd-storage-panel", CtdStoragePanel);

export { API_BASE, CtdStoragePanel };
