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

### 4. Run a Local Development Server

Because modern web browsers enforce strict security policies regarding local file fetching (`CORS policy`), you must run a local HTTP server from the root directory of the project.

Run one of the following commands depending on your environment:

* **Using Python (Recommended for simple setups):**
  ```bash
  python3 -m http.server 8080
  ```
  *(Or `python -m SimpleHTTPServer 8080` for older Python 2 versions)*

### 5. Open the Map in Your Browser

Once the server is running, open your web browser and navigate to:

```text
http://localhost:8080/web/index.html
```

## Configuration & Customization

* **Adding Markers:** Edit `points/points.json` to add, remove, or modify map points, coordinates (`lat`/`lon`), and marker visual properties.
* **Styling:** Modify `web/js/load-map.js` to adjust default zoom levels, center coordinates, or popup templates.