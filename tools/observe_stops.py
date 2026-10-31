#!/usr/bin/env python3
"""Collect fresh live positions and infer conservative, provisional waiting points.

Requires BUS_TRACKING_TOKEN in the local environment. Only candidate-wait
summaries are written under analysis/private (ignored by Git); raw position
samples, API responses, device IDs and fingerprints are never written.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import math
import os
import re
import time
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

from stop_logic import (
    MAX_POSITION_AGE_SECONDS,
    MAX_SAMPLE_GAP_SECONDS,
    MAX_STATIONARY_SPEED_KMH,
    MIN_CANDIDATE_DWELL_SECONDS,
    MIN_CONTIGUOUS_DWELL_SECONDS,
    MIN_DISTINCT_FIXES,
    STATIONARY_RADIUS_METERS,
    StopDetector,
    parse_time,
)

BASE = "https://msilabus.malimspotter.dz"
TZ = ZoneInfo("Africa/Algiers")
OUT = Path(__file__).resolve().parents[1] / "analysis" / "private"
VISITS_FILE = OUT / "stop_visits.jsonl"
PROGRESS_FILE = OUT / "observation_progress.json"


def now_local() -> dt.datetime:
    return dt.datetime.now(TZ)


def iso(value: dt.datetime) -> str:
    return value.astimezone(TZ).isoformat(timespec="seconds")


def suffix_bus_number(device: dict) -> str:
    """Keep extracting the numeric suffix after '/' as before."""
    for field in ("uniqueId", "name", "id"):
        match = re.search(r"/\s*(\d+)\s*$", str(device.get(field) or ""))
        if match:
            return match.group(1)
    return "غير مصنف"


def traccar_speed_kmh(value) -> float:
    """Traccar API reports knots; use the same conversion as src/app.js."""
    raw = float(value or 0.0)
    if not math.isfinite(raw):
        raise ValueError("invalid speed")
    return max(0.0, raw * 1.852)


def get_json(path: str, token: str):
    request = urllib.request.Request(
        BASE + path,
        headers={
            "Accept": "application/json",
            "Authorization": "Bearer " + token,
            "User-Agent": "MsilaBusTracker-observation/2.0",
        },
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        return json.loads(response.read().decode("utf-8"))


def write_progress(manifest: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    temporary = PROGRESS_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(PROGRESS_FILE)


def persist_candidate(event: dict, visits_out) -> None:
    """Whitelist public-aggregate inputs; never persist an individual bus ID."""
    if event.get("classification") != "candidate_wait":
        return
    record = {
        "classification": "candidate_wait",
        "group": str(event["bus_number"]),
        "bus_number": str(event["bus_number"]),
        "lat": event["lat"],
        "lon": event["lon"],
        "arrival": iso(event["arrival"]),
        "departure": iso(event["departure"]),
        "dwell_seconds": event["dwell_seconds"],
        "samples": event["samples"],
        "max_gap_seconds": event["max_gap_seconds"],
    }
    visits_out.write(json.dumps(record, ensure_ascii=False) + "\n")
    visits_out.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minutes", type=float, default=60.0, help="نافذة الرصد بالدقائق (الافتراضي 60)")
    parser.add_argument("--interval", type=float, default=3.0, help="فاصل طلبات API بالثواني (الافتراضي 3)")
    args = parser.parse_args()
    if not math.isfinite(args.minutes) or args.minutes <= 0:
        parser.error("--minutes يجب أن يكون أكبر من صفر")
    if not math.isfinite(args.interval) or args.interval < 1:
        parser.error("--interval يجب أن يكون ثانية واحدة على الأقل")

    token = os.environ.get("BUS_TRACKING_TOKEN", "")
    if not token:
        raise SystemExit("BUS_TRACKING_TOKEN is required")

    OUT.mkdir(parents=True, exist_ok=True)
    actual_start = now_local()
    target_end = actual_start + dt.timedelta(minutes=args.minutes)
    detector = StopDetector()
    manifest = {
        "status": "running",
        "requested_start": iso(actual_start),
        "actual_start": iso(actual_start),
        "target_end": iso(target_end),
        "interval_requested_seconds": args.interval,
        "minimum_contiguous_dwell_seconds": MIN_CONTIGUOUS_DWELL_SECONDS,
        "minimum_dwell_seconds": MIN_CANDIDATE_DWELL_SECONDS,
        "minimum_distinct_fixes": MIN_DISTINCT_FIXES,
        "stationary_radius_m": STATIONARY_RADIUS_METERS,
        "maximum_consecutive_sample_gap_seconds": MAX_SAMPLE_GAP_SECONDS,
        "maximum_position_age_seconds": MAX_POSITION_AGE_SECONDS,
        "maximum_stationary_speed_kmh": MAX_STATIONARY_SPEED_KMH,
        "status_note": "الوقفة الأقصر من 45 ثانية تُصنّف كاحتمال إشارة/ازدحام ولا تُضاف كنقطة انتظار. لا تُقبل نقطة مرشحة إلا بعينات GPS مميزة وحديثة ومتتابعة؛ النقاط الافتراضية ليست محطات رسمية.",
        "successful_cycles": 0,
        "failed_cycles": 0,
        "first_success": None,
        "last_success": None,
        "mean_actual_cadence_seconds": None,
        "max_actual_cadence_seconds": None,
    }
    write_progress(manifest)

    cadences: list[float] = []
    last_success_mono = None
    cycle = 0
    next_due = time.monotonic()
    with VISITS_FILE.open("a", encoding="utf-8") as visits_out, concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        while now_local() < target_end:
            delay = next_due - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            cycle_started = time.monotonic()
            captured = now_local()
            cycle += 1
            devices_future = pool.submit(get_json, "/api/devices", token)
            positions_future = pool.submit(get_json, "/api/positions", token)
            try:
                devices = devices_future.result(timeout=14)
                positions = positions_future.result(timeout=14)
                if not isinstance(devices, list) or not isinstance(positions, list):
                    raise ValueError("unexpected response shape")

                positions_by_id = {}
                for position in positions:
                    if not isinstance(position, dict) or position.get("deviceId") is None:
                        continue
                    try:
                        lat = float(position.get("latitude"))
                        lon = float(position.get("longitude"))
                    except (TypeError, ValueError):
                        continue
                    fix = parse_time(position.get("fixTime") or position.get("deviceTime") or position.get("serverTime"))
                    if fix is None or not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
                        continue
                    device_id = position["deviceId"]
                    prior = positions_by_id.get(device_id)
                    if prior is None or fix >= prior[0]:
                        positions_by_id[device_id] = (fix, position)

                for device in devices:
                    if not isinstance(device, dict) or device.get("id") is None:
                        continue
                    located = positions_by_id.get(device["id"])
                    if not located:
                        continue
                    fix, position = located
                    try:
                        lat = float(position["latitude"])
                        lon = float(position["longitude"])
                        speed_kmh = traccar_speed_kmh(position.get("speed"))
                    except (TypeError, ValueError, KeyError):
                        continue
                    key = str(device["id"])
                    events = detector.ingest(
                        key=key,
                        bus_number=suffix_bus_number(device),
                        lat=lat,
                        lon=lon,
                        speed_kmh=speed_kmh,
                        captured_at=captured,
                        fix_at=fix,
                    )
                    for event in events:
                        if event["classification"] == "candidate_wait":
                            persist_candidate(event, visits_out)

                manifest["successful_cycles"] += 1
                manifest["first_success"] = manifest["first_success"] or iso(captured)
                manifest["last_success"] = iso(captured)
                if last_success_mono is not None:
                    cadences.append(cycle_started - last_success_mono)
                last_success_mono = cycle_started
            except Exception as error:
                manifest["failed_cycles"] += 1
                # Keep only an exception class; never retain response bodies or device details.
                manifest["last_error_type"] = type(error).__name__

            elapsed = max(0.0, (now_local() - actual_start).total_seconds())
            expected_slots = math.floor(elapsed / args.interval) + 1
            manifest["elapsed_wall_seconds"] = round(elapsed, 1)
            manifest["estimated_expected_cycles"] = expected_slots
            manifest["estimated_missed_cycles"] = max(0, expected_slots - manifest["successful_cycles"] - manifest["failed_cycles"])
            manifest["mean_actual_cadence_seconds"] = round(sum(cadences) / len(cadences), 3) if cadences else None
            manifest["max_actual_cadence_seconds"] = round(max(cadences), 3) if cadences else None
            manifest["detector_stats"] = dict(detector.stats)
            if cycle % 20 == 0:
                write_progress(manifest)
                print(
                    f"{iso(now_local())} cycles={cycle} ok={manifest['successful_cycles']} "
                    f"failed={manifest['failed_cycles']} candidate_waits={detector.stats['candidate_waits']}",
                    flush=True,
                )
            next_due += args.interval
            if next_due < time.monotonic() - args.interval:
                next_due = time.monotonic() + args.interval

        for event in detector.finish_all():
            if event["classification"] == "candidate_wait":
                persist_candidate(event, visits_out)

    end = now_local()
    manifest["status"] = "complete"
    manifest["actual_end"] = iso(end)
    manifest["coverage_seconds"] = round((end - actual_start).total_seconds(), 1)
    manifest["mean_actual_cadence_seconds"] = round(sum(cadences) / len(cadences), 3) if cadences else None
    manifest["max_actual_cadence_seconds"] = round(max(cadences), 3) if cadences else None
    manifest["detector_stats"] = dict(detector.stats)
    write_progress(manifest)
    print(json.dumps({
        "status": manifest["status"],
        "actual_start": manifest["actual_start"],
        "actual_end": manifest["actual_end"],
        "successful_cycles": manifest["successful_cycles"],
        "failed_cycles": manifest["failed_cycles"],
        "detector_stats": manifest["detector_stats"],
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
