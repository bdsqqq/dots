#!/usr/bin/env python3

import base64
import importlib.util
import json
import stat
import tempfile
import types
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("benchmark", Path(__file__).with_name("benchmark.py"))
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


class BenchmarkTest(unittest.TestCase):
    def test_sample_is_deterministic_stratified_and_keeps_judgments(self):
        rows = [
            {"asset_id": 1, "media_date": "2020-01-01"},
            {"asset_id": 2, "media_date": "2020-02-01"},
            {"asset_id": 3, "media_date": "2021-01-01"},
            {"asset_id": 4, "media_date": "2021-02-01"},
            {"asset_id": 5, "media_date": "2022-01-01"},
        ]
        queries = [{"id": "q", "text": "query", "relevantAssetIds": [2]}]
        first = benchmark.sample_assets(rows, queries, 4, 42)
        second = benchmark.sample_assets(list(reversed(rows)), queries, 4, 42)
        self.assertEqual(first, second)
        self.assertIn(2, first)
        years = {next(row["media_date"][:4] for row in rows if row["asset_id"] == item) for item in first}
        self.assertEqual(years, {"2020", "2021", "2022"})

    def test_sample_rejects_unknown_judgment(self):
        rows = [{"asset_id": 1, "media_date": "2020-01-01"}]
        queries = [{"id": "q", "text": "query", "relevantAssetIds": [9]}]
        with self.assertRaises(SystemExit):
            benchmark.sample_assets(rows, queries, 1, 42)

    def test_metrics_use_full_ranking(self):
        value = benchmark.metrics_for([8, 7, 6, 5], [5])
        self.assertTrue(value["successAt10"])
        self.assertEqual(value["reciprocalRank"], 0.25)

    def test_worker_response_must_partition_requested_tokens(self):
        vector = {
            "encoding": "f32le-base64",
            "dimensions": 1,
            "data": base64.b64encode(b"\0\0\0\0").decode(),
        }
        with self.assertRaisesRegex(ValueError, "partition"):
            benchmark.response_vectors(
                {"items": [{"token": "a", "vector": vector}]},
                ["a", "b"],
                allow_failures=True,
            )
        with self.assertRaisesRegex(ValueError, "duplicate"):
            benchmark.response_vectors(
                {"items": [
                    {"token": "a", "vector": vector},
                    {"token": "a", "vector": vector},
                ]},
                ["a"],
                allow_failures=True,
            )

    def test_vector_base64_is_strict(self):
        with self.assertRaisesRegex(ValueError, "base64"):
            benchmark.decoded_vector({
                "encoding": "f32le-base64",
                "dimensions": 1,
                "data": "AAAAAA!!",
            })

    def test_selection_gate(self):
        suite = {
            "assetIds": list(range(600)),
            "queries": [
                {"id": str(index), "text": "query", "relevantAssetIds": [index]}
                for index in range(20)
            ],
        }
        benchmark.validate_selection_suite(suite)
        suite["queries"][0]["relevantAssetIds"] = []
        with self.assertRaisesRegex(SystemExit, "no relevance"):
            benchmark.validate_selection_suite(suite)

    def test_descriptor_must_match_request(self):
        args = types.SimpleNamespace(model="remote/model", device="mps")
        descriptor = {
            "protocol": 1,
            "model": "remote/model",
            "revision": "a" * 40,
            "device": "mps",
            "dtype": "float32",
            "normalized": True,
            "cpuFallback": False,
        }
        benchmark.validate_descriptor(descriptor, args, "a" * 40)
        descriptor["normalized"] = False
        with self.assertRaisesRegex(RuntimeError, "normalized"):
            benchmark.validate_descriptor(descriptor, args, "a" * 40)

    def test_private_output_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary, "private")
            destination = directory / "result.json"
            benchmark.write_private(destination, {"safe": True})
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
            self.assertEqual(json.loads(destination.read_text()), {"safe": True})

    def test_worker_reports_early_exit(self):
        with tempfile.TemporaryDirectory() as temporary:
            worker_path = Path(temporary, "worker.py")
            worker_path.write_text("raise SystemExit(7)\n")
            args = types.SimpleNamespace(
                worker=str(worker_path),
                model="remote/model",
                device="cpu",
                offline=True,
            )
            worker = benchmark.Worker(args, "abc123")
            try:
                with self.assertRaisesRegex(RuntimeError, "worker exited"):
                    worker.request("describe")
            finally:
                worker.close()


if __name__ == "__main__":
    unittest.main()
