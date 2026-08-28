/**
 * GPX drag-and-drop dropzone (spec §8B): parses .gpx files in the
 * browser with the native DOMParser and POSTs only the extracted
 * coordinate JSON to /fetch-target — the raw XML never leaves the
 * device.
 *
 * @file components/gpx-dropzone.js
 */

import { parseGpxText } from "../gpx.js";
import { panelCss } from "./panel.js";

const API_BASE = "/plugins/signalk-corridor-tile-downloader";

class CtdGpxDropzone extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${panelCss(`
        .dropzone {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
          min-height: 7rem;
          padding: 1rem;
          text-align: center;
          cursor: pointer;
          background: var(--bg-panel-muted);
          border: 1px dashed rgba(var(--theme-color-rgb), 0.45);
          transition: border-color 0.15s ease;
          touch-action: manipulation;
        }
        .dropzone.over,
        .dropzone:focus-visible {
          border-color: var(--theme-color);
          background: rgba(var(--theme-color-rgb), 0.08);
          outline: none;
        }
        .dropzone.disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .dz-main {
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: 1rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: var(--text-main);
        }
        .dz-sub {
          font-size: 0.75rem;
          color: var(--text-muted);
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
        <h2 class="label">GPX corridor</h2>
        <div class="dropzone" id="dz" role="button" tabindex="0"
             aria-label="Drop a GPX file or tap to browse">
          <span class="dz-main">Drop GPX here</span>
          <span class="dz-sub">or tap to browse — parsed locally, raw XML is never uploaded</span>
          <input type="file" id="file" accept=".gpx,application/gpx+xml,text/xml,application/xml" hidden />
        </div>
        <div class="result" id="result"></div>
      </div>
    `;
    /** @type {HTMLElement} */
    this.dzEl = shadow.getElementById("dz");
    /** @type {HTMLInputElement} */
    this.fileEl = shadow.getElementById("file");
    /** @type {HTMLElement} */
    this.resultEl = shadow.getElementById("result");

    this._busy = false;
    /** Set by the host from the shared metered override state. */
    this.forceOnMetered = false;

    this.dzEl.addEventListener("click", () => {
      if (!this._busy) this.fileEl.click();
    });
    this.dzEl.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !this._busy) {
        e.preventDefault();
        this.fileEl.click();
      }
    });
    this.dzEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!this._busy) this.dzEl.classList.add("over");
    });
    this.dzEl.addEventListener("dragleave", () =>
      this.dzEl.classList.remove("over"),
    );
    this.dzEl.addEventListener("drop", (e) => {
      e.preventDefault();
      this.dzEl.classList.remove("over");
      if (this._busy) return;
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) this.handleFile(files[0]);
    });
    this.fileEl.addEventListener("change", () => {
      if (this.fileEl.files && this.fileEl.files.length > 0) {
        this.handleFile(this.fileEl.files[0]);
      }
      this.fileEl.value = "";
    });
  }

  /** @param {object} status */
  update(status) {
    if (!status) return;
    this._busy = status.isDownloading === true;
    this.dzEl.classList.toggle("disabled", this._busy);
    this.dzEl.setAttribute("aria-disabled", String(this._busy));
  }

  /**
   * Parses and uploads one GPX file.
   *
   * @param {File} file
   */
  async handleFile(file) {
    if (this._busy) return;
    const isGpx =
      file.name.toLowerCase().endsWith(".gpx") || /gpx|xml/i.test(file.type);
    if (!isGpx) {
      this.showResult("Not a GPX file", true);
      return;
    }
    this.showResult(`Parsing ${file.name}…`);
    try {
      const text = await file.text();
      const { coordinates, source } = await parseGpxText(text);
      this.showResult(
        `Parsed ${coordinates.length} ${source} points — starting fetch…`,
      );
      const res = await fetch(`${API_BASE}/fetch-target`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coordinates,
          name: file.name,
          forceOnMetered: this.forceOnMetered,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.showResult(body.message || `HTTP ${res.status}`, true);
      } else {
        this.showResult(
          `${file.name}: ${body.totalTiles} tiles queued (${coordinates.length} points)`,
        );
        this.dispatchEvent(
          new CustomEvent("ctd:refresh", { bubbles: true, composed: true }),
        );
      }
    } catch (e) {
      this.showResult(e.message, true);
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

customElements.define("ctd-gpx-dropzone", CtdGpxDropzone);

export { API_BASE, CtdGpxDropzone };
