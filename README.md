# Interactive Map Project (MapLibre GL & GeoJSON)

A lightweight, interactive web mapping project built with **MapLibre GL JS** and custom GeoJSON data integration, featuring localized style rendering, dynamic point overlays, and interactive popups.

---

## Features
- **MapLibre GL Integration:** Renders custom vector map styles efficiently.
- **Dynamic GeoJSON Points:** Loads location markers (e.g., Tel Aviv, Jerusalem) dynamically from an external `points.json` file.
- **Custom Styling & Popups:** Renders custom circle markers with individual properties displayed interactively on click.
- **Optimized Font Management:** Configured to load only the required font glyphs (`Klokantech Noto Sans Regular`) to maintain a lightweight repository size.

---

## Project Structure
```text
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
└── .gitignore             # Git ignore configuration
```

---

## Getting Started (For New Users / `git clone`)

If you have cloned this repository and want to run it locally from scratch, follow these steps:

### 1. Prerequisites
Make sure you have **Python** installed on your machine (usually pre-installed on macOS/Linux, and available via python.org on Windows). Python is used to run a local development server to avoid CORS issues when fetching local JSON files.

### 2. Clone the Repository
Open your terminal and run:
```bash
git clone https://github.com/your-username/your-repo-name.git
cd your-repo-name
```

### 3. Run a Local Development Server
Because modern browsers block local file fetching (`CORS policy`), you must run a local HTTP server from the root directory of the project.

Run one of the following commands depending on your Python version:
- **Python 3:**
  ```bash
  python3 -m http.server 8080
  ```
- **Python 2:**
  ```bash
  python -m SimpleHTTPServer 8080
  ```

### 4. Open the Map in Your Browser
Once the server is running, open your web browser and navigate to:
```text
http://localhost:8080/web/index.html
```

---

## Configuration & Customization
- **Adding Markers:** Edit `points/points.json` to add, remove, or modify map points, coordinates (`lat`/`lon`), and marker visual properties (`paint`).
- **Styling:** Modify `web/js/load-map.js` to adjust default zoom levels, center coordinates, or popup templates.