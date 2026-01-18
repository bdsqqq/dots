"""Integration tests for whisp end-to-end pipeline."""

from __future__ import annotations

import os
import tempfile
from datetime import datetime
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from whisp.cli import main
from whisp.models import Word


class MockDiarization:
    def __init__(self, tracks: list[tuple[float, float, str]]):
        self.tracks = tracks

    def itertracks(self, yield_label: bool = False):
        for start, end, label in self.tracks:
            segment = MagicMock()
            segment.start = start
            segment.end = end
            yield segment, None, label


@pytest.fixture
def audio_file(tmp_path):
    """Create a fake audio file for testing."""
    audio = tmp_path / "test-recording.mp3"
    audio.write_bytes(b"fake audio content")
    return audio


@pytest.fixture
def mock_pipeline():
    """Mock the entire ML pipeline."""
    with patch("whisp.validate.validate_ffmpeg_decodable"), \
         patch("whisp.transcribe_fw.transcribe") as transcribe, \
         patch("whisp.transcribe_fw.detect_device") as detect_device, \
         patch("whisp.transcribe_fw.get_default_model") as get_default_model, \
         patch("whisp.diarize_pyannote.diarize") as diarize:

        detect_device.return_value = "cpu"
        get_default_model.return_value = ("medium", "int8")

        transcribe.return_value = (
            [
                Word(text="Hello", start=0.0, end=0.5),
                Word(text="everyone", start=0.6, end=1.2),
                Word(text="welcome", start=2.0, end=2.5),
                Word(text="to", start=2.6, end=2.7),
                Word(text="the", start=2.8, end=2.9),
                Word(text="show", start=3.0, end=3.5),
            ],
            10.0,
        )

        diarize.return_value = MockDiarization([
            (0.0, 1.5, "SPEAKER_00"),
            (1.8, 5.0, "SPEAKER_01"),
        ])

        yield {
            "transcribe": transcribe,
            "diarize": diarize,
        }


class TestFullPipeline:
    def test_stdout_output(self, audio_file, mock_pipeline, capsys):
        result = main([str(audio_file)])

        assert result == 0
        captured = capsys.readouterr()
        output = captured.out

        assert "---" in output
        assert "source: ./test-recording.mp3" in output
        assert "duration: 10s" in output
        assert "SPEAKER_00" in output
        assert "SPEAKER_01" in output
        assert "Hello everyone" in output
        assert "welcome to the show" in output

    def test_file_output(self, audio_file, mock_pipeline, tmp_path):
        output_file = tmp_path / "transcript.md"
        result = main([str(audio_file), "-o", str(output_file)])

        assert result == 0
        assert output_file.exists()
        content = output_file.read_text()
        assert "# transcript: test-recording.mp3" in content

    def test_directory_output_uses_suggested_filename(self, audio_file, mock_pipeline, tmp_path):
        output_dir = tmp_path / "transcripts"
        output_dir.mkdir()

        result = main([str(audio_file), "-o", str(output_dir)])

        assert result == 0
        files = list(output_dir.iterdir())
        assert len(files) == 1
        assert "test-recording" in files[0].name
        assert "source__transcript.md" in files[0].name

    def test_single_speaker_mode(self, audio_file, mock_pipeline, capsys):
        result = main([str(audio_file), "-s", "1"])

        assert result == 0
        captured = capsys.readouterr()
        output = captured.out

        assert "speakers: []" in output
        assert "SPEAKER_00" not in output
        assert "SPEAKER_01" not in output
        mock_pipeline["diarize"].assert_not_called()

    def test_verbose_mode(self, audio_file, mock_pipeline, capsys):
        result = main([str(audio_file), "-v"])

        assert result == 0
        captured = capsys.readouterr()
        assert "processing:" in captured.err
        assert "complete:" in captured.err

    def test_suggest_filename(self, audio_file, mock_pipeline, capsys):
        result = main([str(audio_file), "--suggest-filename"])

        assert result == 0
        captured = capsys.readouterr()
        assert "test-recording" in captured.err
        assert "source__transcript.md" in captured.err


class TestGracefulDegradation:
    def test_diarization_failure_continues(self, audio_file, capsys):
        from whisp.errors import TranscriptionError

        with patch("whisp.validate.validate_ffmpeg_decodable"), \
             patch("whisp.transcribe_fw.transcribe") as transcribe, \
             patch("whisp.transcribe_fw.detect_device") as dd, \
             patch("whisp.transcribe_fw.get_default_model") as gdm, \
             patch("whisp.diarize_pyannote.diarize") as diarize:

            dd.return_value = "cpu"
            gdm.return_value = ("medium", "int8")
            transcribe.return_value = (
                [Word(text="test", start=0.0, end=0.5)],
                1.0,
            )
            diarize.side_effect = TranscriptionError("diarization failed")

            result = main([str(audio_file)])

            assert result == 0
            captured = capsys.readouterr()
            assert "UNKNOWN" in captured.out
            assert "warning:" in captured.err

    def test_hf_token_missing_continues(self, audio_file, capsys):
        from whisp.errors import HFTokenMissingError

        with patch("whisp.validate.validate_ffmpeg_decodable"), \
             patch("whisp.transcribe_fw.transcribe") as transcribe, \
             patch("whisp.transcribe_fw.detect_device") as dd, \
             patch("whisp.transcribe_fw.get_default_model") as gdm, \
             patch("whisp.diarize_pyannote.diarize") as diarize:

            dd.return_value = "cpu"
            gdm.return_value = ("medium", "int8")
            transcribe.return_value = (
                [Word(text="test", start=0.0, end=0.5)],
                1.0,
            )
            diarize.side_effect = HFTokenMissingError("no token")

            result = main([str(audio_file)])

            assert result == 0
            captured = capsys.readouterr()
            assert "UNKNOWN" in captured.out


class TestStrictMode:
    def test_strict_mode_fails_on_diarization_error(self, audio_file, capsys):
        from whisp.errors import TranscriptionError

        with patch("whisp.validate.validate_ffmpeg_decodable"), \
             patch("whisp.transcribe_fw.transcribe") as transcribe, \
             patch("whisp.transcribe_fw.detect_device") as dd, \
             patch("whisp.transcribe_fw.get_default_model") as gdm, \
             patch("whisp.diarize_pyannote.diarize") as diarize:

            dd.return_value = "cpu"
            gdm.return_value = ("medium", "int8")
            transcribe.return_value = (
                [Word(text="test", start=0.0, end=0.5)],
                1.0,
            )
            diarize.side_effect = TranscriptionError("diarization failed")

            result = main([str(audio_file), "--strict"])

            assert result == 30
            captured = capsys.readouterr()
            assert "error:" in captured.err


class TestErrorHandling:
    def test_missing_file_returns_exit_code(self, capsys):
        result = main(["/nonexistent/audio.mp3"])

        assert result == 10
        captured = capsys.readouterr()
        assert "error:" in captured.err
        assert "not found" in captured.err.lower()

    def test_unsupported_format(self, tmp_path, capsys):
        from whisp.errors import UnsupportedFormatError

        bad_file = tmp_path / "notaudio.txt"
        bad_file.write_text("not audio")

        with patch("whisp.validate.validate_ffmpeg_decodable") as vfd:
            vfd.side_effect = UnsupportedFormatError("unsupported format")

            result = main([str(bad_file)])

            assert result == 11
            captured = capsys.readouterr()
            assert "unsupported" in captured.err.lower()


class TestOutputFormat:
    def test_yaml_frontmatter_structure(self, audio_file, mock_pipeline, capsys):
        main([str(audio_file)])

        captured = capsys.readouterr()
        lines = captured.out.strip().split("\n")

        assert lines[0] == "---"
        frontmatter_end = lines.index("---", 1)
        assert frontmatter_end > 1

        frontmatter = "\n".join(lines[1:frontmatter_end])
        assert "source:" in frontmatter
        assert "duration:" in frontmatter
        assert "speakers:" in frontmatter
        assert "model:" in frontmatter
        assert "transcribed:" in frontmatter

    def test_header_format(self, audio_file, mock_pipeline, capsys):
        main([str(audio_file)])

        captured = capsys.readouterr()
        assert "# transcript: test-recording.mp3" in captured.out

    def test_speaker_turn_format(self, audio_file, mock_pipeline, capsys):
        main([str(audio_file)])

        captured = capsys.readouterr()
        assert "**[00:00]** SPEAKER_00:" in captured.out
        assert "**[00:02]** SPEAKER_01:" in captured.out
