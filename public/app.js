/**
 * Frontend entry point: mounts the panels, drives the /status REST
 * poll (spec §8B), reflects backend connectivity via <html
 * data-stream>, passively follows the Signal K day/night mode delta,
 * and shares the metered-connection override (Addendum 4) between the
 * two fetch triggers.
 *
 * @file app.js
 */

import { MODE_PATH, SignalKStream } from "./signalk-stream.js";
import "./components/status-header.js";
import "./components/route-panel.js";
import "./components/gpx-dropzone.js";
import "./components/target-panel.js";
import "./components/progress-monitor.js";
import "./components/storage-panel.js";

const API_BASE = "/plugins/signalk-corridor-tile-downloader";

/** /status poll interval. */
const POLL_MS = 2000;

const METERED_STORAGE_KEY = "ctd:forceOnMetered";

class CtdApp extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const header = document.createElement("ctd-status-header");
    const route = document.createElement("ctd-route-panel");
    const progress = document.createElement("corridor-progress");
    const gpx = document.createElement("ctd-gpx-dropzone");
    const target = document.createElement("ctd-target-panel");
    const storage = document.createElement("ctd-storage-panel");
    const frame = document.createElement("div");
    frame.className = "frame";
    frame.append(header, route, gpx, target, progress, storage);
    shadow.append(frameStyle(), frame);

    /** @type {import("./components/status-header.js").CtdStatusHeader} */
    this.headerEl = header;
    /** @type {import("./components/route-panel.js").CtdRoutePanel} */
    this.routeEl = route;
    /** @type {import("./components/gpx-dropzone.js").CtdGpxDropzone} */
    this.gpxEl = gpx;
    /** @type {import("./components/target-panel.js").CtdTargetPanel} */
    this.targetEl = target;
    /** @type {import("./components/progress-monitor.js").CorridorProgress} */
    this.progressEl = progress;
    /** @type {import("./components/storage-panel.js").CtdStoragePanel} */
    this.storageEl = storage;

    /** @type {object|null} Last successful /status payload */
    this._status = null;
    /** @type {boolean|null} null until the first poll resolves */
    this._online = null;
    this._pollTimer = null;
    this._polling = false;
    this._stream = null;

    this._forceOnMetered =
      globalThis.localStorage?.getItem(METERED_STORAGE_KEY) === "1";
    this.routeEl.metered = this._forceOnMetered;
    this.gpxEl.forceOnMetered = this._forceOnMetered;
    this.targetEl.metered = this._forceOnMetered;
  }

  connectedCallback() {
    // Actions from child panels request an immediate re-poll; the
    // metered toggle syncs the shared override into both triggers.
    this.addEventListener("ctd:refresh", () => this.poll());
    this.addEventListener("ctd:metered", (e) => {
      this.setForceOnMetered(e.detail?.checked === true);
    });

    this.poll();
    this.connectModeStream();
  }

  disconnectedCallback() {
    if (this._pollTimer != null) clearTimeout(this._pollTimer);
    this._pollTimer = null;
    this._stream?.close();
    this._stream = null;
  }

  /**
   * Persists and propagates the metered override.
   *
   * @param {boolean} value
   */
  setForceOnMetered(value) {
    this._forceOnMetered = value;
    this.routeEl.metered = value;
    this.gpxEl.forceOnMetered = value;
    this.targetEl.metered = value;
    try {
      globalThis.localStorage?.setItem(METERED_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // Private mode / storage disabled: the toggle still works per visit
    }
  }

  /**
   * Polls GET /status and distributes the payload (connection
   * resilience spec §2: failures surface as an offline state, polling
   * continues).
   */
  async poll() {
    if (this._polling) return;
    this._polling = true;
    let online = false;
    let status = null;
    try {
      const res = await fetch(`${API_BASE}/status`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status = await res.json();
      online = true;
    } catch {
      online = false;
    }
    this._polling = false;
    this._online = online;
    if (online) this._status = status;

    const root = document.documentElement;
    if (online) root.removeAttribute("data-stream");
    else root.setAttribute("data-stream", "offline");

    this.headerEl.update(online ? this._status : null, online);
    if (online && status) {
      this.routeEl.update(status);
      this.gpxEl.update(status);
      this.targetEl.update(status);
      this.progressEl.update(status);
      this.storageEl.update(status);
    }

    if (this._pollTimer == null && this.isConnected) {
      this._pollTimer = setTimeout(this.scheduleNext.bind(this), POLL_MS);
    }
  }

  scheduleNext() {
    this._pollTimer = null;
    this.poll();
  }

  /**
   * Passive day/night reactivity (spec §3): subscribes to the
   * environment.mode delta and mirrors it onto <html data-mode>.
   */
  connectModeStream() {
    this._stream = new SignalKStream((path, value) => {
      if (path !== MODE_PATH) return;
      const root = document.documentElement;
      if (value === "day" || value === "night") {
        root.setAttribute("data-mode", value);
      } else {
        root.removeAttribute("data-mode");
      }
    });
    this._stream.connect();
  }
}

/** Stylesheet for the app frame (desktop two-column layout, spec §4). */
function frameStyle() {
  const style = document.createElement("style");
  style.textContent = `
    :host { display: block; }
    .frame {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1.5rem;
    }
    @media (min-width: 880px) {
      .frame {
        grid-template-columns: 1fr 1fr;
      }
      .frame > ctd-status-header,
      .frame > ctd-target-panel,
      .frame > corridor-progress,
      .frame > ctd-storage-panel {
        grid-column: 1 / -1;
      }
    }
  `;
  return style;
}

customElements.define("ctd-app", CtdApp);

export { API_BASE, CtdApp, POLL_MS };
