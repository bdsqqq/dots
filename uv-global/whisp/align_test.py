"""Tests for align module."""

from dataclasses import dataclass
from typing import Iterator

import pytest

from whisp.models import Word
from whisp.align import assign_speakers


@dataclass
class MockSegment:
    """Mock pyannote Segment."""

    start: float
    end: float


class MockDiarization:
    """Mock pyannote diarization result."""

    def __init__(self, tracks: list[tuple[float, float, str]]):
        self._tracks = tracks

    def itertracks(self, yield_label: bool = False) -> Iterator:
        for start, end, speaker in self._tracks:
            if yield_label:
                yield MockSegment(start, end), None, speaker
            else:
                yield MockSegment(start, end), None


class TestAssignSpeakers:
    """Tests for assign_speakers function."""

    def test_empty_words_returns_empty(self):
        diarization = MockDiarization([])
        assert assign_speakers([], diarization) == []

    def test_single_word_single_segment(self):
        words = [Word("hello", 0.5, 1.0)]
        diarization = MockDiarization([(0.0, 2.0, "SPEAKER_00")])
        result = assign_speakers(words, diarization)
        assert len(result) == 1
        assert result[0].speaker == "SPEAKER_00"
        assert result[0].text == "hello"

    def test_midpoint_assignment(self):
        words = [Word("word", 0.8, 1.2)]
        diarization = MockDiarization([
            (0.0, 1.0, "SPEAKER_00"),
            (1.0, 2.0, "SPEAKER_01"),
        ])
        result = assign_speakers(words, diarization)
        assert result[0].speaker == "SPEAKER_00"

    def test_word_straddles_segments(self):
        words = [Word("word", 0.5, 1.5)]
        diarization = MockDiarization([
            (0.0, 1.0, "SPEAKER_00"),
            (1.0, 2.0, "SPEAKER_01"),
        ])
        result = assign_speakers(words, diarization)
        assert result[0].speaker == "SPEAKER_00"

    def test_no_matching_segment_returns_unknown(self):
        words = [Word("orphan", 5.0, 5.5)]
        diarization = MockDiarization([(0.0, 2.0, "SPEAKER_00")])
        result = assign_speakers(words, diarization)
        assert result[0].speaker == "UNKNOWN"

    def test_multiple_words_multiple_speakers(self):
        words = [
            Word("hello", 0.5, 1.0),
            Word("there", 1.5, 2.0),
            Word("how", 3.5, 4.0),
        ]
        diarization = MockDiarization([
            (0.0, 2.5, "SPEAKER_00"),
            (3.0, 5.0, "SPEAKER_01"),
        ])
        result = assign_speakers(words, diarization)
        assert result[0].speaker == "SPEAKER_00"
        assert result[1].speaker == "SPEAKER_00"
        assert result[2].speaker == "SPEAKER_01"

    def test_preserves_word_data(self):
        words = [Word("test", 1.0, 1.5, speaker="OLD")]
        diarization = MockDiarization([(0.0, 2.0, "SPEAKER_00")])
        result = assign_speakers(words, diarization)
        assert result[0].text == "test"
        assert result[0].start == 1.0
        assert result[0].end == 1.5
        assert result[0].speaker == "SPEAKER_00"

    def test_does_not_mutate_original(self):
        original = Word("test", 1.0, 1.5)
        words = [original]
        diarization = MockDiarization([(0.0, 2.0, "SPEAKER_00")])
        result = assign_speakers(words, diarization)
        assert original.speaker is None
        assert result[0].speaker == "SPEAKER_00"

    def test_word_at_segment_boundary(self):
        words = [Word("boundary", 1.0, 1.2)]
        diarization = MockDiarization([(1.0, 2.0, "SPEAKER_00")])
        result = assign_speakers(words, diarization)
        assert result[0].speaker == "SPEAKER_00"

    def test_empty_diarization_all_unknown(self):
        words = [
            Word("a", 0.0, 0.5),
            Word("b", 1.0, 1.5),
        ]
        diarization = MockDiarization([])
        result = assign_speakers(words, diarization)
        assert all(w.speaker == "UNKNOWN" for w in result)
