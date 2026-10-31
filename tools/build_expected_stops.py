#!/usr/bin/env python3
"""Merge new conservative candidate-wait aggregates into public expected stops.

Historical points remain published aggregates: their consecutive raw GPS samples
are unavailable. Private application checkpoints prevent replaying new events.
No event/device identifiers, checkpoint hashes or raw samples enter public JSON.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / "analysis" / "private"
OUTPUT = ROOT / "expected_stops.json"
VISITS_FILE = PRIVATE / "stop_visits.jsonl"
PROGRESS_FILE = PRIVATE / "observation_progress.json"
CHECKPOINT_FILE = PRIVATE / "expected_stops_checkpoint.json"
TRANSACTION_FILE = PRIVATE / "expected_stops_pending_merge.json"
MERGE_RADIUS_M = 100.0
MAX_SAMPLE_GAP_S = 20.0
MIN_CANDIDATE_DWELL_S = 45.0
MIN_DISTINCT_SAMPLES = 4


def distance(a: dict, b: dict) -> float:
    radius = 6_371_000.0
    p1, p2 = math.radians(float(a["lat"])), math.radians(float(b["lat"]))
    dp = math.radians(float(b["lat"]) - float(a["lat"]))
    dl = math.radians(float(b["lon"]) - float(a["lon"]))
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(min(1.0, h)))


def parse_time(value):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError):
        return None


def group_key(value: str):
    if value == "غير مصنف":
        return (2, 0, value)
    if value.isdigit():
        return (0, int(value), value)
    return (1, 0, value)


def confidence_for(visits: int, number_count: int) -> str:
    if visits >= 5 and number_count >= 2:
        return "مرتفعة"
    if visits >= 3 or number_count >= 2:
        return "متوسطة"
    return "أولية"


def event_key(item: dict) -> str:
    canonical = {key: value for key, value in item.items() if not key.startswith("_")}
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_verified_candidate_visits(path: Path) -> tuple[list[dict], int]:
    accepted: list[dict] = []
    ignored_legacy = 0
    seen = set()
    if not path.exists():
        return accepted, 0
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            item = json.loads(line)
            if item.get("classification") != "candidate_wait":
                ignored_legacy += 1
                continue
            lat, lon = float(item["lat"]), float(item["lon"])
            dwell = float(item.get("dwell_seconds", 0))
            samples = int(item.get("samples", 0))
            gap = float(item["max_gap_seconds"])
            number = str(item.get("bus_number") or item.get("group") or "غير مصنف").strip()
            if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
                continue
            if not (dwell >= MIN_CANDIDATE_DWELL_S and samples >= MIN_DISTINCT_SAMPLES and 0 <= gap <= MAX_SAMPLE_GAP_S):
                continue
            if not (number.isdigit() and len(number) <= 4):
                number = "غير مصنف"
            safe = {
                "lat": lat, "lon": lon, "bus_number": number,
                "dwell_seconds": dwell, "samples": samples,
                "arrival": item.get("arrival") if parse_time(item.get("arrival")) else None,
                "departure": item.get("departure") if parse_time(item.get("departure")) else None,
                "max_gap_seconds": gap,
            }
            key = event_key(safe)
            if key in seen:
                continue
            seen.add(key)
            safe["_event_key"] = key  # private processing only; never serialized publicly
            accepted.append(safe)
        except (ValueError, KeyError, TypeError):
            continue
    return accepted, ignored_legacy


def cluster_new_visits(visits: list[dict]) -> list[dict]:
    """Group new visits within 100m without transitive chaining."""
    clusters: list[list[dict]] = []
    for visit in visits:
        eligible = [cluster for cluster in clusters if all(distance(visit, member) <= MERGE_RADIUS_M for member in cluster)]
        if eligible:
            def center_distance(cluster):
                center = {
                    "lat": sum(member["lat"] for member in cluster) / len(cluster),
                    "lon": sum(member["lon"] for member in cluster) / len(cluster),
                }
                return distance(visit, center)
            min(eligible, key=center_distance).append(visit)
        else:
            clusters.append([visit])

    result = []
    for members in clusters:
        numbers = sorted({member["bus_number"] for member in members}, key=group_key)
        numeric_count = sum(number.isdigit() for number in numbers)
        dwells = [member["dwell_seconds"] for member in members]
        starts = [member["arrival"] for member in members if member.get("arrival")]
        ends = [member["departure"] for member in members if member.get("departure")]
        result.append({
            "lat": sum(member["lat"] for member in members) / len(members),
            "lon": sum(member["lon"] for member in members) / len(members),
            "groups": numbers, "visits": len(members),
            "mean_dwell_seconds": round(sum(dwells) / len(dwells), 1),
            "max_dwell_seconds": round(max(dwells), 1),
            "confidence": confidence_for(len(members), numeric_count),
            "first_seen": min(starts, key=parse_time) if starts else None,
            "last_seen": max(ends, key=parse_time) if ends else None,
            "_event_keys": [member["_event_key"] for member in members],
        })
    return result


def merge_new_points(existing: list[dict], new_points: list[dict]) -> tuple[list[dict], int, int, set[str]]:
    """Retain legacy confidence; only newly sampled points can gain new confidence."""
    merged = [dict(stop) for stop in existing]
    added = 0
    updated = 0
    applied_keys: set[str] = set()
    for point in new_points:
        eligible = [stop for stop in merged if distance(point, stop) <= MERGE_RADIUS_M]
        if eligible:
            host = min(eligible, key=lambda stop: distance(point, stop))
            old_visits = max(0, int(host.get("visits", 0) or 0))
            new_visits = int(point["visits"])
            old_mean = max(0.0, float(host.get("mean_dwell_seconds", 0) or 0))
            host["visits"] = old_visits + new_visits
            host["mean_dwell_seconds"] = round((old_mean * old_visits + float(point["mean_dwell_seconds"]) * new_visits) / max(1, old_visits + new_visits), 1)
            host["max_dwell_seconds"] = round(max(float(host.get("max_dwell_seconds", 0) or 0), float(point["max_dwell_seconds"])), 1)
            numbers = set(str(x) for x in host.get("groups", [])) | set(str(x) for x in point.get("groups", []))
            host["groups"] = sorted(numbers, key=group_key)
            host["verified_new_visits"] = int(host.get("verified_new_visits", 0) or 0) + new_visits
            for field, choose in (("first_seen", min), ("last_seen", max)):
                values = [value for value in (host.get(field), point.get(field)) if parse_time(value)]
                if values:
                    host[field] = choose(values, key=parse_time)
            if host.get("evidence_type") == "consecutive_future_samples":
                host["confidence"] = confidence_for(host["verified_new_visits"], sum(number.isdigit() for number in numbers))
            # Historical confidence is deliberately not upgraded without raw fixes.
            applied_keys.update(point.get("_event_keys", []))
            updated += 1
            continue

        numeric_count = sum(str(number).isdigit() for number in point.get("groups", []))
        if int(point.get("visits", 0)) < 2 and numeric_count < 2:
            # Keep this event private/unapplied so a later repeated visit can confirm it.
            continue
        stop = {key: value for key, value in point.items() if not key.startswith("_")}
        stop["lat"] = round(float(point["lat"]), 5)
        stop["lon"] = round(float(point["lon"]), 5)
        stop["verified_new_visits"] = int(point["visits"])
        stop["evidence_type"] = "consecutive_future_samples"
        stop["label"] = f"نقطة افتراضية {len(merged) + 1:02d}"
        merged.append(stop)
        applied_keys.update(point.get("_event_keys", []))
        added += 1
    return merged, added, updated, applied_keys


def json_text(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def recover_merge() -> None:
    """Reconcile an interrupted two-file merge before considering any event again."""
    if not TRANSACTION_FILE.exists():
        return
    transaction = json.loads(TRANSACTION_FILE.read_text(encoding="utf-8"))
    current_digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    if current_digest == transaction["output_sha256"]:
        atomic_write(CHECKPOINT_FILE, json_text(transaction["checkpoint"]))
    elif current_digest != transaction["input_sha256"]:
        raise SystemExit("Public dataset changed during an interrupted merge; refusing to replay events")
    TRANSACTION_FILE.unlink()


def main() -> None:
    if not PROGRESS_FILE.exists():
        raise SystemExit("No observation manifest found; collect a complete fresh window first")
    if not OUTPUT.exists():
        raise SystemExit("Refusing to rebuild without the currently published aggregate dataset")
    recover_merge()
    manifest = json.loads(PROGRESS_FILE.read_text(encoding="utf-8"))
    if manifest.get("status") != "complete":
        raise SystemExit("Refusing to merge an incomplete observation window")
    input_bytes = OUTPUT.read_bytes()
    public_data = json.loads(input_bytes)
    if not isinstance(public_data.get("stops"), list):
        raise SystemExit("Refusing to merge: current public stop data is invalid")
    checkpoint = json.loads(CHECKPOINT_FILE.read_text(encoding="utf-8")) if CHECKPOINT_FILE.exists() else {}
    last_run = public_data.get("observation", {}).get("latest_conservative_run", {})
    if not checkpoint and int(last_run.get("candidate_visits_applied", 0) or 0) > 0:
        raise SystemExit("Private merge checkpoint is missing; refusing to replay already published candidates")
    already_applied = set(checkpoint.get("applied_event_keys", []))
    all_visits, ignored_legacy = load_verified_candidate_visits(VISITS_FILE)
    visits = [visit for visit in all_visits if visit["_event_key"] not in already_applied]
    new_points = cluster_new_visits(visits)
    baseline_count = len(public_data["stops"])
    stops, added, updated, applied_now = merge_new_points(public_data["stops"], new_points)
    if not applied_now:
        print(json.dumps({
            "status": "unchanged", "historical_dataset_unchanged": True,
            "unapplied_candidate_visits": len(visits), "legacy_events_ignored": ignored_legacy,
        }, ensure_ascii=False))
        return

    observation = public_data.setdefault("observation", {})
    observation["latest_conservative_run"] = {
        "actual_start": manifest.get("actual_start"), "actual_end": manifest.get("actual_end"),
        "successful_cycles": manifest.get("successful_cycles"), "failed_cycles": manifest.get("failed_cycles"),
        "mean_actual_cadence_seconds": manifest.get("mean_actual_cadence_seconds"),
        "max_actual_cadence_seconds": manifest.get("max_actual_cadence_seconds"),
        "detector_stats": manifest.get("detector_stats", {}),
        "candidate_visits_considered": len(visits), "candidate_visits_applied": len(applied_now),
        "pending_candidate_visits": len(visits) - len(applied_now),
        "new_points_added": added, "existing_points_updated_from_aggregates": updated,
        "existing_points_reprocessed_from_raw_gps": False, "legacy_event_records_ignored": ignored_legacy,
    }
    observation["new_detection_method"] = (
        "التحديثات الجديدة فقط: داخل 50 م، و4 إصلاحات GPS متميزة، و15 ثانية متصلة على الأقل، "
        "وفجوة ≤20 ثانية، وعمر موقع ≤90 ثانية، وسرعة ≤5 كم/س؛ لا يُرشح انتظار إلا بعد 45 ثانية، "
        "ولا تُضاف نقطة جديدة إلا بتكرار الرصد أو رقمَي حافلتين. الوقفات الأقصر احتمال إشارة/ازدحام."
    )
    observation["historical_raw_samples_available"] = False
    observation["existing_points_reprocessed_from_raw_gps"] = False
    public_data["stops"] = stops
    public_data["notice"] = str(public_data.get("notice", "")).strip()
    if "عينات GPS الخام المتتابعة غير متاحة" not in public_data["notice"]:
        public_data["notice"] += " النقاط التاريخية حُفظت من ملخصات مجمعة ولم تُعَد معالجتها؛ عينات GPS الخام المتتابعة غير متاحة. طُبق الكشف الأشد على الزيارات الجديدة فقط، وبقيت الثقة التاريخية كما هي."
    public_data["schema_version"] = max(1, int(public_data.get("schema_version", 1) or 1))
    output_text = json_text(public_data)
    next_checkpoint = {"applied_event_keys": sorted(already_applied | applied_now)}
    transaction = {
        "input_sha256": hashlib.sha256(input_bytes).hexdigest(),
        "output_sha256": hashlib.sha256(output_text.encode("utf-8")).hexdigest(),
        "checkpoint": next_checkpoint,
    }
    atomic_write(TRANSACTION_FILE, json_text(transaction))
    atomic_write(OUTPUT, output_text)
    atomic_write(CHECKPOINT_FILE, json_text(next_checkpoint))
    TRANSACTION_FILE.unlink()
    print(json.dumps({
        "output": str(OUTPUT), "existing_points_retained": baseline_count,
        "new_points_added": added, "existing_points_updated_from_aggregates": updated,
        "new_candidate_visits_applied": len(applied_now),
        "pending_candidate_visits": len(visits) - len(applied_now),
        "legacy_events_ignored": ignored_legacy,
        "historical_raw_samples_available": False, "existing_points_reprocessed_from_raw_gps": False,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
