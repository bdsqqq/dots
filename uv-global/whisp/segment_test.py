"""Tests for segment module."""

import pytest

from whisp.models import Word, SpeakerTurn
from whisp.segment import words_to_turns


class TestWordsToTurns:
    """Tests for words_to_turns function."""

    def test_empty_words_returns_empty(self):
        assert words_to_turns([]) == []

    def test_single_word_returns_single_turn(self):
        words = [Word("hello", 0.0, 0.5, "SPEAKER_00")]
        turns = words_to_turns(words)
        assert len(turns) == 1
        assert turns[0].speaker == "SPEAKER_00"
        assert turns[0].start_time == 0.0
        assert len(turns[0].words) == 1

    def test_same_speaker_continuous_speech(self):
        words = [
            Word("hello", 0.0, 0.5, "SPEAKER_00"),
            Word("world", 0.6, 1.0, "SPEAKER_00"),
            Word("test", 1.1, 1.5, "SPEAKER_00"),
        ]
        turns = words_to_turns(words)
        assert len(turns) == 1
        assert turns[0].speaker == "SPEAKER_00"
        assert len(turns[0].words) == 3

    def test_speaker_change_creates_new_turn(self):
        words = [
            Word("hello", 0.0, 0.5, "SPEAKER_00"),
            Word("hi", 0.6, 1.0, "SPEAKER_01"),
        ]
        turns = words_to_turns(words)
        assert len(turns) == 2
        assert turns[0].speaker == "SPEAKER_00"
        assert turns[1].speaker == "SPEAKER_01"

    def test_gap_exceeds_threshold_creates_new_turn(self):
        words = [
            Word("hello", 0.0, 0.5, "SPEAKER_00"),
            Word("pause", 3.0, 3.5, "SPEAKER_00"),
        ]
        turns = words_to_turns(words, gap_threshold=1.5)
        assert len(turns) == 2
        assert turns[0].speaker == "SPEAKER_00"
        assert turns[1].speaker == "SPEAKER_00"
        assert turns[0].start_time == 0.0
        assert turns[1].start_time == 3.0

    def test_gap_at_threshold_does_not_break(self):
        words = [
            Word("hello", 0.0, 0.5, "SPEAKER_00"),
            Word("world", 2.0, 2.5, "SPEAKER_00"),
        ]
        turns = words_to_turns(words, gap_threshold=1.5)
        assert len(turns) == 1

    def test_unknown_speaker_when_none(self):
        words = [
            Word("hello", 0.0, 0.5, None),
            Word("world", 0.6, 1.0, None),
        ]
        turns = words_to_turns(words)
        assert len(turns) == 1
        assert turns[0].speaker == "UNKNOWN"

    def test_unknown_groups_together(self):
        words = [
            Word("a", 0.0, 0.5, None),
            Word("b", 0.6, 1.0, None),
            Word("c", 1.1, 1.5, None),
        ]
        turns = words_to_turns(words)
        assert len(turns) == 1
        assert turns[0].speaker == "UNKNOWN"
        assert len(turns[0].words) == 3

    def test_mixed_speakers_and_gaps(self):
        words = [
            Word("a", 0.0, 0.5, "SPEAKER_00"),
            Word("b", 0.6, 1.0, "SPEAKER_00"),
            Word("c", 1.1, 1.5, "SPEAKER_01"),
            Word("d", 5.0, 5.5, "SPEAKER_01"),
            Word("e", 5.6, 6.0, "SPEAKER_00"),
        ]
        turns = words_to_turns(words, gap_threshold=1.5)
        assert len(turns) == 4
        assert [t.speaker for t in turns] == [
            "SPEAKER_00",
            "SPEAKER_01",
            "SPEAKER_01",
            "SPEAKER_00",
        ]

    def test_custom_gap_threshold(self):
        words = [
            Word("hello", 0.0, 0.5, "SPEAKER_00"),
            Word("world", 1.0, 1.5, "SPEAKER_00"),
        ]
        turns_default = words_to_turns(words, gap_threshold=1.5)
        turns_strict = words_to_turns(words, gap_threshold=0.3)
        assert len(turns_default) == 1
        assert len(turns_strict) == 2
