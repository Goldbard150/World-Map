# Interactive Map Project (MapLibre GL & GeoJSON)

A lightweight, interactive web mapping project built with **MapLibre GL JS** and custom GeoJSON data integration, featuring localized style rendering, dynamic point overlays, and interactive popups.

## Features

* **MapLibre GL Integration:** Renders custom vector map styles efficiently.
* **Dynamic GeoJSON Points:** Loads location markers dynamically from an external `points.json` file.
* **Custom Styling & Popups:** Renders custom circle markers with individual properties displayed interactively on click.
* **Optimized Font Management:** Configured to load only the required font glyphs (`Klokantech Noto Sans Regular`) to maintain a lightweight repository size.

## Project Structure

```
project-root/
│
├── web/
│   ├── index.html         # Main HTML entry point
│   └── js/
│       └── load-map.js    # Map initialization and point loading logic
│
├── points/
│   └── points.json        # GeoJSON data source for map markers
│
├── fonts/                 # Font glyphs directory (tracked specifically for Klokantech Noto Sans Regular)
│
├── styles/                # Map style definitions (e.g., osm-bright)
│
├── package.json           # Project metadata and dependencies
├── package-lock.json      # Locked dependency versions
│
└── .gitignore             # Git ignore configuration
```

## Getting Started (From Scratch)

If you are a new user and have cloned this repository, follow these steps to set up and run the project locally from zero:

### 1. Prerequisites

Make sure you have the following installed on your machine:
* **Node.js** (which includes `npm`) – [Download Node.js](https://nodejs.org/)
* **Java (JDK 17 or newer)** – Required for running Planetiler – [Download OpenJDK](https://adoptium.net/)
* **Python** (often pre-installed on macOS/Linux) – Used for running a simple local HTTP server.

### 2. Clone the Repository

Open your terminal and run:

```bash
git clone https://github.com/your-username/your-repo-name.git
cd your-repo-name
```

### 3. Install Dependencies

If you are initializing or syncing the project packages, install the required dependencies defined in `package.json`:

```bash
npm install
```

*(Note: If you ever start a brand new Node project from absolute scratch yourself, you would run `npm init -y` first, but for this cloned repository, simply running `npm install` installs all tracked dependencies).*

### 4. Generating Local MBTiles from a PBF File (Planetiler)

If you have downloaded a local OpenStreetMap raw data file (`.pbf`) and want to generate vector map tiles (`.mbtiles`) using **Planetiler**:

1. Ensure you have the `planetiler.jar` file placed in your working directory alongside your downloaded `.pbf` file.
2. Run the conversion command in your terminal:
   ```bash
   java -Xmx4g -jar planetiler.jar --osm-path=path/to/your-file.pbf --output=output.mbtiles
   ```
   * `-Xmx4g` allocates 4GB of RAM to speed up the process.
   * `--osm-path` directs Planetiler to use your local PBF file without downloading anything from the internet.
   * `--output` specifies the name and location of the resulting `.mbtiles` file.

### 5. Run a Local Development Server

> 🚀 **Quick Start Shortcut:** Instead of manual commands, you can simply double-click and run the **`run.bat`** script located in the project root to automate the startup!

Because modern web browsers enforce strict security policies regarding local file fetching (`CORS policy`), you must run a local HTTP server from the root directory of the project.

Run one of the following commands depending on your environment:

* **Using the project server (Recommended):**
  ```bash
  python server.py
  ```
  This serves the site and offline panorama lookup endpoints on port `8000`.

* **Using NPM (Alternative Node.js static server):**
  If you prefer using npm packages (like `serve` or a local script), you can run:
  ```bash
  npx serve .
  ```

* **Running the TileServer with Config (For MBTiles vector maps):**
  To launch the map server using your local configuration file and serve vector tiles:
  ```bash
  npx tileserver-gl-light --config config.json
  ```

### 6. Open the Map in Your Browser

Once the server is running, open your web browser and navigate to:

```text
http://127.0.0.1:8000/web/index.html
```

## Configuration & Customization

* **Downloading Israel panoramas:** Set `MAPILLARY_ACCESS_TOKEN` in the project-root `.env` file, then run this from PowerShell at the project root:
  ```powershell
  python .\scripts\download-israel-panoramas.py
  ```
  The downloader writes images to `israel_mapillary/images/` and matching metadata to `israel_mapillary/metadata/`; its progress is stored in `israel_mapillary/progress.json`. It scans the approximate Israel bounding box configured in the script. Downloading requires internet and a valid Mapillary token.
* **Filling missing panorama metadata:** With no image ID, the script scans every image in `mapillary_folder/images/` and updates the matching JSON files for fields missing from each record. To process the whole folder:
  ```powershell
  python .\scripts\enrich-panorama-metadata.py --workers 8
  ```
  To update only one image, pass its ID: `python .\scripts\enrich-panorama-metadata.py <image-id>`. The image ID must match the local image and JSON filenames, and `MAPILLARY_ACCESS_TOKEN` must be set in `.env`. The script requests only missing `geometry`, `captured_at`, `compass_angle`, `sequence`, and `creator` fields, preserves existing metadata, and atomically rewrites only matching JSON files; image files are never changed. Batch mode uses 8 workers by default; set `--workers` to change concurrency. Requests are globally spaced by at least 0.25 seconds, complete records are skipped, progress is reported every 100 finished images, and per-image errors do not stop the batch. Add `--dry-run` to fetch and report missing fields without writing any metadata.
* **Selecting local or online Mapillary imagery:** Set `mapillary_offline` in `config.json` to `true` to use the downloaded local panoramas, points, and navigation, or `false` to search and view imagery online through Mapillary. Online mode requires `MAPILLARY_ACCESS_TOKEN` in the project-root `.env` file. The search radius is controlled by `offline_search_radius_meters` in either mode. Restart `server.py` after changing these settings.
* **Using the offline camera:** Set `mapillary_folder` in `config.json` to the panorama data folder (relative to the project root, or an absolute path). The folder must contain `images/<image-id>.jpg` and matching `metadata/<image-id>.json` files. The default is `israel_mapillary`; the server reads each JSON file directly, so no `catalog.sqlite3` is required. `offline_search_radius_meters` controls how far the camera searches from a clicked map location; it defaults to 1000 meters and must not exceed 5000. Restart `server.py` after changing it. While panoramas are being downloaded, the server keeps using its last complete index and refreshes it in the background no more than once every 30 seconds, so API requests do not block on repeated full scans. Once the local server and TileServer are running and the image files are present, Live Camera viewing, panorama search, points, and navigation use only local files and local endpoints; they do not require an internet connection or a Mapillary token. In Live Camera Mode, **Show panorama points** displays all image locations from that folder as a map layer; click a point to open its local panorama. Use the compact left/play/right navigation bar to walk through nearby downloaded photos; without sequence metadata, navigation searches within at least 1000 meters and avoids images already visited in the current walk. Previous/next arrows use that local walk history, and **Play** advances automatically every 2.5 seconds. When `sequence` and `captured_at` are available, navigation follows the chronological order of that sequence, and the viewer shows the capture time and image position within it. When `compass_angle` is missing, the direction arrow is inferred from nearby image locations and, after moving, points along the selected local step; this is approximate because the local metadata contains no recorded camera heading. Metadata must include `geometry.coordinates` (or `coordinates`) for image search. Start `run.bat` after the local TileServer dependencies and map data are installed. Areas without locally downloaded panoramas will not have street imagery.
* **Adding Markers:** Edit `points/points.json` to add, remove, or modify map points, coordinates (`lat`/`lon`), and marker visual properties.
* **Styling:** Modify `web/js/load-map.js` to adjust default zoom levels, center coordinates, or popup templates.