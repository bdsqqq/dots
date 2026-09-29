import unittest

from acquire import normalize, stamp


class CaptionTests(unittest.TestCase):
    def test_preserves_words_and_event_start(self):
        events = [{"tStartMs": 1200, "segs": [
            {"utf8": "hello"}, {"utf8": " world", "tOffsetMs": 200},
        ]}]
        self.assertEqual(normalize(events), [(1.2, "hello world")])

    def test_ignores_display_and_blank_events(self):
        self.assertEqual(normalize([
            {"tStartMs": 0, "wWinId": 1},
            {"tStartMs": 100, "segs": [{"utf8": "\n"}]},
        ]), [])

    def test_normalizes_whitespace_not_spelling(self):
        self.assertEqual(normalize([{
            "tStartMs": 2000, "segs": [{"utf8": " Poteeto\n  skills "}]
        }]), [(2.0, "Poteeto skills")])

    def test_keeps_repetition_as_source_evidence(self):
        self.assertEqual(normalize([
            {"tStartMs": 0, "segs": [{"utf8": "yes"}]},
            {"tStartMs": 1000, "segs": [{"utf8": "yes"}]},
        ]), [(0.0, "yes"), (1.0, "yes")])

    def test_stamp_floors_fractional_start(self):
        self.assertEqual(stamp(3661.9), "01:01:01")

    def test_missing_text_segment_does_not_destroy_words(self):
        self.assertEqual(normalize([{
            "tStartMs": 0, "segs": [{"utf8": "one"}, {"acAsrConf": 0}]
        }]), [(0.0, "one")])


if __name__ == "__main__":
    unittest.main()
