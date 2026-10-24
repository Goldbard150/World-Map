import argparse
import json
import os
import re
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.json"
IMAGE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
API_FIELDS = {
    "geometry": "geometry",
    "captured_at": "captured_at",
    "compass_angle": "compass_angle",
    "sequence": "sequence",
    "creator": "creator",
}
REQUEST_INTERVAL_SECONDS = 0.25
_request_lock = Lock()
_next_request_time = 0.0


def load_access_token():
    token = os.environ.get("MAPILLARY_ACCESS_TOKEN", "").strip()
    if token:
        return token

    env_path = PROJECT_ROOT / ".env"
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.strip().partition("=")
            if separator and key.strip() == "MAPILLARY_ACCESS_TOKEN":
                token = value.strip().strip("\"'")
                if token:
                    return token

    raise RuntimeError("MAPILLARY_ACCESS_TOKEN is missing from the project .env file or environment.")


def load_panorama_directories():
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read {CONFIG_PATH}: {error}") from error

    folder_value = config.get("mapillary_folder")
    if not isinstance(folder_value, str) or not folder_value.strip():
        raise RuntimeError("Set 'mapillary_folder' in config.json.")

    folder = Path(folder_value)
    if not folder.is_absolute():
        folder = PROJECT_ROOT / folder

    images_dir = folder / "images"
    metadata_dir = folder / "metadata"
    if not images_dir.is_dir():
        raise FileNotFoundError(f"Images folder does not exist: {images_dir}")
    if not metadata_dir.is_dir():
        raise FileNotFoundError(f"Metadata folder does not exist: {metadata_dir}")

    return images_dir, metadata_dir


def is_missing(value):
    return value is None or value == "" or value == [] or value == {}


def fetch_missing_metadata(image_id, fields, token):
    global _next_request_time
    with _request_lock:
        delay = _next_request_time - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        _next_request_time = time.monotonic() + REQUEST_INTERVAL_SECONDS

    params = urlencode({
        "access_token": token,
        "fields": ",".join(["id", *fields]),
    })
    request = Request(
        f"https://graph.mapillary.com/{image_id}?{params}",
        headers={"User-Agent": "World-Map-MetadataUpdater/1.0"},
    )

    try:
        with urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"Mapillary API returned HTTP {error.code}.") from error
    except URLError as error:
        raise RuntimeError(f"Could not connect to the Mapillary API: {error.reason}") from error
    except (TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read a valid response from the Mapillary API: {error}") from error

    if isinstance(data, dict) and "error" in data:
        raise RuntimeError(f"Mapillary API error: {data['error']}")
    if not isinstance(data, dict) or data.get("id") != image_id:
        raise RuntimeError("Mapillary API returned an unexpected image record.")
    return data


def write_metadata(metadata_path, metadata):
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=metadata_path.parent,
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(metadata, temporary_file, ensure_ascii=False, indent=2)
            temporary_file.write("\n")
        os.replace(temporary_path, metadata_path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def missing_metadata_fields(metadata):
    return [
        api_field
        for metadata_key, api_field in API_FIELDS.items()
        if is_missing(metadata.get(metadata_key))
        and not (metadata_key == "sequence" and not is_missing(metadata.get("sequence_id")))
    ]


def update_one_metadata(image_id, metadata_path, token, dry_run):
    if not IMAGE_ID_PATTERN.fullmatch(image_id):
        raise ValueError("Image ID may contain only letters, numbers, underscores, and hyphens.")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
    if not isinstance(metadata, dict):
        raise ValueError(f"Metadata file must contain a JSON object: {metadata_path}")

    missing_fields = missing_metadata_fields(metadata)
    if not missing_fields:
        return "complete"

    api_data = fetch_missing_metadata(image_id, missing_fields, token)
    updated_fields = {}
    for field in missing_fields:
        value = api_data.get(field)
        if not is_missing(value):
            metadata[field] = value
            updated_fields[field] = value

    if not updated_fields:
        return "unavailable"

    if not dry_run:
        write_metadata(metadata_path, metadata)
    return "would_update" if dry_run else "updated"


def main():
    parser = argparse.ArgumentParser(
        description="Fill missing navigation fields in local panorama metadata files."
    )
    parser.add_argument(
        "image_id",
        nargs="?",
        help="Update one image ID. Omit this to process every image in mapillary_folder/images.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and report missing fields without writing the metadata file.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=8,
        help="Maximum number of concurrent image updates (default: 8).",
    )
    args = parser.parse_args()

    try:
        if args.workers < 1:
            raise ValueError("--workers must be at least 1.")

        images_dir, metadata_dir = load_panorama_directories()
        if args.image_id:
            if not IMAGE_ID_PATTERN.fullmatch(args.image_id):
                raise ValueError("Image ID may contain only letters, numbers, underscores, and hyphens.")
            image_ids = [args.image_id]
            missing_metadata = [
                extension for extension in (".jpg", ".jpeg", ".png", ".webp")
                if (images_dir / f"{args.image_id}{extension}").is_file()
            ]
            if not missing_metadata:
                raise FileNotFoundError(f"No local image file was found for ID {args.image_id}.")
            if not (metadata_dir / f"{args.image_id}.json").is_file():
                raise FileNotFoundError(
                    f"No local metadata file was found: {metadata_dir / f'{args.image_id}.json'}"
                )
        else:
            image_extensions = {".jpg", ".jpeg", ".png", ".webp"}
            image_ids = sorted({
                path.stem
                for path in images_dir.iterdir()
                if path.is_file() and path.suffix.lower() in image_extensions
            })
            if not image_ids:
                raise FileNotFoundError(f"No supported image files were found in {images_dir}.")

        token = load_access_token()
        counts = {
            "updated": 0,
            "would_update": 0,
            "complete": 0,
            "unavailable": 0,
            "missing_metadata": 0,
            "failed": 0,
        }
        print(f"Processing {len(image_ids)} image(s) from {images_dir}.")

        jobs = []
        for image_id in image_ids:
            metadata_path = metadata_dir / f"{image_id}.json"
            if not metadata_path.is_file():
                counts["missing_metadata"] += 1
                continue
            jobs.append((image_id, metadata_path))

        if counts["missing_metadata"]:
            print(f"Skipped {counts['missing_metadata']} images without matching metadata files.")

        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(
                    update_one_metadata,
                    image_id,
                    metadata_path,
                    token,
                    args.dry_run,
                ): image_id
                for image_id, metadata_path in jobs
            }

            for index, future in enumerate(as_completed(futures), start=1):
                image_id = futures[future]
                try:
                    result = future.result()
                    counts[result] += 1
                    if result in ("updated", "would_update", "unavailable"):
                        print(f"[{index}/{len(jobs)}] {image_id}: {result.replace('_', ' ')}.")
                except (OSError, ValueError, RuntimeError) as error:
                    counts["failed"] += 1
                    print(f"[{index}/{len(jobs)}] {image_id}: ERROR: {error}", file=sys.stderr)

                if index % 100 == 0:
                    print(
                        f"Progress: {index}/{len(jobs)}; "
                        f"updated={counts['updated']}, complete={counts['complete']}, "
                        f"failed={counts['failed']}."
                    )

        print(
            "Finished. "
            f"Updated: {counts['updated']}; "
            f"already complete: {counts['complete']}; "
            f"API returned no missing values: {counts['unavailable']}; "
            f"missing metadata files: {counts['missing_metadata']}; "
            f"failed: {counts['failed']}."
        )
        return 1 if counts["failed"] else 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
