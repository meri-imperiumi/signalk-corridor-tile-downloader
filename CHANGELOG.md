# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Downloads no longer fail on every tile: the default Open Waters
  Seamap provider was removed after that service migrated to
  vector-only `.pbf` tiles (its old raster PNG endpoints now answer
  404). OpenSeaMap is the default raster provider again; saved configs
  naming Open Waters Seamap migrate to OpenSeaMap automatically.
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
- Tile provider selection (SPEC Addendum 6): new `tileProvider`
  setting (`Open Waters Seamap` default, or `OpenSeaMap`) drives the
  default tile server URL — `tiles.openwaters.io/seamap` or
  `tiles.openseamap.org/seamark` — so downloads source modern
  Open Waters raster PNGs while legacy installs keep their OpenSeaMap
  source until they switch. `tileServerUrl` becomes an optional custom
  override (empty or a stored provider default follows the selection);
  the provider also sets its payload-validation profile, and `GET
  /status` and the web UI status header surface the active provider.
  The output remains a universal raster PNG MBTiles overlay
  (`format=png`, `type=overlay`) consumable by any XYZ tile client.
- Defensive media-type validation (SPEC Addendum 6): successful
  responses must carry exactly an `image/png` Content-Type
  (parameters and case tolerated). JSON or HTML bodies — providers'
  rate-limit/error responses — are dropped, logged as failures, and
  trigger the escalating backoff throttle; the tiny-placeholder
  threshold is per provider (500 bytes for OpenSeaMap, 300 for Open
  Waters).
- Test suite: tile math, tiered corridor geometry, MBTiles store
  (including concurrent-reader WAL check), downloader behavior
  (throttle, backoff, rate-limit escalation, circuit breaker,
  cancellation), plugin REST handlers, and webapp pure modules.

### Changed

- After any job lands tiles, the plugin now asks
  signalk-charts-provider-simple to rescan its charts directory — via
  the in-process `__signalk_chartsProviderRefresh` hook when the
  provider publishes it, falling back to the provider's
  `POST /plugins/signalk-charts-provider-simple/refresh` endpoint — so
  the corridor appears in Freeboard without a provider restart. Quiet
  no-op when the provider (or its refresh capability) is absent.
