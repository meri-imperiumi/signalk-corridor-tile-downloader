/**
 * Download progress monitor (spec §8B): custom `<corridor-progress>`
 * element rendering a native progress bar, a large percentage readout,
 * counts, throughput, ETA, a cancel action, and circuit-breaker /
 * rate-limit notices from the downloader status.
 *
 * @file components/progress-monitor.js
 */

import { formatEta } from "../format.js";
import { panelCss } from "./panel.js";

const API_BASE = "/plugins/signalk-corridor-tile-downloader";

class CorridorProgress extends HTMLElement {
	constructor() {
		super();
		const shadow = this.attachShadow({ mode: "open" });
		shadow.innerHTML = `
      <style>${panelCss(`
        .top {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 0.75rem;
          flex-wrap: wrap;
          margin-bottom: 0.75rem;
        }
        /* The payload: massive percentage readout (spec §6). */
        .pct {
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: clamp(2rem, 1.5rem + 2vw, 2.5rem);
          font-weight: 700;
          color: var(--text-main);
          font-variant-numeric: tabular-nums;
          line-height: 1.1;
        }
        .badge {
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: 0.85rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: var(--theme-color);
        }

        /* Native progress bar, styled flat and sharp (spec §5). */
        progress {
          appearance: none;
          -webkit-appearance: none;
          width: 100%;
          height: 1rem;
          border: 1px solid rgba(var(--theme-color-rgb), 0.45);
          background: var(--bg-panel-muted);
        }
        progress::-webkit-progress-bar {
          background: var(--bg-panel-muted);
        }
        progress::-webkit-progress-value {
          background: var(--theme-color);
        }
        progress::-moz-progress-bar {
          background: var(--theme-color);
        }
        progress::-moz-progress-track {
          background: var(--bg-panel-muted);
        }

        .stats {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem 1.25rem;
          margin-top: 0.75rem;
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: 0.85rem;
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        .stats .failed { color: var(--color-red); }

        .notice {
          font-family: ui-monospace, "Fira Code", monospace;
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--color-orange);
          margin-top: 0.9rem;
          min-height: 1.2em;
        }
        .notice.hidden { visibility: hidden; }

        .actions {
          display: flex;
          justify-content: flex-end;
          margin-top: 0.9rem;
        }
        .actions.hidden { display: none; }
      `)}</style>
      <div class="sk-card theme-offline" id="card">
        <h2 class="label">Download progress</h2>
        <div class="top">
          <span class="pct" id="pct">—</span>
          <span class="badge" id="badge">IDLE</span>
        </div>
        <progress id="bar" max="100" value="0"></progress>
        <div class="stats">
          <span id="counts">0 / 0 tiles</span>
          <span class="failed" id="failed">0 failed</span>
          <span id="cached">0 cached</span>
          <span id="rate"></span>
          <span id="eta">ETA —</span>
        </div>
        <div class="notice hidden" id="notice"></div>
        <div class="actions hidden" id="actions">
          <button id="cancel">[ Cancel job ]</button>
        </div>
      </div>
    `;
		/** @type {HTMLElement} */
		this.cardEl = shadow.getElementById("card");
		/** @type {HTMLElement} */
		this.pctEl = shadow.getElementById("pct");
		/** @type {HTMLElement} */
		this.badgeEl = shadow.getElementById("badge");
		/** @type {HTMLProgressElement} */
		this.barEl = shadow.getElementById("bar");
		/** @type {HTMLElement} */
		this.countsEl = shadow.getElementById("counts");
		/** @type {HTMLElement} */
		this.failedEl = shadow.getElementById("failed");
		/** @type {HTMLElement} */
		this.cachedEl = shadow.getElementById("cached");
		/** @type {HTMLElement} */
		this.rateEl = shadow.getElementById("rate");
		/** @type {HTMLElement} */
		this.etaEl = shadow.getElementById("eta");
		/** @type {HTMLElement} */
		this.noticeEl = shadow.getElementById("notice");
		/** @type {HTMLElement} */
		this.actionsEl = shadow.getElementById("actions");
		/** @type {HTMLButtonElement} */
		this.cancelEl = shadow.getElementById("cancel");

		this.cancelEl.addEventListener("click", () => this.cancelJob());
	}

	/** @param {object} status */
	update(status) {
		if (!status) return;
		const total = status.totalQueued || 0;
		const done =
			(status.completed || 0) + (status.skipped || 0) + (status.failed || 0);
		const pct =
			total > 0 ? (done / total) * 100 : status.state === "completed" ? 100 : 0;

		this.pctEl.textContent =
			total > 0 ? `${pct.toFixed(1)}%` : status.state === "idle" ? "—" : "0.0%";
		this.barEl.value = pct;

		this.badgeEl.textContent = badgeFor(status);
		this.countsEl.textContent = `${done} / ${total} tiles`;
		this.failedEl.textContent = `${status.failed || 0} failed`;
		this.cachedEl.textContent = `${status.skipped || 0} cached`;
		this.rateEl.textContent =
			status.rate > 0 ? `${(status.rate * 60).toFixed(1)} tiles/min` : "";
		this.etaEl.textContent = status.isDownloading
			? `ETA ${formatEta(status.etaMs)}`
			: "";

		// Circuit breaker / rate-limit notices (Addendums 2-3)
		let notice = "";
		if (status.suspended) {
			notice = `Suspended — ${status.suspendReason || "no"} link · resuming automatically`;
		} else if (status.isDownloading && status.throttleMs > 5000) {
			notice = `Server throttle: ${Math.round(status.throttleMs / 1000)}s between requests`;
		}
		this.noticeEl.textContent = notice;
		this.noticeEl.classList.toggle("hidden", notice === "");

		this.actionsEl.classList.toggle("hidden", !status.isDownloading);
		this.cardEl.className = `sk-card ${themeFor(status)}`;
	}

	async cancelJob() {
		this.cancelEl.disabled = true;
		try {
			await fetch(`${API_BASE}/cancel`, { method: "POST" });
			this.dispatchEvent(
				new CustomEvent("ctd:refresh", { bubbles: true, composed: true }),
			);
		} catch {
			// The next poll reflects reality either way
		} finally {
			this.cancelEl.disabled = false;
		}
	}
}

/** Maps status to the state badge text. */
function badgeFor(status) {
	if (status.isDownloading) {
		return status.suspended ? "SUSPENDED" : "DOWNLOADING";
	}
	switch (status.state) {
		case "completed":
			return status.failed > 0 ? "COMPLETE · ERRORS" : "COMPLETE";
		case "cancelled":
			return "CANCELLED";
		default:
			return "IDLE";
	}
}

/** Maps status to a theme class. */
function themeFor(status) {
	if (status.isDownloading) return "theme-orange";
	if (status.state === "completed") return "theme-green";
	if (status.state === "cancelled") return "theme-red";
	return "theme-offline";
}

customElements.define("corridor-progress", CorridorProgress);

export { CorridorProgress };
