# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- Test suite: tile math, tiered corridor geometry, MBTiles store
  (including concurrent-reader WAL check), downloader behavior
  (throttle, backoff, rate-limit escalation, circuit breaker,
  cancellation), plugin REST handlers, and webapp pure modules.
