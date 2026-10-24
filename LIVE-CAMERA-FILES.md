# Live Camera Files and Changes

This document lists the implementation files related to Live Camera and the relevant line numbers in the current workspace. Line numbers refer to the files as they are now. For existing files, the ranges indicate lines added or areas changed or replaced relative to the original Git version.

## New Files

| File | Lines | Purpose |
|---|---:|---|
| [`web/js/offline-panorama.js`](web/js/offline-panorama.js) | 1–190 | WebGL-based local panorama viewer: loads local images and supports rotation, zoom, resizing, and camera direction. |
| [`scripts/enrich-panorama-metadata.py`](scripts/enrich-panorama-metadata.py) | 1–283 | Utility for filling in missing location, direction, and sequence data in local panorama metadata, enabling panorama search and navigation. |
| [`israel_mapillary/progress.json`](israel_mapillary/progress.json) | — | Local record of image download progress. |
| `israel_mapillary/images/` and `israel_mapillary/metadata/` | — | Local panorama images and metadata used by offline mode. These are data files, not source code. |

## Existing Files with Added or Changed Lines

| File | Relevant lines | What was added or changed |
|---|---:|---|
| [`config.json`](config.json) | 19–22 | Mapillary configuration, including `mapillary_offline` on line 20, the data folder, and the search radius. The current value of `mapillary_offline` is `false`. |
| [`server.py`](server.py) | 1–14, 23–54 | Imports and settings for offline/online mode, the image folder, and search radius; validation of `mapillary_offline`. |
| [`server.py`](server.py) | 85–154 | Reads and normalizes panorama metadata, creates records, and supports location, creator, direction, and sequences. |
| [`server.py`](server.py) | 156–184 | Local API routes for images, search, points, and navigation; `/api/config` returns the Mapillary mode and settings needed by the browser. |
| [`server.py`](server.py) | 235–359 | JSON response compression, panorama index construction, and background refresh so requests do not wait for a full scan whenever the data folders change. |
| [`server.py`](server.py) | 361–595 | Serves local images, finds the nearest image, creates the panorama-points layer, and navigates between local images. |
| [`.gitignore`](.gitignore) | 29–33 | Ignore rules for local images and data, and filtering of helper files that are not part of the source code. |
| [`web/index.html`](web/index.html) | 14–26, 31–33, 41 | Camera panel structure, online Mapillary viewer, local panorama canvas and controls, the points button, and inclusion of the local viewer script. The Mapillary files in `vendor/` already existed and were reused. |
| [`web/css/app.css`](web/css/app.css) | 35–145, 157, 174–177, 188–192, 218–235 | Styling for the camera panel, canvas, and navigation; display of buttons and direction marker; UI adjustments for online and local modes. |
| [`web/js/load-map.js`](web/js/load-map.js) | 2–25, 57–79, 81–184 | Loads server configuration, selects local search or the Mapillary Graph API, finds nearby images, and displays error messages. |
| [`web/js/load-map.js`](web/js/load-map.js) | 217–280, 283–329 | Initializes camera mode, resizes the viewer, places the direction marker on the map, and displays the selected image. |
| [`web/js/load-map.js`](web/js/load-map.js) | 330–429 | Handles online images and their location, direction, capture time, and attribution data. |
| [`web/js/load-map.js`](web/js/load-map.js) | 435–585 | Displays local points, handles the Live Camera toggle, and creates the local or online viewer according to the configuration. |
| [`web/js/load-map.js`](web/js/load-map.js) | 586–698, 786–807 | Previous/next navigation and automatic advance in local mode; handles map clicks to open an image. |
| [`README.md`](README.md) | 114–125 | Instructions for downloading images, filling in metadata, and selecting local or online Mapillary mode. |

## Selecting a Mode

In [`config.json`](config.json), `mapillary_offline` determines how Live Camera works:

- `true` — images, points, and navigation use local Mapillary files.
- `false` — images are searched and displayed through Mapillary online; `MAPILLARY_ACCESS_TOKEN` must be set in `.env`.

The line numbers above reflect the current files and may change when the code is edited.

The files `web/vendor/mapillary.js` and `web/vendor/mapillary.css`, as well as the local download script `scripts/download-israel-panoramas.py`, already existed in the workspace and were not added by this change. The existing Mapillary files are reused to display online imagery.
