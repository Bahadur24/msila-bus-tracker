#!/usr/bin/env python3
from datetime import datetime, timedelta, timezone
import io
import json
import unittest

from observe_stops import persist_candidate, traccar_speed_kmh
from stop_logic import StopDetector

BASE = datetime(2026, 10, 31, 12, 0, 0, tzinfo=timezone.utc)
LAT, LON = 35.7039, 4.5306


def feed(detector, offsets, *, position=None, speed=0.0):
    events = []
    for index, seconds in enumerate(offsets):
        lat, lon = position(index) if position else (LAT, LON)
        fix = BASE + timedelta(seconds=seconds)
        events.extend(detector.ingest(
            "private-test-key", "17", lat, lon, speed,
            captured_at=fix, fix_at=fix,
        ))
    return events


class StopLogicTests(unittest.TestCase):
    def test_jitter_is_tolerated_and_long_dwell_becomes_candidate(self):
        detector = StopDetector()
        jitter = [(LAT + ((i % 3) - 1) * 0.00007, LON + ((i % 2) - 0.5) * 0.00005) for i in range(16)]
        events = feed(detector, range(0, 46, 3), position=lambda i: jitter[i])
        events += detector.finish("private-test-key")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["classification"], "candidate_wait")
        self.assertEqual(events[0]["samples"], 16)
        self.assertEqual(events[0]["dwell_seconds"], 45)
        self.assertEqual(events[0]["bus_number"], "17")

    def test_brief_pause_is_classified_but_not_as_waiting_candidate(self):
        detector = StopDetector()
        events = feed(detector, range(0, 25, 3))
        moving = BASE + timedelta(seconds=28)
        events += detector.ingest("private-test-key", "17", LAT, LON, 18, moving, moving)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["classification"], "probable_traffic_pause")
        self.assertEqual(detector.stats["probable_short_pauses"], 1)
        self.assertEqual(detector.stats["candidate_waits"], 0)

    def test_stale_position_breaks_the_sequence(self):
        detector = StopDetector()
        feed(detector, [0, 3, 6])
        capture = BASE + timedelta(seconds=200)
        events = detector.ingest("private-test-key", "17", LAT, LON, 0, capture, BASE + timedelta(seconds=6))
        events += detector.ingest("private-test-key", "17", LAT, LON, 0, capture, capture)
        events += detector.finish("private-test-key")
        self.assertEqual(events, [])
        self.assertEqual(detector.stats["stale_or_invalid_fixes"], 1)

    def test_long_gap_closes_candidate_and_starts_a_new_sequence(self):
        detector = StopDetector()
        events = feed(detector, range(0, 46, 3))
        later = BASE + timedelta(seconds=90)
        events += detector.ingest("private-test-key", "17", LAT, LON, 0, later, later)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["dwell_seconds"], 45)
        self.assertEqual(detector.stats["long_gap_resets"], 1)
        self.assertEqual(detector.active["private-test-key"]["start"], later)
        self.assertEqual(detector.finish("private-test-key"), [])

    def test_duplicate_fix_time_is_not_counted_as_an_extra_sample(self):
        detector = StopDetector()
        detector.ingest("private-test-key", "17", LAT, LON, 0, BASE, BASE)
        for captured_offset in (3, 6):
            detector.ingest("private-test-key", "17", LAT, LON, 0, BASE + timedelta(seconds=captured_offset), BASE)
        self.assertEqual(detector.active["private-test-key"]["samples"], 1)
        self.assertEqual(detector.stats["duplicate_fixes"], 2)

    def test_out_of_radius_jitter_resets_the_sequence(self):
        detector = StopDetector()
        feed(detector, [0, 3, 6, 9, 12])
        moved = BASE + timedelta(seconds=15)
        events = detector.ingest("private-test-key", "17", LAT + 0.001, LON, 0, moved, moved)
        self.assertEqual(events, [])
        self.assertEqual(detector.stats["radius_resets"], 1)
        self.assertEqual(detector.active["private-test-key"]["samples"], 1)

    def test_exact_four_fix_and_dwell_boundaries(self):
        brief = StopDetector()
        feed(brief, [0, 5, 10, 15])
        event = brief.finish("private-test-key")[0]
        self.assertEqual((event["samples"], event["dwell_seconds"], event["classification"]), (4, 15, "probable_traffic_pause"))
        waiting = StopDetector()
        feed(waiting, [0, 15, 30, 45])
        event = waiting.finish("private-test-key")[0]
        self.assertEqual((event["samples"], event["dwell_seconds"], event["classification"]), (4, 45, "candidate_wait"))

    def test_freshness_and_future_skew_boundaries(self):
        accepted = StopDetector()
        accepted.ingest("age", "17", LAT, LON, 0, BASE + timedelta(seconds=90), BASE)
        accepted.ingest("future", "17", LAT, LON, 0, BASE, BASE + timedelta(seconds=5))
        self.assertIn("age", accepted.active)
        self.assertIn("future", accepted.active)
        rejected = StopDetector()
        rejected.ingest("age", "17", LAT, LON, 0, BASE + timedelta(seconds=90.1), BASE)
        rejected.ingest("future", "17", LAT, LON, 0, BASE, BASE + timedelta(seconds=5.1))
        self.assertEqual(rejected.active, {})
        self.assertEqual(rejected.stats["stale_or_invalid_fixes"], 2)

    def test_speed_threshold_and_knots_conversion(self):
        self.assertAlmostEqual(traccar_speed_kmh(1), 1.852)
        self.assertAlmostEqual(traccar_speed_kmh(10), 18.52)
        detector = StopDetector()
        feed(detector, [0, 5, 10, 15], speed=5.0)
        self.assertEqual(detector.finish("private-test-key")[0]["dwell_seconds"], 15)
        detector.ingest("fast", "17", LAT, LON, 5.01, BASE, BASE)
        self.assertNotIn("fast", detector.active)

    def test_exact_twenty_second_gaps_are_allowed_but_larger_gaps_break(self):
        detector = StopDetector()
        feed(detector, [0, 20, 40, 60])
        event = detector.finish("private-test-key")[0]
        self.assertEqual(event["max_gap_seconds"], 20)
        reset = StopDetector()
        feed(reset, [0, 20.1, 40.2, 60.3])
        self.assertEqual(reset.finish("private-test-key"), [])
        self.assertEqual(reset.stats["long_gap_resets"], 3)

    def test_out_of_order_fix_does_not_start_an_overlapping_sequence(self):
        detector = StopDetector()
        feed(detector, [0, 15, 30, 45])
        events = detector.ingest("private-test-key", "17", LAT, LON, 0, BASE + timedelta(seconds=46), BASE + timedelta(seconds=42))
        self.assertEqual(events[0]["dwell_seconds"], 45)
        self.assertNotIn("private-test-key", detector.active)
        self.assertEqual(detector.stats["out_of_order_fixes"], 1)

    def test_probable_pause_is_never_persisted_and_candidates_are_whitelisted(self):
        brief = StopDetector()
        feed(brief, [0, 5, 10, 15])
        output = io.StringIO()
        persist_candidate(brief.finish("private-test-key")[0], output)
        self.assertEqual(output.getvalue(), "")
        waiting = StopDetector()
        feed(waiting, [0, 15, 30, 45])
        event = waiting.finish("private-test-key")[0]
        event["device_id"] = "not-for-storage"
        event["raw_positions"] = ["not-for-storage"]
        persist_candidate(event, output)
        stored = json.loads(output.getvalue())
        self.assertEqual(stored["classification"], "candidate_wait")
        self.assertNotIn("device_id", stored)
        self.assertNotIn("raw_positions", stored)


if __name__ == "__main__":
    unittest.main(verbosity=2)
