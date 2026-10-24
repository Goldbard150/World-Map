import gzip
import json
import logging
import math
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


HOST = "127.0.0.1"
PORT = 8000
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "World-Map/1.0 (https://github.com/Goldbard150/World-Map)"
MIN_REQUEST_INTERVAL = 1.1
CACHE_LIMIT = 512
PANORAMA_INDEX_REFRESH_INTERVAL = 30
PROJECT_ROOT = Path(__file__).resolve().parent
CONFIG_PATH = PROJECT_ROOT / "config.json"
PANORAMA_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


def load_app_config():
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not load project configuration {CONFIG_PATH}: {error}") from error

    radius = config.get("offline_search_radius_meters", 1000)
    if isinstance(radius, bool) or not isinstance(radius, (int, float)) or not 0 < radius <= 5000:
        raise RuntimeError("'offline_search_radius_meters' in config.json must be greater than 0 and at most 5000")

    folder = config.get("mapillary_folder")
    if not isinstance(folder, str) or not folder.strip():
        raise RuntimeError("Set a non-empty 'mapillary_folder' in config.json")

    mapillary_offline = config.get("mapillary_offline", True)
    if not isinstance(mapillary_offline, bool):
        raise RuntimeError("'mapillary_offline' in config.json must be true or false")

    path = Path(folder)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path.resolve(), radius, mapillary_offline


MAPILLARY_FOLDER, OFFLINE_SEARCH_RADIUS_METERS, MAPILLARY_OFFLINE = load_app_config()
PANORAMA_IMAGES = MAPILLARY_FOLDER / "images"
PANORAMA_METADATA = MAPILLARY_FOLDER / "metadata"


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
    _panorama_index = None
    _panorama_index_signature = None
    _panorama_sequences = {}
    _panorama_index_lock = Lock()
    _panorama_index_refreshing = False
    _panorama_index_last_refresh = 0.0

    @classmethod
    def _read_panorama_record(cls, item):
        metadata_path, image_path = item
        image_id = metadata_path.stem
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as error:
            cls.log_error("Could not read panorama metadata %s: %s", metadata_path, error)
            return image_id, None

        if not isinstance(metadata, dict):
            cls.log_error("Skipping panorama metadata that is not an object: %s", metadata_path)
            return image_id, None

        geometry = metadata.get("geometry")
        coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
        if coordinates is None:
            coordinates = metadata.get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            cls.log_error("Skipping panorama metadata without coordinates: %s", metadata_path)
            return image_id, None
        try:
            longitude = float(coordinates[0])
            latitude = float(coordinates[1])
            if not (
                math.isfinite(longitude)
                and math.isfinite(latitude)
                and -180 <= longitude <= 180
                and -90 <= latitude <= 90
            ):
                raise ValueError("Coordinates are outside valid ranges")
        except (TypeError, ValueError) as error:
            cls.log_error("Skipping invalid panorama coordinates in %s: %s", metadata_path, error)
            return image_id, None

        creator = metadata.get("creator") or {}
        captured_at = metadata.get("captured_at")
        compass_angle = metadata.get("compass_angle")
        return image_id, {
            "id": image_id,
            "longitude": longitude,
            "latitude": latitude,
            "compass_angle": compass_angle if compass_angle is not None else 0,
            "_has_compass_angle": compass_angle is not None,
            "is_pano": metadata.get("is_pano"),
            "sequence_id": metadata.get("sequence_id") or metadata.get("sequence"),
            "captured_at": captured_at,
            "creator_username": creator.get("username") or metadata.get("creator_username"),
            "image_url": f"/api/offline/image/{image_id}",
            "attribution_url": metadata.get(
                "attribution_url",
                f"https://www.mapillary.com/app/?pKey={image_id}&focus=photo",
            ),
            "_image_path": image_path,
        }

    @classmethod
    def _serialize_panorama_record(cls, record):
        result = {key: value for key, value in record.items() if not key.startswith("_")}
        if "_sequence_position" in record:
            result["sequence_position"] = record["_sequence_position"] + 1
            result["sequence_length"] = record["_sequence_length"]
        return result

    def do_GET(self):
        parsed_url = urlparse(self.path)
        if parsed_url.path == "/api/offline/nearest":
            self._offline_nearest(parse_qs(parsed_url.query))
            return
        if parsed_url.path == "/api/offline/points":
            self._offline_points()
            return
        if parsed_url.path == "/api/offline/sequence":
            self._offline_sequence(parse_qs(parsed_url.query))
            return
        if parsed_url.path.startswith("/api/offline/image/"):
            self._offline_image(parsed_url.path.rsplit("/", 1)[-1])
            return
        if parsed_url.path == "/api/config":
            token = os.environ.get("MAPILLARY_ACCESS_TOKEN", "").strip()
            if token == "PASTE_YOUR_NEW_MAPILLARY_TOKEN_HERE":
                token = ""
            self._send_json(
                200,
                {
                    "mapillaryOffline": MAPILLARY_OFFLINE,
                    "mapillaryAccessToken": "" if MAPILLARY_OFFLINE else token,
                    "searchRadiusMeters": OFFLINE_SEARCH_RADIUS_METERS,
                },
            )
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
        accepts_gzip = False
        for encoding in self.headers.get("Accept-Encoding", "").split(","):
            coding, *parameters = encoding.split(";")
            if coding.strip().lower() != "gzip":
                continue
            quality = next(
                (
                    parameter.partition("=")[2].strip()
                    for parameter in parameters
                    if parameter.strip().lower().startswith("q=")
                ),
                "1",
            )
            try:
                accepts_gzip = 0 < float(quality) <= 1
            except ValueError:
                accepts_gzip = False
            break
        compressed = len(body) > 1024 and accepts_gzip
        if compressed:
            body = gzip.compress(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as error:
            self.log_error("Client disconnected while receiving API response: %s", error)

    @classmethod
    def _build_panorama_index(cls):
        images = {
            path.stem: path
            for path in PANORAMA_IMAGES.iterdir()
            if path.is_file() and path.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")
        }
        metadata_files = (
            (path, images[path.stem])
            for path in PANORAMA_METADATA.glob("*.json")
            if path.stem in images
        )
        with ThreadPoolExecutor(max_workers=16) as executor:
            records = {
                image_id: record
                for image_id, record in executor.map(cls._read_panorama_record, metadata_files)
                if record is not None
            }

        sequences = {}
        for record in records.values():
            captured_at = record["captured_at"]
            if not record["sequence_id"] or captured_at is None:
                continue
            try:
                timestamp = float(captured_at)
            except (TypeError, ValueError):
                continue
            if math.isfinite(timestamp):
                sequences.setdefault(record["sequence_id"], []).append(record)

        for sequence in sequences.values():
            sequence.sort(key=lambda record: (float(record["captured_at"]), record["id"]))
            for position, record in enumerate(sequence):
                record["_sequence_position"] = position
                record["_sequence_length"] = len(sequence)

        return records, sequences

    @classmethod
    def _refresh_panorama_index(cls, signature):
        try:
            records, sequences = cls._build_panorama_index()
        except OSError as error:
            logging.error("Could not refresh local panorama index: %s", error)
        else:
            with cls._panorama_index_lock:
                cls._panorama_sequences = sequences
                cls._panorama_index = records
                cls._panorama_index_signature = signature
        finally:
            with cls._panorama_index_lock:
                cls._panorama_index_refreshing = False

    @classmethod
    def _load_panorama_index(cls):
        try:
            signature = (
                PANORAMA_METADATA.stat().st_mtime_ns,
                PANORAMA_IMAGES.stat().st_mtime_ns,
            )
        except OSError as error:
            raise FileNotFoundError(
                f"Mapillary image/metadata folders are not available under {MAPILLARY_FOLDER}"
            ) from error

        with cls._panorama_index_lock:
            if cls._panorama_index is not None:
                if signature != cls._panorama_index_signature:
                    now = time.monotonic()
                    if (
                        not cls._panorama_index_refreshing
                        and now - cls._panorama_index_last_refresh >= PANORAMA_INDEX_REFRESH_INTERVAL
                    ):
                        cls._panorama_index_refreshing = True
                        cls._panorama_index_last_refresh = now
                        Thread(
                            target=cls._refresh_panorama_index,
                            args=(signature,),
                            daemon=True,
                        ).start()
                return cls._panorama_index

            records, sequences = cls._build_panorama_index()
            cls._panorama_sequences = sequences
            cls._panorama_index = records
            cls._panorama_index_signature = signature
            cls._panorama_index_last_refresh = time.monotonic()
            return records

    def _offline_image(self, image_id):
        if not PANORAMA_ID_PATTERN.fullmatch(image_id):
            self._send_json(400, {"error": "Invalid panorama image id"})
            return
        try:
            record = self._load_panorama_index().get(image_id)
        except OSError as error:
            self._send_json(503, {"error": str(error)})
            return
        if record is None:
            self._send_json(404, {"error": "Panorama image is not available locally"})
            return

        image_path = record["_image_path"]
        content_type = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
        }[image_path.suffix.lower()]
        try:
            image_file = image_path.open("rb")
        except OSError as error:
            self.log_error("Could not open panorama image %s: %s", image_path, error)
            self._send_json(500, {"error": "Could not read panorama image"})
            return

        with image_file:
            size = os.fstat(image_file.fileno()).st_size
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            try:
                self.copyfile(image_file, self.wfile)
            except (BrokenPipeError, ConnectionResetError) as error:
                self.log_error("Client disconnected while receiving panorama image %s: %s", image_path, error)

    def _offline_nearest(self, query):
        try:
            longitude = float(query["lng"][0])
            latitude = float(query["lat"][0])
            radius = float(query.get("radius", [str(OFFLINE_SEARCH_RADIUS_METERS)])[0])
            if not (-180 <= longitude <= 180 and -90 <= latitude <= 90 and 0 < radius <= 5000):
                raise ValueError("Coordinates or radius are outside valid ranges")
        except (KeyError, IndexError, ValueError) as error:
            self._send_json(400, {"error": f"Invalid search parameters: {error}"})
            return

        try:
            records = self._load_panorama_index()
        except OSError as error:
            self._send_json(503, {"error": str(error)})
            return

        nearest = None
        nearest_distance = radius
        for record in records.values():
            dx = (record["longitude"] - longitude) * 111320 * math.cos(math.radians(latitude))
            dy = (record["latitude"] - latitude) * 111320
            distance = math.hypot(dx, dy)
            if distance <= nearest_distance:
                nearest = record
                nearest_distance = distance
        if nearest is None:
            self._send_json(404, {"error": f"No downloaded panoramas found within {radius:g} meters"})
            return
        if not nearest["_has_compass_angle"]:
            nearest = dict(nearest)
            nearest["compass_angle"] = self._infer_local_bearing(nearest, records)
        result = self._serialize_panorama_record(nearest)
        result["distance_meters"] = round(nearest_distance, 1)
        self._send_json(200, result)

    @staticmethod
    def _distance_and_bearing(origin, destination):
        longitude_delta = math.radians(destination["longitude"] - origin["longitude"])
        latitude = math.radians(origin["latitude"])
        destination_latitude = math.radians(destination["latitude"])
        distance_x = longitude_delta * math.cos((latitude + destination_latitude) / 2) * 6371000
        distance_y = (destination_latitude - latitude) * 6371000
        distance = math.hypot(distance_x, distance_y)
        bearing = (math.degrees(math.atan2(distance_x, distance_y)) + 360) % 360
        return distance, bearing

    @classmethod
    def _infer_local_bearing(cls, record, records):
        search_radius = max(OFFLINE_SEARCH_RADIUS_METERS, 1000)
        neighbors = []
        captured_at = record["captured_at"]
        try:
            captured_at = float(captured_at)
        except (TypeError, ValueError):
            captured_at = None
        for candidate in records.values():
            if candidate["id"] == record["id"]:
                continue
            distance, bearing = cls._distance_and_bearing(record, candidate)
            if 1 < distance <= search_radius:
                score = distance
                if captured_at is not None:
                    try:
                        candidate_time = float(candidate["captured_at"])
                    except (TypeError, ValueError):
                        candidate_time = None
                    if candidate_time is not None:
                        time_difference_seconds = abs(candidate_time - captured_at) / 1000
                        score += min(time_difference_seconds, 600) * 20
                neighbors.append((score, bearing))
        return min(neighbors, key=lambda neighbor: neighbor[0])[1] if neighbors else 0

    @classmethod
    def _find_directional_neighbor(cls, origin, records, target_bearing, excluded_ids):
        search_radius = max(OFFLINE_SEARCH_RADIUS_METERS, 1000)
        candidates = []
        for record in records.values():
            if record["id"] in excluded_ids:
                continue
            distance, candidate_bearing = cls._distance_and_bearing(origin, record)
            if not 1 < distance <= search_radius:
                continue
            bearing_difference = abs((candidate_bearing - target_bearing + 180) % 360 - 180)
            candidates.append((distance + bearing_difference * 2, bearing_difference, record))

        if not candidates:
            return None
        forward_candidates = [
            candidate for candidate in candidates
            if candidate[1] <= 110
        ]
        return min(forward_candidates, key=lambda candidate: candidate[0])[2] if forward_candidates else None

    def _offline_points(self):
        try:
            records = self._load_panorama_index().values()
        except OSError as error:
            self._send_json(503, {"error": str(error)})
            return

        collection = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [record["longitude"], record["latitude"]],
                    },
                    "properties": {"id": record["id"]},
                }
                for record in records
            ],
        }
        self._send_json(200, collection)

    def _offline_sequence(self, query):
        image_id = query.get("id", [""])[0]
        direction = query.get("direction", [""])[0]
        if not image_id or direction not in ("next", "previous"):
            self._send_json(400, {"error": "Provide an image id and direction=next|previous"})
            return
        try:
            bearing = float(query.get("bearing", ["0"])[0])
            if not math.isfinite(bearing):
                raise ValueError("Bearing must be finite")
        except (IndexError, ValueError) as error:
            self._send_json(400, {"error": f"Invalid bearing: {error}"})
            return
        try:
            records = self._load_panorama_index()
        except OSError as error:
            self._send_json(503, {"error": str(error)})
            return
        current = records.get(image_id)
        if current is None:
            self._send_json(404, {"error": "Image is not available locally"})
            return

        neighbor = None
        visited_ids = {
            value for value in query.get("visited", [""])[0].split(",") if value
        }
        if current["sequence_id"] and "_sequence_position" in current:
            sequence = self._panorama_sequences.get(current["sequence_id"], [])
            neighbor_index = current["_sequence_position"] + (1 if direction == "next" else -1)
            neighbor = sequence[neighbor_index] if 0 <= neighbor_index < len(sequence) else None
        if neighbor is None:
            excluded_ids = set(visited_ids)
            excluded_ids.add(image_id)
            target_bearing = (bearing + (0 if direction == "next" else 180)) % 360
            neighbor = self._find_directional_neighbor(
                current,
                records,
                target_bearing,
                excluded_ids,
            )

        if neighbor is None:
            self._send_json(404, {"error": "No nearby downloaded panorama found in that direction"})
            return
        if not neighbor["_has_compass_angle"]:
            if direction == "previous":
                _, inferred_bearing = self._distance_and_bearing(neighbor, current)
            else:
                _, arrival_bearing = self._distance_and_bearing(current, neighbor)
                excluded_ids = set(visited_ids)
                excluded_ids.update((current["id"], neighbor["id"]))
                next_neighbor = self._find_directional_neighbor(
                    neighbor,
                    records,
                    arrival_bearing,
                    excluded_ids,
                )
                if next_neighbor is not None:
                    _, inferred_bearing = self._distance_and_bearing(neighbor, next_neighbor)
                else:
                    inferred_bearing = arrival_bearing
            neighbor = dict(neighbor)
            neighbor["compass_angle"] = inferred_bearing
        self._send_json(
            200,
            self._serialize_panorama_record(neighbor),
        )


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), WorldMapHandler)
    print(f"World Map local server running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping World Map local server.")
    finally:
        server.server_close()
