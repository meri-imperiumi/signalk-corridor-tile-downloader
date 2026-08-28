#!/usr/bin/env node
/**
 * Fetches the Open Waters Seamap styling assets and builds the locally
 * hosted offline style (vector.md §1-2):
 *
 * - extracts the seamap symbology layers (the `seamap` source) from the
 *   published whole-chart style and rewrites them into a self-contained
 *   style served from this plugin's `public/open-waters/` folder
 * - downloads the `freenauticalchart` sprite sheet (MapLibre appends
 *   `.json`/`.png`/`@2x` to the sprite base URL itself, so all four
 *   variants are stored side by side)
 * - downloads the glyph PBF ranges for the style's fontstacks
 *   ("Noto Sans Regular", "Noto Sans Italic")
 *
 * The style's tile source points at the corridor cache served by
 * signalk-charts-provider-simple (`/signalk/v1/api/resources/charts/`),
 * so a MapLibre client renders the offline corridor with full IALA
 * chart symbology, sprites and text — no internet required.
 *
 * Usage: node scripts/fetch-open-waters-assets.mjs [--out public/open-waters]
 *
 * @file scripts/fetch-open-waters-assets.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const STYLE_URL = "https://tiles.openwaters.io/seamap/style.json";
const TILES_JSON_URL = "https://tiles.openwaters.io/seamap/tiles.json";
const SPRITE_BASE_URL =
  "https://tiles.openwaters.io/seamap/sprites/freenauticalchart";
const GLYPH_BASE_URL = "https://tiles.openwaters.io/fonts";
const SPRITE_ID = "freenauticalchart";
const FONT_STACKS = ["Noto Sans Regular", "Noto Sans Italic"];

/** Static mount of this plugin inside the Signal K server. */
const PLUGIN_STATIC_BASE = "/plugins/signalk-corridor-tile-downloader";

/** Chart identifier charts-provider-simple derives from the default
 * output filename (`passage_cache.mbtiles`). */
const CHART_ID = "passage_cache";

/** The published style's source id whose layers carry the chart
 * symbology. */
const SEAMAP_SOURCE_ID = "seamap";

/** Our offline style's name for that source (vector.md §2). */
const OFFLINE_SOURCE_ID = "openwaters";

const outDir = path.resolve(
  process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : "public/open-waters",
);

const USER_AGENT = "SignalK-Corridor-Downloader/1.0 (offline chart cache)";

async function fetchWithRetry(url, { binary = true, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.json();
    } catch (err) {
      if (attempt >= retries) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function pool(items, size, worker) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

function writeFile(relPath, data) {
  const target = path.join(outDir, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return target;
}

console.log(`Open Waters offline style assets → ${outDir}`);

// ---- 1. The offline style ----------------------------------------------

console.log("Fetching the published style and TileJSON…");
const [published, tilejson] = await Promise.all([
  fetchWithRetry(STYLE_URL, { binary: false }),
  fetchWithRetry(TILES_JSON_URL, { binary: false }),
]);

const chartLayers = published.layers
  .filter((layer) => layer.source === SEAMAP_SOURCE_ID)
  // Re-point the layers at our offline source id
  .map(({ source: _publishedSource, ...layer }) => ({
    ...layer,
    source: OFFLINE_SOURCE_ID,
  }));
const backgrounds = published.layers.filter(
  (layer) => layer.type === "background",
);
if (chartLayers.length === 0) {
  throw new Error(
    `no "${SEAMAP_SOURCE_ID}" layers found in the published style`,
  );
}

const style = {
  version: 8,
  name: "Open Waters Seamap (offline)",
  id: "open-waters-seamap-offline",
  metadata: {
    attribution: tilejson.attribution,
    description: `${tilejson.description} — pre-cached corridor served by signalk-corridor-tile-downloader`,
  },
  sources: {
    [OFFLINE_SOURCE_ID]: {
      type: "vector",
      // Root-relative: resolves against the Signal K server serving
      // this style, whatever address the boat network uses
      tiles: [`/signalk/v1/api/resources/charts/${CHART_ID}/{z}/{x}/{y}`],
      minzoom: tilejson.minzoom ?? 0,
      maxzoom: tilejson.maxzoom ?? 14,
    },
  },
  sprite: [
    {
      id: SPRITE_ID,
      url: `${PLUGIN_STATIC_BASE}/open-waters/sprites/${SPRITE_ID}`,
    },
  ],
  glyphs: `${PLUGIN_STATIC_BASE}/open-waters/glyphs/{fontstack}/{range}.pbf`,
  layers: [...backgrounds, ...chartLayers],
};

const stylePath = writeFile(
  "style.json",
  `${JSON.stringify(style, null, 2)}\n`,
);
console.log(
  `  style.json: ${style.layers.length} layers (${chartLayers.length} seamap symbology) → ${stylePath}`,
);

// ---- 2. The sprite sheet ------------------------------------------------

console.log("Fetching the sprite sheet…");
for (const suffix of ["", "@2x"]) {
  for (const ext of ["json", "png"]) {
    const data = await fetchWithRetry(`${SPRITE_BASE_URL}${suffix}.${ext}`);
    if (data == null) throw new Error(`sprite ${suffix}.${ext} not found`);
    writeFile(`sprites/${SPRITE_ID}${suffix}.${ext}`, data);
  }
}
const spriteJson = JSON.parse(
  fs.readFileSync(path.join(outDir, "sprites", `${SPRITE_ID}.json`), "utf8"),
);
console.log(`  sprites/${SPRITE_ID}: ${Object.keys(spriteJson).length} icons`);

// ---- 3. The glyph fonts --------------------------------------------------

console.log("Fetching glyph ranges…");
const ranges = Array.from(
  { length: 256 },
  (_, i) => `${i * 256}-${i * 256 + 255}`,
);
let glyphBytes = 0;
let missing = 0;
for (const font of FONT_STACKS) {
  await pool(ranges, 8, async (range) => {
    const data = await fetchWithRetry(
      `${GLYPH_BASE_URL}/${encodeURIComponent(font)}/${range}.pbf`,
    );
    if (data == null) {
      missing += 1;
      console.warn(`  ! ${font} ${range}.pbf: 404`);
      return;
    }
    glyphBytes += data.length;
    writeFile(path.join("glyphs", font, `${range}.pbf`), data);
  });
  console.log(`  glyphs/${font}: 256 ranges`);
}

// ---- 4. Provenance -------------------------------------------------------

const attribution = `# Open Waters offline style assets

Generated by \`scripts/fetch-open-waters-assets.mjs\` on ${new Date().toISOString()}.

- Style: seamap symbology layers extracted from ${STYLE_URL}
  (Open Waters Seamap, © Open Waters / OpenStreetMap contributors;
  see the style's \`metadata.attribution\`)
- Sprite sheet \`${SPRITE_ID}\`: ${SPRITE_BASE_URL} (freenauticalchart,
  generated by the Open Waters seamap project from tabler/temaki icon
  sets; see https://github.com/openwatersio/seamap)
- Glyphs: ${GLYPH_BASE_URL} — Noto Sans Regular and Noto Sans Italic
  (SIL Open Font License; see https://github.com/openwatersio/tile-fonts)

These files are a cache of third-party assets for offline use. Track
upstream licensing at https://github.com/openwatersio.
`;
writeFile("ATTRIBUTION.md", attribution);

console.log(
  `Done: style + ${Object.keys(spriteJson).length} icons + ` +
    `${FONT_STACKS.length}×${ranges.length} glyph ranges ` +
    `(${(glyphBytes / 1e6).toFixed(1)} MB of glyphs${missing ? `, ${missing} missing` : ""}).`,
);
