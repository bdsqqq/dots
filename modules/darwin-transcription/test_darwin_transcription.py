import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import darwin_transcription as transcription


class DarwinTranscriptionTests(unittest.TestCase):
    def test_profile_spec_supports_alias(self):
        alias, path = transcription.parse_profile_spec("igor=/tmp/igor.json")
        self.assertEqual(alias, "igor")
        self.assertEqual(path, Path("/tmp/igor.json").resolve())

    def test_legacy_profile_is_explicitly_unpinned(self):
        with tempfile.TemporaryDirectory() as temporary:
            profile_path = Path(temporary) / "legacy.json"
            profile_path.write_text(
                json.dumps(
                    {
                        "name": "igor",
                        "kind": "speechbrain-ecapa-voxceleb-centroid",
                        "files": [{"embedding_dim": 192}],
                        "centroid": [1.0] + [0.0] * 191,
                    }
                )
            )
            profiles = transcription.load_profiles(
                [f"igor={profile_path}"],
                require_multiple=False,
            )
            self.assertEqual(
                profiles["igor"]["compatibility"],
                "legacy-unpinned",
            )

    def test_qc_preserves_unknown_segments(self):
        segments = [
            {
                "start": 0.0,
                "end": 0.5,
                "speaker": None,
                "text": "sim",
                "assignment_reason": "segment-too-short",
            },
            {
                "start": 1.0,
                "end": 2.0,
                "speaker": "igor",
                "text": "texto preservado",
                "assignment_reason": "confirmed",
            },
        ]
        qc = transcription.segment_qc(segments, 3.0, mode="mono")
        rendered = transcription.render_transcript(
            "fixture",
            Path("/tmp/input.opus"),
            segments,
            qc,
            {"whisper_cpp_version": "1.9.2"},
        )
        self.assertEqual(qc["unknown_segments"], 1)
        self.assertIn("**unknown**: sim", rendered)
        self.assertIn("**igor**: texto preservado", rendered)

    def test_qc_flags_sparse_and_unordered_transcripts(self):
        sparse = [
            {
                "start": 100.0,
                "end": 101.0,
                "speaker": "igor",
                "text": "um segundo",
            }
        ]
        sparse_qc = transcription.segment_qc(sparse, 3600.0, mode="tracks")
        self.assertTrue(sparse_qc["transcript_quality_risk"])
        self.assertEqual(sparse_qc["status"], "needs-review")
        short_sparse_qc = transcription.segment_qc(
            [
                {
                    "start": 29.0,
                    "end": 30.0,
                    "speaker": "igor",
                    "text": "um segundo",
                }
            ],
            59.0,
            mode="tracks",
        )
        self.assertTrue(short_sparse_qc["transcript_quality_risk"])

        unordered = [
            {"start": 5.0, "end": 6.0, "speaker": "igor", "text": "depois"},
            {"start": 1.0, "end": 2.0, "speaker": "igor", "text": "antes"},
        ]
        unordered_qc = transcription.segment_qc(unordered, 10.0, mode="tracks")
        self.assertFalse(unordered_qc["timestamp_ordered"])
        self.assertTrue(unordered_qc["transcript_quality_risk"])

    def test_qc_weights_unknown_speech_by_duration(self):
        segments = [
            {
                "start": 0.0,
                "end": 20.0,
                "speaker": None,
                "text": "unknown",
                "mean_token_probability": 0.9,
            }
        ]
        segments.extend(
            {
                "start": 20.0 + index * 4,
                "end": 24.0 + index * 4,
                "speaker": "igor",
                "text": f"known {index}",
                "mean_token_probability": 0.9,
            }
            for index in range(10)
        )
        qc = transcription.segment_qc(segments, 60.0, mode="mono")
        self.assertLess(qc["unknown_ratio"], 0.10)
        self.assertGreater(qc["unknown_duration_ratio"], 0.30)
        self.assertTrue(qc["transcript_quality_risk"])

        low_confidence_qc = transcription.segment_qc(
            [
                {
                    "start": 0.0,
                    "end": 60.0,
                    "speaker": "igor",
                    "text": "low confidence",
                    "mean_token_probability": 0.01,
                }
            ],
            60.0,
            mode="tracks",
        )
        self.assertEqual(low_confidence_qc["low_confidence_duration_ratio"], 1)
        self.assertTrue(low_confidence_qc["transcript_quality_risk"])

    def test_version_and_duration_validation(self):
        self.assertTrue(transcription.supported_whisper_version("1.9.2"))
        self.assertFalse(transcription.supported_whisper_version("1.8.7"))
        parser = transcription.build_parser()
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parser.parse_args(
                    [
                        "transcribe",
                        "mono",
                        "input.opus",
                        "--profile",
                        "a.json",
                        "--minimum-speaker-duration",
                        "0.5",
                    ]
                )

    def test_track_validation_rejects_non_audio_and_offsets(self):
        probe = {
            "streams": [
                {"index": 0, "codec_type": "video", "start_time": "0"},
                {"index": 1, "codec_type": "audio", "start_time": "1.2"},
                {"index": 2, "codec_type": "audio", "start_time": "0"},
            ]
        }
        with self.assertRaisesRegex(ValueError, "not audio"):
            transcription.parse_track_specs(["igor=0"], probe)
        with self.assertRaisesRegex(ValueError, "timeline alignment"):
            transcription.parse_track_specs(["igor=1"], probe)
        self.assertEqual(
            transcription.parse_track_specs(["igor=2"], probe),
            [("igor", 2)],
        )

    def test_completion_requires_matching_artifact_hashes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "segments.json").write_text("[]\n")
            completion = {
                "artifacts": transcription.artifact_hashes(root),
            }
            (root / "complete.json").write_text(json.dumps(completion))
            self.assertTrue(transcription.verify_complete(root))
            (root / "segments.json").write_text("[1]\n")
            self.assertFalse(transcription.verify_complete(root))


if __name__ == "__main__":
    unittest.main()
