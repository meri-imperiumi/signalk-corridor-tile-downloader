# Signal K Corridor Tile Downloader

Signal K server plugin that pre-caches marine chart tiles along a route for offline navigation: it follows your active route or a GPX file and computes a multi-tier corridor (50 NM strategic swath for zooms 8–10, 15 NM tactical swath for 11–13, 3 NM approach rings around the route ends for 14+), and downloads the raster overlay tiles from Open Waters Seamap or OpenSeaMap into the directory watched by [signalk-charts-provider-simple](https://github.com/dirkwa/signalk-charts-provider-simple), so the corridor appears live in Freeboard SK without restarts.

A just-in-time recovery cache subscribes to `navigation.position` and fetches a safety bubble around the vessel whenever it drifts outside the cached corridor, a network circuit breaker suspends downloads while the internet connection is offline or metered.

## Supported sources

* [Open Waters Seamap](https://openwaters.io/charts/seamap/)
* [OpenSeaMap](https://openseamap.org/index.php?id=openseamap&no_cache=1)

## Data usage

Data usage depends on the source being used and the length of the route. The ~600NM passage from Aitutaki in Cook Islands to Niue is about 550MB.
