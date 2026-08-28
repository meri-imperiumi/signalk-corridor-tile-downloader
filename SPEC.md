# signalk-corridor-tile-downloader
A native, zero-dependency Signal K server plugin and Web UI for pre-caching marine tile corridors (OpenStreetMap / OpenSeaMap) into standard MBTiles format for offline navigation.
1. System Overview & Philosophy
 * License Compatibility: MIT or EUPL-1.2 compatible.
 * Target Environment: Node.js \ge 22.5.0 (utilizing native node:sqlite and native fetch), running directly inside the Signal K server process.
 * Zero External Dependencies: No container runtimes, no external C-binaries (GDAL/Tippecanoe), and no npm native compile steps.
 * Output Standard: SQLite .mbtiles specification (TMS tile scheme).
2. Directory & Module Structure
signalk-corridor-tile-downloader/
├── package.json               # Signal K plugin metadata & keyword declarations
├── index.js                   # Plugin entry point, lifecycle hooks, Signal K API hooks
├── lib/
│   ├── geometry.js            # Interpolation, tile coordinate math, margin buffer logic
│   ├── mbtiles.js             # SQLite schema, read/write/vacuum routines using node:sqlite
│   └── downloader.js          # Async background queue, throttling, rate limiting
└── public/                    # Static frontend web application
    ├── index.html             # UI frame
    ├── app.js                 # Vanilla Web Components & REST polling logic
    └── style.css              # Dark-mode, high-contrast maritime styling

3. Configuration & Schema Specification
The plugin must expose the following JSON Schema to the Signal K Admin UI:
| Parameter Key | Data Type | Default Value | Description |
|---|---|---|---|
| outputPath | string | ~/.signalk/charts-simple/passage_cache.mbtiles | Absolute path to target .mbtiles file |
| marginNM | number | 10 | Corridor buffer radius (Nautical Miles) on either side of track |
| minZoom | number | 8 | Minimum zoom level to fetch |
| maxZoom | number | 14 | Maximum zoom level to fetch |
| throttleMs | number | 500 | Delay between HTTP requests (milliseconds) |
| tileServerUrl | string | [https://tiles.openseamap.org/seamark/](https://tiles.openseamap.org/seamark/){z}/{x}/{y}.png | Slippy tile URL template |
| userAgent | string | SignalK-Corridor-Downloader/1.0 | Custom User-Agent header for HTTP requests |
4. Geospatial & Tile Mathematics Engine
A. Coordinate-to-Tile Conversion (Slippy Map XYZ)
For a given Latitude (\text{lat}), Longitude (\text{lon}), and Zoom Level (z):
B. MBTiles TMS Coordinate Inversion
Slippy map tiles use XYZ orientation (origin top-left). The MBTiles standard requires TMS orientation (origin bottom-left):
C. Swath Buffer Math
To calculate the tile margin (dx, dy) corresponding to a physical margin in Nautical Miles (M) at latitude \text{lat} and zoom z:
For every interpolated coordinate point along the route, queue all tiles in the grid range [x - N, x + N] and [y - N, y + N].
5. SQLite Storage & Engine Specification (lib/mbtiles.js)
Leveraging import { DatabaseSync } from 'node:sqlite':
A. Database Initialization & Concurrency
Execute the following SQL upon plugin load if the target file does not exist. The WAL pragma is mandatory for read/write concurrency.
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS metadata (name text, value text);
CREATE TABLE IF NOT EXISTS tiles (
  zoom_level integer, 
  tile_column integer, 
  tile_row integer, 
  tile_data blob
);
CREATE UNIQUE INDEX IF NOT EXISTS tile_index ON tiles (zoom_level, tile_column, tile_row);

-- Populate Required MBTiles Metadata
INSERT OR REPLACE INTO metadata (name, value) VALUES 
  ('name', 'Signal K Corridor Cache'),
  ('format', 'png'),
  ('type', 'overlay'),
  ('version', '1.0.0');

B. Read & Write API
 * Tile Existence Check: SELECT 1 FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?
 * Tile Insert (Atomic Upsert): INSERT OR IGNORE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)
 * Reclaim Storage: Execute VACUUM; command on database connection upon user request via REST API.
6. Plugin Interoperability & Tile Handoff
This plugin acts strictly as a Data Producer. It relies on signalk-charts-provider-simple acting as the Data Consumer to handle web-serving the map tiles to Freeboard SK.
A. The File System Contract
 * Shared Directory: The output must be written directly into the directory actively watched by the Consumer plugin (defined by outputPath).
 * File Naming: Output to a persistent, predictable filename to prevent the Consumer from needing to re-scan or re-register chart IDs with the core Signal K API on every update.
B. SQLite Concurrency & Live Updating
 * Non-Blocking Writes: Because the Consumer plugin may actively read the .mbtiles file, the Downloader's use of PRAGMA journal_mode=WAL; and INSERT OR IGNORE ensures the Consumer never encounters a SQLITE_BUSY lock.
 * Live Visibility: Any tile downloaded and inserted instantly becomes available to Freeboard SK on the next map pan/zoom, with zero restart required.
C. The API Discovery Handoff
To ensure Freeboard SK automatically discovers the corridor and bounds it correctly:
 * The Downloader must update the bounds row in the metadata table to reflect the geographic bounding box of the currently active route upon starting a new fetch.
 * minzoom and maxzoom metadata rows must accurately reflect the configured download ranges.
7. REST API Specification
All endpoints are registered under /plugins/signalk-corridor-tile-downloader/.
1. GET /status
 * Response: 200 OK
 * Payload:
   {
  "isDownloading": false,
  "totalQueued": 1420,
  "completed": 850,
  "failed": 2,
  "activeRouteName": "Aitutaki to Niue",
  "dbSizeBytes": 45120000
}

2. POST /fetch-active-route
 * Behavior: Queries Signal K API for active route (navigation.course.activeRoute), retrieves waypoints, interpolates line segments, calculates corridor tile grid, updates metadata bounds, and starts the background download queue.
 * Response: 200 OK \rightarrow { "status": "started", "totalTiles": 1420 }
3. POST /fetch-target
 * Request Body: application/json
   {
  "coordinates": [
    {"lat": -18.85, "lon": -159.78},
    {"lat": -19.05, "lon": -169.85}
  ]
}

 * Response: 200 OK \rightarrow { "status": "started", "totalTiles": 1420 }
4. POST /cancel
 * Behavior: Immediately sets an internal abort flag terminating the active background loop.
 * Response: 200 OK \rightarrow { "status": "cancelled" }
5. POST /vacuum
 * Behavior: Closes active read locks and executes SQLite VACUUM;.
 * Response: 200 OK \rightarrow { "status": "vacuum_complete" }
8. Web UI Specification (public/)
A. Layout & UX Principles
 * Zero External Dependencies: Built strictly with native HTML5, ES6 JavaScript Modules, and CSS variables. No front-end frameworks.
 * Design System: Maritime dark-mode (pure dark background #121212, high contrast text #E0E0E0, accent #00ACC1, warning/error #FF5252).
 * Responsive Grid: Touch-friendly layout optimized for marine chartplotters and tablets.
B. Functional Components
 * Status Header: Live badge showing backend connection status and active job state via /status polling.
 * Active Route Trigger Panel: One-click button to trigger downloads based on Signal K's active navigation route. Disables globally when isDownloading is true.
 * GPX Drag-and-Drop Dropzone: Browser-side XML parsing of .gpx files using native DOMParser. Extracts trackpoints/waypoints into JSON and POSTs to /fetch-target. Raw XML is never uploaded.
 * Download Progress Monitor: Custom Web Component (<corridor-progress>) rendering a native progress bar, percentage readout, and estimated time remaining (ETA). Includes a "Cancel Job" action.
 * Database Storage Management Panel: Displays cached database size on disk. Provides a "Vacuum / Free Space" execution trigger guarded by a JavaScript confirm() dialog.
9. Compliance & Execution Checklist
Before concluding implementation:
 * Verify Node.js execution flag or version check (\ge 22.5.0) for native DatabaseSync support.
 * Ensure HTTP client logic implements exponential backoff on HTTP 429 Too Many Requests or network timeouts.
 * Verify the plugin clears any pending queue intervals in the Signal K stop() lifecycle hook.

## Addendum 1: Multi-Tier Zoom Margins
A single wide margin wastes data on high-detail ocean tiles, while a narrow margin risks missing tacking routes. The geometry engine must implement a Multi-Tier Margin strategy:
 * Strategic Swath (Zooms 8-10): 50 NM margin on each side of the route for broad weather routing and major deviations.
 * Tactical Swath (Zooms 11-13): 15 NM margin for standard tacking and current offsets.
 * Approach Rings (Zooms 14-16): 3 NM radius strictly around the start and end coordinates to capture high-resolution reef and anchorage details.
## Addendum 2: Defensive Fetching and Rate Limits
Tile providers actively employ countermeasures against scraping. The background fetch loop must implement strict validation:
 * Size Validation: Rate-limit placeholders often return HTTP 200 OK but are tiny. The script must inspect the buffer byte length; if it is less than 500 bytes, it must be discarded and logged as a failure, not inserted into SQLite.
 * Exponential Backoff: Upon receiving an HTTP 429 Too Many Requests or HTTP 503, the throttle must instantly increase to 5 minutes, doubling on subsequent failures (up to 30 minutes).
## Addendum 3: Network Circuit Breaker
To protect offshore data budgets, the background loop must actively monitor the vessel's connectivity via the Signal K data model.
 * State Polling: Before every tile fetch, query app.getSelfPath('network.internet.state.value').
 * Suspend Logic: If the state evaluates to offline or metered, the fetch loop must enter an indefinite sleep cycle (polling every 10 seconds).
 * Resume Logic: The loop automatically resumes fetching when the state returns to online.
## Addendum 4: Web UI and Schema Updates
The JSON schema and frontend must expose these new capabilities:
 * Configuration: Replace the single margin setting with strategicMarginNM, tacticalMarginNM, and approachRadiusNM.
 * Metered Override: Add a boolean toggle to the UI ("Force Download on Metered Connection") to bypass the circuit breaker for emergency offshore chart fetches.
## Addendum 5: Just-In-Time (JIT) Position Recovery Cache
Purpose:
Automatically detect if the vessel has drifted outside the pre-cached corridor and dynamically fetch a safety bubble of tiles around the current position when internet connectivity becomes available.
1. Position Subscription & Distance Throttling
 * Signal K Path: Subscribe to navigation.position.
 * Distance Throttle: To prevent constant SQLite queries and CPU thrashing, the plugin must only trigger a cache verification when the vessel has moved more than 1 Nautical Mile from the last checked position (calculated via a standard Haversine formula).
2. The Recovery Radius Calculation
When triggered, calculate the required tile coordinates for a safety bubble around the current GPS coordinate:
 * Broad View: 5 NM radius for zoom levels 8 through 12.
 * Tactical View: 2 NM radius for zoom levels 13 and 14.
3. Cache Verification & The Recovery Queue
 * Query the active SQLite database using SELECT 1 FROM tiles... for all tiles in the calculated Recovery Radius.
 * Any tiles that return null (meaning they were not part of the original corridor download) are immediately pushed to a high-priority recoveryQueue.
4. Priority Fetching & State Transitions
 * Queue Priority: The downloader loop must always empty the recoveryQueue before processing any remaining tiles in the standard passage queue.
 * Metered Awareness: The UI schema must include a boolean configuration parameter: allowRecoveryOnMetered (default: true).
 * Execution: When network.internet.state transitions from offline to metered (if allowed) or online, the loop immediately wakes up, processes the recoveryQueue, and safely inserts the missing tiles into the database using INSERT OR IGNORE.
5. Freeboard SK Handoff
Because of the WAL journal mode and atomic inserts specified in Section 6, the moment these recovery tiles are saved, they will instantly appear on the Freeboard SK display without requiring a page refresh or server restart.
## Addendum 6: Open Waters Raster Tile Integration
Purpose:
Configure the downloader to source modern, pre-rendered raster PNG tiles from the Open Waters project, ensuring universal chart compatibility across Freeboard SK and custom lightweight vessel applications without requiring heavy WebGL client libraries.
1. Configuration & Schema Updates
The Signal K Admin UI JSON Schema must be updated to support provider selection, dynamically updating the target URL template based on the user's choice.
 * New Property: tileProvider (Enum: ["OpenSeaMap", "Open Waters Seamap"], Default: "Open Waters Seamap").
 * Dynamic URL Injection:
   * If Open Waters Seamap is selected, default the URL template to: [https://tiles.openwaters.io/seamap/](https://tiles.openwaters.io/seamap/){z}/{x}/{y}.png
   * If OpenSeaMap is selected, default to: [https://tiles.openseamap.org/seamark/](https://tiles.openseamap.org/seamark/){z}/{x}/{y}.png
2. SQLite Metadata Integrity
Because we are strictly downloading raster PNGs, the metadata table format remains universally compatible.
 * The format row in the SQLite metadata table must remain strictly set to png.
 * The type row should be set to overlay (as Open Waters seamap/seascape rasters feature transparent backgrounds that stack perfectly over your offline OpenStreetMap base layer).
3. Content-Type and Buffer Validation
Open Waters APIs may employ different rate-limiting responses than OpenSeaMap. The background fetch loop's defensive engineering must be updated to validate the exact raster payload:
 * Header Check: The HTTP response Content-Type must strictly evaluate to image/png. If it returns application/json or text/html (often indicating a rate limit or server error), the script must drop the payload, log the failure, and trigger the exponential backoff throttle.
 * Buffer Size Check: Any PNG buffer under 300 bytes must be treated as a placeholder/error image and discarded.
4. Universal Client Distribution
The resulting passage_cache.mbtiles file generated by this addendum acts as a universal raster source. Any web application on the Lille Ø network can request an XYZ tile from the Signal K server (e.g., <img src="[http://10.10.10.1:3000/charts/passage_cache/14/256/743.png](http://10.10.10.1:3000/charts/passage_cache/14/256/743.png)">) and the browser will render it natively, requiring zero external rendering libraries.
