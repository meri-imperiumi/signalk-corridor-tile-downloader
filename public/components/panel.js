/**
 * Shared panel styling for the Corridor Tile Downloader components.
 *
 * Implements the "Tactical Sci-Fi" framing rules: flat geometry, 2px
 * corner brackets via pseudo-elements, faint rgba borders, theme
 * classes with ultra-faint tints, hardware-style buttons and labels.
 * Each component composes this into its own shadow root.
 *
 * @file components/panel.js
 */

/**
 * @param {string} extra - Component-specific CSS appended after the
 *   shared rules
 * @returns {string} Full shadow-root stylesheet
 */
const panelCss = (extra = "") => `
  :host { display: block; }

  /* Local theme color defaults to teal; the theme-* classes swap it
     and tint backgrounds (spec §5). */
  .sk-card {
    --theme-color: var(--color-teal);
    --theme-color-rgb: var(--color-teal-rgb);

    position: relative;
    display: block;
    height: 100%;
    background: rgba(var(--theme-color-rgb), 0.05);
    color: var(--text-main);
    padding: 1.25rem 1.5rem 1.5rem;
    border: 1px solid rgba(var(--theme-color-rgb), 0.3);
  }

  /* Corner brackets (spec §5) — 2px L-shapes on each corner. */
  .sk-card::before,
  .sk-card::after {
    content: "";
    position: absolute;
    width: 14px;
    height: 14px;
    border: 2px solid var(--theme-color);
    pointer-events: none;
  }
  .sk-card::before {
    top: -1px;
    left: -1px;
    border-right: none;
    border-bottom: none;
  }
  .sk-card::after {
    bottom: -1px;
    right: -1px;
    border-left: none;
    border-top: none;
  }

  .theme-green {
    --theme-color: var(--color-green);
    --theme-color-rgb: var(--color-green-rgb);
  }
  .theme-teal {
    --theme-color: var(--color-teal);
    --theme-color-rgb: var(--color-teal-rgb);
  }
  .theme-orange {
    --theme-color: var(--color-orange);
    --theme-color-rgb: var(--color-orange-rgb);
  }
  .theme-red {
    --theme-color: var(--color-red);
    --theme-color-rgb: var(--color-red-rgb);
  }
  .theme-offline {
    --theme-color: var(--color-grey);
    --theme-color-rgb: var(--color-grey-rgb);
  }

  /* Headers/labels: uppercase, small, bold, tracked (spec §6). */
  .label {
    font-size: 0.85rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--theme-color);
    margin: 0 0 0.9rem;
  }

  /* Data values: monospace telemetry with tabular numerals (spec §6). */
  .value {
    font-family: ui-monospace, "Fira Code", monospace;
    font-variant-numeric: tabular-nums;
    color: var(--text-main);
  }
  .muted { color: var(--text-muted); }
  .error { color: var(--color-red); }

  /* Hardware-style bracket buttons (spec §7): transparent, 1px theme
     border, inverted on hover/active, 48px touch targets. */
  button {
    appearance: none;
    -webkit-appearance: none;
    font-family: ui-monospace, "Fira Code", monospace;
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--theme-color);
    background: transparent;
    border: 1px solid var(--theme-color);
    padding: 0 1rem;
    min-height: 48px;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }
  button:hover:not(:disabled),
  button:active:not(:disabled) {
    background-color: var(--theme-color);
    color: var(--bg-base);
  }
  button:disabled {
    color: var(--color-grey);
    border-color: var(--color-grey);
    cursor: not-allowed;
    opacity: 0.7;
  }

  ${extra}
`;

export { panelCss };
