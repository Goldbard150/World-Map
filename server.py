import json
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


HOST = "127.0.0.1"
PORT = 8000
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "World-Map/1.0 (https://github.com/Goldbard150/World-Map)"
MIN_REQUEST_INTERVAL = 1.1
CACHE_LIMIT = 512


def load_environment_file():
    env_path = Path(__file__).resolve().with_name(".env")
    if not env_path.is_file():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped_line = line.strip()
        if not stripped_line or stripped_line.startswith("#"):
            continue

        key, separator, value = stripped_line.partition("=")
        if not separator:
            continue

        key = key.strip()
        value = value.strip().strip("\"'")
        if key and value:
            os.environ.setdefault(key, value)


load_environment_file()


class WorldMapHandler(SimpleHTTPRequestHandler):
    _cache = {}
    _last_nominatim_request = 0.0
    _nominatim_lock = Lock()

    def do_GET(self):
        parsed_url = urlparse(self.path)
        if parsed_url.path == "/api/config":
            token = os.environ.get("MAPILLARY_ACCESS_TOKEN", "").strip()
            if not token or token == "PASTE_YOUR_NEW_MAPILLARY_TOKEN_HERE":
                self._send_json(503, {"error": "MAPILLARY_ACCESS_TOKEN is not configured"})
                return
            self._send_json(200, {"mapillaryAccessToken": token})
            return

        if parsed_url.path != "/api/reverse-geocode":
            return super().do_GET()

        query = parse_qs(parsed_url.query)
        try:
            lat = float(query["lat"][0])
            lon = float(query["lon"][0])
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("Coordinates are outside valid ranges")
        except (KeyError, IndexError, ValueError) as error:
            self._send_json(400, {"error": f"Invalid coordinates: {error}"})
            return

        cache_key = (round(lat, 4), round(lon, 4))
        if cache_key in self._cache:
            self._send_json(200, self._cache[cache_key])
            return

        try:
            result = self._reverse_geocode(lat, lon)
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
            self.log_error("Reverse geocoding request failed: %s", error)
            self._send_json(502, {"error": "Reverse geocoding service is unavailable"})
            return

        if len(self._cache) >= CACHE_LIMIT:
            self._cache.clear()
        self._cache[cache_key] = result
        self._send_json(200, result)

    def _reverse_geocode(self, lat, lon):
        with self._nominatim_lock:
            delay = MIN_REQUEST_INTERVAL - (time.monotonic() - self._last_nominatim_request)
            if delay > 0:
                time.sleep(delay)
            self._last_nominatim_request = time.monotonic()

            query = (
                f"?format=jsonv2&lat={lat}&lon={lon}"
                "&zoom=18&addressdetails=1&accept-language=he"
            )
            request = Request(
                NOMINATIM_URL + query,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
            )
            with urlopen(request, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))

    def _send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), WorldMapHandler)
    print(f"World Map local server running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping World Map local server.")
    finally:
        server.server_close()
