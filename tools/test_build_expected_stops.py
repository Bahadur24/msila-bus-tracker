#!/usr/bin/env python3
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_expected_stops as builder


def candidate(second, *, bus="17", lat=35.71, lon=4.55):
    return {
        "classification": "candidate_wait", "bus_number": bus,
        "lat": lat, "lon": lon, "dwell_seconds": 45, "samples": 4,
        "max_gap_seconds": 15,
        "arrival": f"2026-10-31T12:{second:02d}:00+00:00",
        "departure": f"2026-10-31T12:{second:02d}:45+00:00",
    }


def baseline():
    return {"schema_version": 1, "status": "complete", "observation": {}, "stops": [{
        "label": "نقطة تاريخية", "lat": 35.7039, "lon": 4.5306,
        "groups": ["17"], "visits": 5, "mean_dwell_seconds": 20,
        "max_dwell_seconds": 30, "confidence": "أولية",
    }]}


class BuilderTests(unittest.TestCase):
    def test_only_verified_long_candidates_are_loaded_and_duplicates_are_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "visits.jsonl"
            legacy = {"lat": 35.71, "lon": 4.55, "dwell_seconds": 90, "samples": 30}
            short = dict(candidate(1), classification="probable_traffic_pause", dwell_seconds=20)
            overgap = dict(candidate(2), max_gap_seconds=21)
            rows = [legacy, short, overgap, candidate(3), candidate(3)]
            source.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
            visits, ignored = builder.load_verified_candidate_visits(source)
            self.assertEqual(len(visits), 1)
            self.assertEqual(ignored, 2)
            self.assertEqual(visits[0]["bus_number"], "17")
            self.assertIn("_event_key", visits[0])

    def test_new_point_requires_recurrence_and_private_keys_do_not_enter_public_data(self):
        visits = []
        for minute in (1, 2):
            item = candidate(minute)
            item.pop("classification")
            item["_event_key"] = builder.event_key(item)
            visits.append(item)
        single = builder.cluster_new_visits(visits[:1])
        stops, added, updated, applied = builder.merge_new_points([], single)
        self.assertEqual((stops, added, updated, applied), ([], 0, 0, set()))
        repeated = builder.cluster_new_visits(visits)
        stops, added, updated, applied = builder.merge_new_points([], repeated)
        self.assertEqual((len(stops), added, updated, len(applied)), (1, 1, 0, 2))
        self.assertEqual(stops[0]["confidence"], "أولية")
        self.assertNotIn("_event", json.dumps(stops))
        self.assertEqual(stops[0]["groups"], ["17"])

    def test_legacy_confidence_and_original_data_are_preserved(self):
        old = baseline()["stops"]
        point = {
            "lat": old[0]["lat"], "lon": old[0]["lon"], "groups": ["11"],
            "visits": 2, "mean_dwell_seconds": 45, "max_dwell_seconds": 45,
            "confidence": "متوسطة", "first_seen": None, "last_seen": None,
            "_event_keys": ["private-a", "private-b"],
        }
        stops, added, updated, applied = builder.merge_new_points(old, [point])
        self.assertEqual((added, updated), (0, 1))
        self.assertEqual(stops[0]["visits"], 7)
        self.assertEqual(stops[0]["confidence"], "أولية")
        self.assertEqual(stops[0]["groups"], ["11", "17"])
        self.assertEqual(old[0]["visits"], 5)
        self.assertEqual(old[0]["groups"], ["17"])
        self.assertEqual(applied, {"private-a", "private-b"})

    def test_full_merge_is_idempotent_and_pending_single_event_can_later_recur(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private = root / "private"
            private.mkdir()
            paths = {
                "OUTPUT": root / "expected_stops.json",
                "VISITS_FILE": private / "stop_visits.jsonl",
                "PROGRESS_FILE": private / "progress.json",
                "CHECKPOINT_FILE": private / "checkpoint.json",
                "TRANSACTION_FILE": private / "transaction.json",
            }
            paths["OUTPUT"].write_text(json.dumps(baseline()))
            paths["PROGRESS_FILE"].write_text(json.dumps({"status": "complete"}))
            paths["VISITS_FILE"].write_text(json.dumps(candidate(1)) + "\n")
            before = paths["OUTPUT"].read_bytes()
            with patch.multiple(builder, **paths), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
                self.assertEqual(paths["OUTPUT"].read_bytes(), before)
                with paths["VISITS_FILE"].open("a") as stream:
                    stream.write(json.dumps(candidate(2)) + "\n")
                builder.main()
                once = paths["OUTPUT"].read_bytes()
                self.assertEqual(len(json.loads(once)["stops"]), 2)
                self.assertNotIn(b'"_event_key', once)
                builder.main()
                self.assertEqual(paths["OUTPUT"].read_bytes(), once)
                checkpoint = json.loads(paths["CHECKPOINT_FILE"].read_text())
                self.assertEqual(len(checkpoint["applied_event_keys"]), 2)
                paths["CHECKPOINT_FILE"].unlink()
                with self.assertRaises(SystemExit):
                    builder.main()

    def test_interrupted_merge_recovers_checkpoint_without_reapplying_events(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "public.json"
            checkpoint = root / "private-checkpoint.json"
            transaction = root / "private-transaction.json"
            current = b'{"stops": []}\n'
            output.write_bytes(current)
            transaction.write_text(json.dumps({
                "input_sha256": "not-current",
                "output_sha256": hashlib.sha256(current).hexdigest(),
                "checkpoint": {"applied_event_keys": ["private-key"]},
            }))
            with patch.multiple(builder, OUTPUT=output, CHECKPOINT_FILE=checkpoint, TRANSACTION_FILE=transaction):
                builder.recover_merge()
            self.assertFalse(transaction.exists())
            self.assertEqual(json.loads(checkpoint.read_text())["applied_event_keys"], ["private-key"])
            self.assertEqual(output.read_bytes(), current)


if __name__ == "__main__":
    unittest.main(verbosity=2)
