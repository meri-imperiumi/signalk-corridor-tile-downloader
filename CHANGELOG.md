# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Corridor bounds are now antimeridian-aware, so westbound (or
  eastbound) passages crossing 180° longitude download correctly.
  Previously `boundsWithMargin` took the naive min/max of longitude,
  spanning the long way around the world for a dateline-crossing route:
  the low-zoom overview pyramid then fetched near-worldwide tiles at the
  corridor's latitudes (a ~25x blowup for a Samoa–Fiji sized passage)
  while its rows still missed the corridor's own tiles right at the
  seam — zooming out below the minimum zoom blanked the chart exactly
  where the passage crosses 180°. Route longitudes are now unwrapped to
  a contiguous span (each vertex shifted ±360° to stay within 180° of
  its predecessor, matching the great-circle engine's short-way
  choice), and a span crossing the seam is split into two valid bounds
  boxes that drive the overview pyramid on both sides. The MBTiles
  `bounds` metadata row keeps a single box (the format cannot express
  wrapping): for seam-crossing corridors it collapses to the
  full-width box so clipping consumers never blank cached tiles on
  either side. `boundsWithMargin` now returns an array of boxes,
  `overviewTiles` takes that array, and `corridorTiles` returns them
  under `boxes` (was `bounds`).

- `transformStyle` strips the upstream chart author's demo camera
  (`center`/`zoom`/`bearing`/`pitch`) from the mirrored styles
  (`/assets/style.json` and `/assets/style-ol.json`). That camera points
  at the author's showcase location (the Danish Baltic), not the
  corridor this offline mirror covers, so it's wrong for every
  consumer — and MapLibre applies it on style load, before a
  consumer's own `fitBounds` runs, firing a high-zoom tile pyramid
  across every source over a location the cache doesn't hold: a
  barrage of 404s, and on a fresh mount before the consumer's track
  resolves, a long stall on an uncached area. Leaflet-based consumers
  (the dead-reckoning webapp) dodge this only because they set the
  viewport themselves and never read the style's camera. The
  per-source `bounds` advertised in 0.3.0 were meant to stop this, but
  the low-zoom overview pyramid added in the same release inflates
  `extentFromTilesFile` to world bounds, so the camera remained the
  effective default view — stripping it closes the gap. Without a
  style camera, MapLibre starts at a neutral world view that the
  consumer re-fits from.

## [0.3.0] - 2026-08-28

### Added

- Low-zoom overview pyramid: every corridor job additionally fetches
  all tiles from z0 up to one below the effective per-source minimum
  over the corridor's bounding rectangle (a bounded few hundred tiles
  per source at most). Without it, zooming out below the cached
  minimum blanked the chart in every client — overzoom only reuses
  ancestors, and none exist below the lowest cached zoom. The pyramid
  rides the same queue/priority/throttle machinery (corridor tiles
  first, overview after per source), is journaled implicitly (it
  derives from the journaled bounds + minZoom, so resumes rebuild it),
  and re-runs skip whatever the stores already hold.

- True cache extents everywhere: coverage is now derived from the
  tiles tables (`MbTilesStore.extentFromTiles()` and a read-only
  `extentFromTilesFile()` probe) instead of trusting the `bounds`
  metadata row. That row only ever described the LATEST job's corridor
  while tiles accumulate across jobs — after a smaller follow-up
  corridor the advertised bounds shrank below the data on disk, and
  Freeboard SK (which clips chart rendering to the resource bounds)
  blanked every tile of previous corridors still in the cache. Now:
  job-start metadata writes the union of existing rows + tiles on disk
  + the new corridor, the advertised `openwaters-corridor` chart
  resource derives its bounds/zooms from the tiles (repairing caches
  written by older versions without a re-run), and every source in the
  rewritten styles (`style.json` and `style-ol.json`) carries its true
  `bounds` and `maxzoom` (but NOT `minzoom`: below the cached minimum
  no tiles exist and none can be synthesized — overzoom only goes up
  from an ancestor — so a minzoom merely hides the layer around that
  boundary in both MapLibre and ol-mapbox-style). The source bounds
  also stop the 404 storm: without them clients requested tiles
  viewport-wide and every tile outside the corridor 404'd (raster DEM
  stores get none of the pbf-style overzoom synthesis the provider
  applies to missing vector tiles); with them, OpenLayers and MapLibre
  constrain requests to covered tiles and overzoom cached parents
  beyond `maxzoom`.

- `GET /assets/style-ol.json`: an OpenLayers-compatible variant of the
  mirrored Open Waters style for Freeboard SK (ol-mapbox-style). Same
  URL rewriting as `/assets/style.json`, minus layers OL cannot render:
  MapLibre's `color-relief` depth shading (upstream the FIRST layer of
  the `seascape-dem` source) matches no ol-mapbox-style branch and
  makes `apply()` reject — blanking the ENTIRE chart, not just the one
  layer — and `heatmap` renders nothing. Sources left without any
  layer after the filter are pruned so clients never fetch undrawable
  tiles. `icon-image` fallback chains have their MapLibre `image`
  expressions unwrapped to the inner name expression: ol-mapbox-style
  has no `image` operator and fails the whole expression parse, so
  the `lights`, `buoys` and `topmarks` layers styled every feature to
  nothing (labels — separate layers — still rendered, hiding the
  failure). MapLibre's `icon-overlap: "always"` (15 layers, the
  safety symbology) is mapped to the `icon-allow-overlap` spelling
  ol-mapbox-style reads, so lights and rocks are not decluttered
  away. The manifest gained a matching `styleOl` URL beside `style`;
  the MapLibre style stays verbatim.
- Signal K charts resource provider: the plugin now registers as a
  read-only `charts` resource provider advertising a single
  `mapstyleJSON` chart (`openwaters-corridor`) whose URL is the OL
  style variant, with bounds and zooms aggregated from every cached
  store. Freeboard SK discovers and renders the offline corridor
  styled with zero manual setup — the server merges listings from
  multiple chart providers, so the six per-file charts of
  signalk-charts-provider-simple keep working alongside. A
  `resources.charts.openwaters-corridor` delta (Signal K v2) is
  emitted whenever the entry appears, changes, or disappears, so
  connected clients update without polling. Writes and deletes are
  rejected: the entry is derived from mirror state. No provider is
  registered for non-mirror (OpenSeaMap/custom) configs or servers
  without resource-provider support.

## [0.2.0] - 2026-08-28

### Fixed

- A single target coordinate now plots the great-circle corridor from
  the vessel's current `navigation.position` to the target, instead of
  buffering a bubble around the target alone. The one-point corridor
  covered only the destination, leaving the whole passage uncached — a
  600 NM route produced a few hundred tiles around the arrival point
  and nothing along the track. Without a GPS fix the target alone is
  still buffered (the documented fallback) so the target panel works
  before a position is published.

## [0.1.0] - 2026-08-28

### Fixed

- versatiles-shortbread and elevation now download: tiles.versatiles.org
  returns `Content-Type: vnd.mapbox-vector-tile` for its pbf tiles —
  the `application/` tree prefix is missing. The validator rejected
  every such tile as a wrong-Content-Type rate limit and escalated a
  5-minute penalty on the host, which blocked the sibling elevation
  source too (same host). Media types are now normalized: a bare token
  without a slash is treated as the `application/` vendor subtype it
  was meant to be, so `vnd.mapbox-vector-tile` is accepted as
  `application/vnd.mapbox-vector-tile`.
- Resume no longer hangs the server: when an in-flight download is
  resumed at startup and the next tile fetch triggers a per-host
  rate-limit penalty (429/503, or a wrong Content-Type such as an
  `image/png` body for a pbf source), every remaining tile on that host
  is deferred and the download loop parks in its penalty-wait branch
  — `await sleepFn(wait, () => cancelled || wakeRequested); continue;`.
  `defaultSleep` resolved as a *microtask* whenever its `isCancelled`
  gate was true, and `wakeRequested` — set by `wake()` (a
  `network.internet.state` delta) or `enqueueRecovery` (the vessel
  moving more than 1 NM) and only ever cleared inside `waitSuspend` —
  stayed set, so that loop spun without yielding: the event loop
  starved, no HTTP was served, no timers fired, and the server hung
  for as long as the penalty lasted (and, once woken again, forever).
  The penalty-wait branch now drains `wakeRequested` before sleeping
  (mirroring `waitSuspend`), and `defaultSleep` resolves on the next
  macrotask tick rather than as a microtask when already cancelled, so
  no `await sleep; continue;` loop can ever starve the event loop.
- Self-healing MBTiles store: signalk-charts-provider-simple's startup
  housekeeping deletes live `*.mbtiles-wal` sidecars, wedging the
  shared wal-index (`-shm`) and failing every read-only open — tile
  serving and its chart-metadata endpoint — with SQLite `disk I/O
  error` (SQLITE_IOERR 522, e.g. opening `meta` for
  `passage_cache.mbtiles`) for as long as the downloader kept its
  store open. The store now detects the interference on the download
  loop's per-tile touchpoints — the sidecar vanished, or was recreated
  empty by a failed reader and carries a different inode — and
  rebuilds its handle: a checkpoint first lands the unlinked WAL's
  committed tiles in the main database (nothing is refetched), then a
  fresh, consistent sidecar pair is created for readers. Statement
  failures from the SQLITE_IOERR family are retried once on the healed
  handle, and `plugin.start()` sweeps stale sidecars left around the
  cache so the provider's next housekeeping pass finds nothing to
  delete.
### Added

- Six-source Open Waters bathymetry mirror (the `BATHYMETRY.md`
  blueprint): an Open Waters job now downloads all six chart tile
  sources — seamap (pbf, z0-14), seascape-vector (pbf, z0-15),
  seascape-coverage (pbf, z0-8), versatiles-shortbread (pbf, z0-14),
  elevation (webp, z0-12) and seascape-dem (webp, z0-18) — into
  separate side-by-side MBTiles files derived from the configured
  `outputPath` (suffix inserted before `.mbtiles`). Each source is
  clamped to its own zoom ceiling at corridor-build time, fetched
  through one shared throttle/worker/recovery loop, and routed to
  its own store with per-store metadata (name, format, attribution,
  vector layers). A 404 on any single tile is a per-tile skip, never a
  job failure. `MAX_QUEUE_SIZE` raised to 2,000,000 for the combined
  six-source corridor volume. The web UI progress monitor shows
  per-source counts; `GET /status` reports `bySource`, per-store
  `outputPaths` and `dbSizeBytes`.
- Runtime chart-style mirror: every Open Waters job fetches the
  published `style.json` verbatim and mirrors its sprite sheets
  (discovered from the style's `sprite` array form) and font glyph
  ranges (256 PBFs per stack, discovered from layer `text-font`
  unions) into the plugin data dir under `mirror/`. Sprite `@2x`
  variants and missing font ranges are optional (404 = skip, never
  blocking). Asset fetching rides the same throttle/suspension/retry
  machinery as tiles and runs concurrently with the tile download —
  never blocking it (a shared inter-request gate ensures the global
  request rate never exceeds the configured `throttleMs`). The plugin serves URL-rewritten assets for offline
  MapLibre rendering: `GET /assets/manifest.json`, `GET
  /assets/style.json` (sources with cached tiles rewritten to local
  `/signalk/v1/api/resources/charts/<source>/` URLs, uncached sources
  and their layers dropped, glyphs/sprites rewritten to plugin asset
  routes), `GET /assets/sprites/:file`, and `GET
  /assets/fonts/:fontstack/:range` (with path-traversal and
  unknown-id guards). `GET /status` reports an `assets` state —
  `none` (never attempted), `fetching`, `ready`, `partial`, or
  `failed` — derived from disk.
- Journal v2: the pending-job journal now persists a `sources` array
  of `{id, path, maxZoom}` so a restart resumes all six sources with
  their per-source zoom caps. v1 journals resume seamap-only
  (untouched, no silent migration).
- Open Waters vector map support (the `vector.md` blueprint): the
  `Open Waters Seamap` tile provider is back — and now the default —
  sourcing Mapbox Vector Tiles from
  `tiles.openwaters.io/seamap/{z}/{x}/{y}.pbf` (native zooms 0-14,
  clamped automatically). Vector bodies are validated as protobuf
  messages, stored gzip-compressed (the MBTiles vector convention),
  and a legitimately empty tile — the service answers HTTP 204 over
  open ocean — is cached as a gzipped empty MVT so corridor re-runs
  and JIT recovery checks do not refetch it. An HTTP 204 stays a
  failure on the raster profile.
- `format` and `vector_layers` MBTiles metadata: a vector corridor
  writes `format=pbf` plus the seamap source-layer ids (from the
  provider's TileJSON) at job start, so signalk-charts-provider-simple
  serves tiles as `application/x-protobuf` (with `Content-Encoding:
  gzip` for the compressed blobs) and advertises the layer ids as
  `chartLayers` for MapLibre clients. The `format` row is only seeded
  on fresh files — reopening a pbf cache no longer resets it to png.
- Format guard: one cache file carries one tile format. Starting a
  vector download against a filled png cache (or vice versa) is
  rejected with HTTP 409 and a message pointing at a separate output
  path; an empty file adopts the active provider's format freely.
- Offline style assets under `public/open-waters/`, fetched by the new
  `scripts/fetch-open-waters-assets.mjs`: a self-contained
  `style.json` (the seamap chart symbology layers extracted from the
  published Open Waters style, re-pointed at the locally served
  corridor cache via `/signalk/v1/api/resources/charts/`), the
  `freenauticalchart` sprite sheet (all four variants) and the Noto
  Sans Regular/Italic glyph PBF ranges. All URLs are root-relative so
  the assets work at whatever address the boat network uses for the
  Signal K server — point MapLibre at
  `/plugins/signalk-corridor-tile-downloader/open-waters/style.json`.
- `GET /status` now reports the active `format` (`pbf`/`png`), and the
  web UI status header shows the provider with a `vector`/`raster`
  suffix.

### Fixed

- Empty-ocean overlay tiles are no longer rejected as rate-limit
  placeholders: fully transparent OpenSeaMap ocean tiles measure ~334
  bytes, below the old 500-byte floor. Tile bodies are now validated
  by PNG signature (plus a 45-byte structural minimum) instead of a
  size threshold, so tiny transparent sea tiles succeed while
  mislabeled JSON/HTML bodies still fail.
- Desktop two-column layout: panels no longer overlap vertically. The
  `border-box` reset could not pierce the shadow DOM, so every card
  rendered 46px taller than its grid row and collided with the row
  below; the reset now ships inside each shadow root.

### Added

- Restart-safe downloads: passage corridor jobs (active route, GPX,
  custom target) are journaled to the plugin data directory and
  resumed automatically after a server restart or plugin reload. The
  journal stores the job intent (coordinates, route name, metered
  override, zoom/margin snapshot); on resume the corridor is rebuilt
  from that snapshot and filtered against the MBTiles cache, so only
  tiles the interrupted job still lacked are fetched. Cancelling a
  job retires its journal, while a job interrupted by shutdown —
  including one parked in the connectivity circuit breaker — resumes
  under the same policies. `GET /status` exposes `resumable`, and the
  web UI marks journaled jobs as restart-safe.
- Manual target coordinate trigger: a new "Target coordinate corridor"
  panel fetches the multi-tier corridor around a single lat/lon point
  when there is no active route or GPX file. Input is validated
  client-side and honors the shared metered-connection override.
- Initial implementation of the Corridor Tile Downloader: a native,
  zero-dependency Signal K plugin that pre-caches marine tile corridors
  into a standard MBTiles file for offline navigation via
  `signalk-charts-provider-simple`.
- Multi-tier zoom margins (SPEC Addendum 1): a 50 NM strategic swath
  for zooms 8-10, a 15 NM tactical swath for zooms 11-13, and 3 NM
  approach rings around the route's start and end for zooms 14+ — all
  configurable as `strategicMarginNM`, `tacticalMarginNM` and
  `approachRadiusNM`.
- MBTiles store on `node:sqlite` (`DatabaseSync`) with WAL journaling,
  atomic `INSERT OR IGNORE` upserts, existence checks, VACUUM reclaim,
  and live `bounds`/`minzoom`/`maxzoom` metadata handoff to the
  consumer plugin.
- Background download queue with request throttling, retry with
  exponential backoff on transient failures, undersized-body
  placeholder rejection (< 500 bytes), and rate-limit throttle
  escalation (429/503 instantly raises the inter-request delay to 5
  minutes, doubling up to 30 minutes, resetting on success) (SPEC
  Addendum 2).
- Network circuit breaker (SPEC Addendum 3): the fetch loop monitors
  `network.internet.state` (published by signalk-internet) and
  suspends — polling every 10 s — while the vessel is offline or on a
  metered link, resuming automatically. A per-job "Force download on
  metered connection" override (SPEC Addendum 4) is exposed in the web
  UI and the REST API.
- Just-in-time position recovery cache (SPEC Addendum 5): the plugin
  subscribes to `navigation.position` and, once the vessel moves more
  than 1 NM (Haversine) from the last checked position, verifies a
  safety bubble (5 NM for zooms 8-12, 2 NM for zooms 13-14, clipped to
  the configured zoom range) against the cache. Missing tiles are
  queued into a high-priority recovery queue that the downloader
  always drains before remaining passage tiles; recovery jobs respect
  the new `allowRecoveryOnMetered` setting (default true), wake
  immediately on `network.internet.state` transitions, and never block
  a user-triggered passage download (they are preempted, carrying
  their pending tiles over as priority work).
- Verified interop with signalk-charts-provider-simple: TMS row
  orientation, the loader's `bounds` metadata gate, PNG serving, and
  stable chart identifier (`passage_cache`) all match its reader, and
  an interop test suite replays the provider's loader, tile reader and
  housekeeping logic against files this plugin produces.
- Hardened the producer/consumer file contract against the provider's
  startup housekeeping (which deletes bounds-less `.mbtiles` files and
  unlinks `*.mbtiles-wal` sidecars): the tile store now opens lazily on
  first fetch and is released when a job settles, an empty cache seeds
  a placeholder `bounds` row so it always loads as a chart, and
  `setMetadata` uses DELETE+INSERT (the metadata table has no UNIQUE
  constraint on `name`, so `INSERT OR REPLACE` was silently appending
  duplicate rows across restarts).
- REST API under `/plugins/signalk-corridor-tile-downloader/`:
  `GET /status`, `POST /fetch-active-route`, `POST /fetch-target`,
  `POST /cancel`, `POST /vacuum`.
- Web UI: status header, active-route trigger, browser-side GPX
  drag-and-drop (raw XML never uploaded), `<corridor-progress>`
  monitor with ETA and cancel, and a storage panel with guarded VACUUM
  — styled per the Signal K "Tactical Sci-Fi" spec with passive
  day/night mode reactivity.
- Tile provider selection (SPEC Addendum 6): the `tileProvider`
  setting drives the default tile server URL, its payload-validation
  profile and its tile format, while `tileServerUrl` becomes an
  optional custom override (empty or a stored provider default —
  current or retired — follows the selection). `GET /status` and the
  web UI status header surface the active provider.
- Defensive media-type validation (SPEC Addendum 6): successful
  responses must carry one of the active format profile's exact
  Content-Types (parameters and case tolerated). JSON or HTML bodies
  — providers' rate-limit/error responses — are dropped, logged as
  failures, and trigger the escalating backoff throttle.
- Test suite: tile math, tiered corridor geometry, MBTiles store
  (including concurrent-reader WAL check), downloader behavior
  (throttle, backoff, rate-limit escalation, circuit breaker,
  cancellation), plugin REST handlers, webapp pure modules, and the
  committed Open Waters style assets.

### Changed

- After any job lands tiles, the plugin now asks
  signalk-charts-provider-simple to rescan its charts directory — via
  the in-process `__signalk_chartsProviderRefresh` hook when the
  provider publishes it, falling back to the provider's
  `POST /plugins/signalk-charts-provider-simple/refresh` endpoint — so
  the corridor appears in Freeboard without a provider restart. Quiet
  no-op when the provider (or its refresh capability) is absent.
