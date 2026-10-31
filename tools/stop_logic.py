"""Conservative, privacy-minimizing dwell detection for future GPS samples.

Only in-memory samples are kept. Callers decide how to store accepted aggregate
candidate visits; raw coordinates are never written by this module.
"""
from __future__ import annotations

from datetime import datetime, timezone
from math import asin, cos, radians, sin, sqrt
from typing import Any

MIN_CONTIGUOUS_DWELL_SECONDS = 15.0
MIN_CANDIDATE_DWELL_SECONDS = 45.0
MIN_DISTINCT_FIXES = 4
STATIONARY_RADIUS_METERS = 50.0
MAX_SAMPLE_GAP_SECONDS = 20.0
MAX_POSITION_AGE_SECONDS = 90.0
MAX_FUTURE_SKEW_SECONDS = 5.0
MAX_STATIONARY_SPEED_KMH = 5.0


def parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        result = value
    elif value:
        try:
            result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    else:
        return None
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    radius = 6_371_000.0
    lat1, lon1 = radians(a[0]), radians(a[1])
    lat2, lon2 = radians(b[0]), radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * radius * asin(min(1.0, sqrt(h)))


class StopDetector:
    """Track bounded consecutive fixes and emit aggregate dwell events on breaks."""

    def __init__(self) -> None:
        self.active: dict[str, dict[str, Any]] = {}
        self.stats = {
            "duplicate_fixes": 0,
            "out_of_order_fixes": 0,
            "stale_or_invalid_fixes": 0,
            "long_gap_resets": 0,
            "radius_resets": 0,
            "speed_resets": 0,
            "probable_short_pauses": 0,
            "candidate_waits": 0,
            "discarded_short_sequences": 0,
        }

    def _start(self, key: str, bus_number: str, lat: float, lon: float,
               speed_kmh: float, fix_at: datetime) -> None:
        self.active[key] = {
            "bus_number": str(bus_number or "غير مصنف"),
            "start": fix_at,
            "last_fix": fix_at,
            "lat": lat,
            "lon": lon,
            "sum_lat": lat,
            "sum_lon": lon,
            "samples": 1,
            "max_gap_seconds": 0.0,
            "max_speed_kmh": speed_kmh,
        }

    def _finish(self, key: str) -> list[dict[str, Any]]:
        state = self.active.pop(key, None)
        if not state:
            return []
        dwell = max(0.0, (state["last_fix"] - state["start"]).total_seconds())
        if state["samples"] < MIN_DISTINCT_FIXES or dwell < MIN_CONTIGUOUS_DWELL_SECONDS:
            self.stats["discarded_short_sequences"] += 1
            return []
        classification = (
            "candidate_wait" if dwell >= MIN_CANDIDATE_DWELL_SECONDS
            else "probable_traffic_pause"
        )
        self.stats["candidate_waits" if classification == "candidate_wait" else "probable_short_pauses"] += 1
        return [{
            "bus_number": state["bus_number"],
            "lat": round(state["sum_lat"] / state["samples"], 6),
            "lon": round(state["sum_lon"] / state["samples"], 6),
            "arrival": state["start"],
            "departure": state["last_fix"],
            "dwell_seconds": round(dwell, 1),
            "samples": state["samples"],
            "max_gap_seconds": round(state["max_gap_seconds"], 1),
            "max_speed_kmh": round(state["max_speed_kmh"], 1),
            "classification": classification,
        }]

    def finish(self, key: str) -> list[dict[str, Any]]:
        """Close one active sequence, e.g. at the end of a collection window."""
        return self._finish(key)

    def finish_all(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for key in list(self.active):
            events.extend(self._finish(key))
        return events

    def ingest(self, key: str, bus_number: str, lat: float, lon: float,
               speed_kmh: float, captured_at: datetime | str,
               fix_at: datetime | str | None) -> list[dict[str, Any]]:
        """Consume one API observation; stale, invalid or moving fixes break continuity."""
        captured = parse_time(captured_at)
        fixed = parse_time(fix_at)
        valid = (
            captured is not None and fixed is not None
            and -90 <= lat <= 90 and -180 <= lon <= 180
            and not (lat == 0 and lon == 0)
            and speed_kmh >= 0
        )
        if not valid:
            self.stats["stale_or_invalid_fixes"] += 1
            return self._finish(key)
        age = (captured - fixed).total_seconds()
        if age > MAX_POSITION_AGE_SECONDS or age < -MAX_FUTURE_SKEW_SECONDS:
            self.stats["stale_or_invalid_fixes"] += 1
            return self._finish(key)
        if speed_kmh > MAX_STATIONARY_SPEED_KMH:
            self.stats["speed_resets"] += 1
            return self._finish(key)

        previous = self.active.get(key)
        if previous is None:
            self._start(key, bus_number, lat, lon, speed_kmh, fixed)
            return []

        gap = (fixed - previous["last_fix"]).total_seconds()
        if gap == 0:
            # Repeated API snapshots of the same GPS fix do not count as new evidence.
            self.stats["duplicate_fixes"] += 1
            return []
        if gap < 0:
            self.stats["out_of_order_fixes"] += 1
            events = self._finish(key)
            return events
        if gap > MAX_SAMPLE_GAP_SECONDS:
            self.stats["long_gap_resets"] += 1
            events = self._finish(key)
            self._start(key, bus_number, lat, lon, speed_kmh, fixed)
            return events
        if distance_m((previous["lat"], previous["lon"]), (lat, lon)) > STATIONARY_RADIUS_METERS:
            self.stats["radius_resets"] += 1
            events = self._finish(key)
            self._start(key, bus_number, lat, lon, speed_kmh, fixed)
            return events

        previous["max_gap_seconds"] = max(previous["max_gap_seconds"], gap)
        previous["sum_lat"] += lat
        previous["sum_lon"] += lon
        previous["samples"] += 1
        previous["last_fix"] = fixed
        previous["lat"] = previous["sum_lat"] / previous["samples"]
        previous["lon"] = previous["sum_lon"] / previous["samples"]
        previous["max_speed_kmh"] = max(previous["max_speed_kmh"], speed_kmh)
        return []
