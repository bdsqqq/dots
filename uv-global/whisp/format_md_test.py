"""Tests for format_md module."""

from datetime import datetime

import pytest
import yaml

from whisp.models import Word, SpeakerTurn, Transcript
from whisp.format_md import render


def make_transcript(
    turns: list[SpeakerTurn] | None = None,
    speakers: list[str] | None = None,
    duration: float = 300.0,
) -> Transcript:
    """Helper to create test transcripts."""
    return Transcript(
        source="/path/to/recording.m4a",
        duration=duration,
        speakers=speakers or [],
        model="large-v3",
        turns=turns or [],
        transcribed_at=datetime(2026, 1, 17, 14, 30, 0),
    )


class TestRenderFrontmatter:
    """Tests for YAML frontmatter rendering."""

    def test_frontmatter_is_valid_yaml(self):
        transcript = make_transcript(speakers=["SPEAKER_00", "SPEAKER_01"])
        result = render(transcript)
        frontmatter = result.split("---")[1]
        parsed = yaml.safe_load(frontmatter)
        assert parsed["source"] == "./recording.m4a"
        assert parsed["duration"] == "5m"
        assert parsed["speakers"] == ["SPEAKER_00", "SPEAKER_01"]
        assert parsed["model"] == "large-v3"

    def test_single_speaker_mode_empty_speakers(self):
        transcript = make_transcript(speakers=["SPEAKER_00"])
        result = render(transcript, single_speaker=True)
        frontmatter = result.split("---")[1]
        parsed = yaml.safe_load(frontmatter)
        assert parsed["speakers"] == []

    def test_transcribed_timestamp_format(self):
        transcript = make_transcript()
        result = render(transcript)
        assert "transcribed: 2026-01-17T14:30:00Z" in result


class TestRenderHeader:
    """Tests for header rendering."""

    def test_header_includes_filename(self):
        transcript = make_transcript()
        result = render(transcript)
        assert "# transcript: recording.m4a" in result


class TestRenderBody:
    """Tests for body rendering."""

    def test_empty_transcript_shows_silence(self):
        transcript = make_transcript()
        result = render(transcript)
        assert "[...silence]" in result

    def test_single_turn_multi_speaker(self):
        words = [
            Word("hello", 0.0, 0.5, "SPEAKER_00"),
            Word("world", 0.6, 1.0, "SPEAKER_00"),
        ]
        turn = SpeakerTurn("SPEAKER_00", 0.0, words)
        transcript = make_transcript(turns=[turn], speakers=["SPEAKER_00"])
        result = render(transcript)
        assert "**[00:00]** SPEAKER_00: hello world" in result

    def test_single_speaker_mode_no_labels(self):
        words = [Word("hello", 0.0, 0.5, "SPEAKER_00")]
        turn = SpeakerTurn("SPEAKER_00", 0.0, words)
        transcript = make_transcript(turns=[turn], speakers=["SPEAKER_00"])
        result = render(transcript, single_speaker=True)
        assert "**[00:00]** hello" in result
        assert "SPEAKER_00:" not in result

    def test_unknown_speaker_label_shown(self):
        words = [Word("orphan", 0.0, 0.5, None)]
        turn = SpeakerTurn("UNKNOWN", 0.0, words)
        transcript = make_transcript(turns=[turn], speakers=["UNKNOWN"])
        result = render(transcript)
        assert "**[00:00]** UNKNOWN: orphan" in result

    def test_multiple_turns_separated_by_blank_line(self):
        turn1 = SpeakerTurn("SPEAKER_00", 0.0, [Word("first", 0.0, 0.5)])
        turn2 = SpeakerTurn("SPEAKER_01", 14.0, [Word("second", 14.0, 14.5)])
        transcript = make_transcript(
            turns=[turn1, turn2],
            speakers=["SPEAKER_00", "SPEAKER_01"],
        )
        result = render(transcript)
        assert "**[00:00]** SPEAKER_00: first" in result
        assert "**[00:14]** SPEAKER_01: second" in result
        lines = result.split("\n")
        turn_indices = [i for i, line in enumerate(lines) if line.startswith("**")]
        assert len(turn_indices) == 2
        assert turn_indices[1] - turn_indices[0] == 2

    def test_long_audio_uses_hhmmss_format(self):
        words = [Word("late", 4805.0, 4806.0)]
        turn = SpeakerTurn("SPEAKER_00", 4805.0, words)
        transcript = make_transcript(turns=[turn], duration=7200.0)
        result = render(transcript)
        assert "**[01:20:05]**" in result


class TestRenderIntegration:
    """Integration tests for full render output."""

    def test_complete_multi_speaker_transcript(self):
        turns = [
            SpeakerTurn(
                "SPEAKER_00",
                0.0,
                [Word("hello", 0.0, 0.5, "SPEAKER_00")],
            ),
            SpeakerTurn(
                "SPEAKER_01",
                14.0,
                [
                    Word("hi", 14.0, 14.3, "SPEAKER_01"),
                    Word("there", 14.4, 14.8, "SPEAKER_01"),
                ],
            ),
        ]
        transcript = make_transcript(
            turns=turns,
            speakers=["SPEAKER_00", "SPEAKER_01"],
            duration=342.0,
        )
        result = render(transcript)

        assert "---" in result
        assert "source: ./recording.m4a" in result
        assert "duration: 5m 42s" in result
        assert "# transcript: recording.m4a" in result
        assert "**[00:00]** SPEAKER_00: hello" in result
        assert "**[00:14]** SPEAKER_01: hi there" in result
