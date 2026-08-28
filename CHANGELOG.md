# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
