"""Tests for whisp.app orchestration module."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

from whisp.app import run, Options, _try_diarize, _mark_unknown, _extract_speakers
from whisp.models import Word, SpeakerTurn, Transcript
from whisp.errors import (
    FileNotFoundError,
    UnsupportedFormatError,
    ModelLoadError,
    TranscriptionError,
    HFTokenMissingError,
)


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
def mock_validate():
    with patch("whisp.validate.validate_file_exists") as vfe, \
         patch("whisp.validate.validate_ffmpeg_decodable") as vfd:
        vfe.return_value = Path("/audio/test.mp3")
        yield vfe, vfd


@pytest.fixture
def mock_transcribe():
    with patch("whisp.transcribe_fw.transcribe") as t, \
         patch("whisp.transcribe_fw.detect_device") as dd, \
         patch("whisp.transcribe_fw.get_default_model") as gdm:
        dd.return_value = "cpu"
        gdm.return_value = ("medium", "int8")
        t.return_value = (
            [
                Word(text="hello", start=0.0, end=0.5),
                Word(text="world", start=0.6, end=1.0),
            ],
            5.0,
        )
        yield t


@pytest.fixture
def mock_diarize():
    with patch("whisp.diarize_pyannote.diarize") as d:
        d.return_value = MockDiarization([
            (0.0, 0.7, "SPEAKER_00"),
            (0.7, 2.0, "SPEAKER_01"),
        ])
        yield d


@pytest.fixture
def mock_filename():
    with patch("whisp.filename.get_source_timestamp") as gst, \
         patch("whisp.filename.make_output_filename") as mof:
        gst.return_value = datetime(2025, 1, 15, 10, 30)
        mof.return_value = "2025-01-15T10-30 test -- source__transcript.md"
        yield gst, mof


class TestRun:
    def test_full_pipeline_with_diarization(
        self, mock_validate, mock_transcribe, mock_diarize, mock_filename
    ):
        markdown, filename = run("/audio/test.mp3")

        assert "# transcript: test.mp3" in markdown
        assert "2025-01-15T10-30" in filename
        mock_diarize.assert_called_once()

    def test_full_pipeline_returns_tuple(
        self, mock_validate, mock_transcribe, mock_diarize, mock_filename
    ):
        result = run("/audio/test.mp3")

        assert isinstance(result, tuple)
        assert len(result) == 2
        markdown, filename = result
        assert isinstance(markdown, str)
        assert isinstance(filename, str)

    def test_single_speaker_mode_skips_diarization(
        self, mock_validate, mock_transcribe, mock_diarize, mock_filename
    ):
        options = Options(speakers=1)
        markdown, _ = run("/audio/test.mp3", options)

        mock_diarize.assert_not_called()
        assert "speakers: []" in markdown

    def test_verbose_mode_prints_to_stderr(
        self, mock_validate, mock_transcribe, mock_diarize, mock_filename, capsys
    ):
        options = Options(verbose=True)
        run("/audio/test.mp3", options)

        captured = capsys.readouterr()
        assert "processing:" in captured.err
        assert "complete:" in captured.err

    def test_passes_model_option_to_transcribe(
        self, mock_validate, mock_transcribe, mock_diarize, mock_filename
    ):
        options = Options(model="large-v3")
        run("/audio/test.mp3", options)

        mock_transcribe.assert_called_once()
        _, kwargs = mock_transcribe.call_args
        assert kwargs["model"] == "large-v3"

    def test_passes_language_option_to_transcribe(
        self, mock_validate, mock_transcribe, mock_diarize, mock_filename
    ):
        options = Options(language="es")
        run("/audio/test.mp3", options)

        mock_transcribe.assert_called_once()
        _, kwargs = mock_transcribe.call_args
        assert kwargs["language"] == "es"

    def test_passes_speakers_hint_to_diarize(
        self, mock_validate, mock_transcribe, mock_diarize, mock_filename
    ):
        options = Options(speakers=3)
        run("/audio/test.mp3", options)

        mock_diarize.assert_called_once()
        _, kwargs = mock_diarize.call_args
        assert kwargs["speakers_hint"] == 3


class TestGracefulDegradation:
    def test_diarization_failure_continues_with_warning(
        self, mock_validate, mock_transcribe, mock_filename, capsys
    ):
        with patch("whisp.diarize_pyannote.diarize") as d:
            d.side_effect = TranscriptionError("diarization failed")

            markdown, _ = run("/audio/test.mp3")

            assert "UNKNOWN" in markdown
            captured = capsys.readouterr()
            assert "warning:" in captured.err
            assert "continuing without diarization" in captured.err

    def test_hf_token_missing_continues_with_warning(
        self, mock_validate, mock_transcribe, mock_filename, capsys
    ):
        with patch("whisp.diarize_pyannote.diarize") as d:
            d.side_effect = HFTokenMissingError("token not found")

            markdown, _ = run("/audio/test.mp3")

            assert "UNKNOWN" in markdown
            captured = capsys.readouterr()
            assert "warning:" in captured.err

    def test_graceful_degradation_exits_zero(
        self, mock_validate, mock_transcribe, mock_filename
    ):
        with patch("whisp.diarize_pyannote.diarize") as d:
            d.side_effect = HFTokenMissingError("token not found")

            markdown, filename = run("/audio/test.mp3")

            assert markdown is not None
            assert filename is not None


class TestStrictMode:
    def test_strict_mode_raises_on_diarization_failure(
        self, mock_validate, mock_transcribe, mock_filename
    ):
        with patch("whisp.diarize_pyannote.diarize") as d:
            d.side_effect = TranscriptionError("diarization failed")

            options = Options(strict=True)
            with pytest.raises(TranscriptionError):
                run("/audio/test.mp3", options)

    def test_strict_mode_raises_on_hf_token_missing(
        self, mock_validate, mock_transcribe, mock_filename
    ):
        with patch("whisp.diarize_pyannote.diarize") as d:
            d.side_effect = HFTokenMissingError("token not found")

            options = Options(strict=True)
            with pytest.raises(HFTokenMissingError):
                run("/audio/test.mp3", options)

    def test_strict_mode_file_not_found_raises(self):
        with patch("whisp.validate.validate_file_exists") as vfe:
            vfe.side_effect = FileNotFoundError("not found")

            options = Options(strict=True)
            with pytest.raises(FileNotFoundError):
                run("/audio/missing.mp3", options)

    def test_strict_mode_unsupported_format_raises(self, mock_validate):
        vfe, vfd = mock_validate
        vfd.side_effect = UnsupportedFormatError("bad format")

        options = Options(strict=True)
        with pytest.raises(UnsupportedFormatError):
            run("/audio/test.mp3", options)

    def test_strict_mode_model_load_error_raises(
        self, mock_validate, mock_filename
    ):
        with patch("whisp.transcribe_fw.transcribe") as t:
            t.side_effect = ModelLoadError("failed to load")

            options = Options(strict=True)
            with pytest.raises(ModelLoadError):
                run("/audio/test.mp3", options)


class TestValidationErrors:
    def test_file_not_found_raises(self):
        with patch("whisp.validate.validate_file_exists") as vfe:
            vfe.side_effect = FileNotFoundError("not found")

            with pytest.raises(FileNotFoundError):
                run("/audio/missing.mp3")

    def test_unsupported_format_raises(self, mock_validate):
        vfe, vfd = mock_validate
        vfd.side_effect = UnsupportedFormatError("not audio")

        with pytest.raises(UnsupportedFormatError):
            run("/audio/test.mp3")


class TestTryDiarize:
    def test_returns_diarization_on_success(self):
        with patch("whisp.diarize_pyannote.diarize") as d:
            mock_result = MockDiarization([(0.0, 1.0, "SPEAKER_00")])
            d.return_value = mock_result

            result = _try_diarize(Path("/audio/test.mp3"), Options())

            assert result is mock_result

    def test_returns_none_on_hf_token_missing(self, capsys):
        with patch("whisp.diarize_pyannote.diarize") as d:
            d.side_effect = HFTokenMissingError("no token")

            result = _try_diarize(Path("/audio/test.mp3"), Options())

            assert result is None
            captured = capsys.readouterr()
            assert "warning:" in captured.err

    def test_returns_none_on_transcription_error(self, capsys):
        with patch("whisp.diarize_pyannote.diarize") as d:
            d.side_effect = TranscriptionError("failed")

            result = _try_diarize(Path("/audio/test.mp3"), Options())

            assert result is None

    def test_raises_in_strict_mode(self):
        with patch("whisp.diarize_pyannote.diarize") as d:
            d.side_effect = HFTokenMissingError("no token")

            with pytest.raises(HFTokenMissingError):
                _try_diarize(Path("/audio/test.mp3"), Options(strict=True))

    def test_single_speaker_returns_none_immediately(self):
        with patch("whisp.diarize_pyannote.diarize") as d:
            result = _try_diarize(Path("/audio/test.mp3"), Options(speakers=1))

            assert result is None
            d.assert_not_called()


class TestMarkUnknown:
    def test_marks_all_words_unknown(self):
        words = [
            Word(text="hello", start=0.0, end=0.5),
            Word(text="world", start=0.6, end=1.0),
        ]

        result = _mark_unknown(words)

        assert all(w.speaker == "UNKNOWN" for w in result)

    def test_preserves_other_fields(self):
        words = [Word(text="test", start=1.5, end=2.0)]

        result = _mark_unknown(words)

        assert result[0].text == "test"
        assert result[0].start == 1.5
        assert result[0].end == 2.0


class TestExtractSpeakers:
    def test_extracts_unique_speakers_in_order(self):
        words = [
            Word(text="a", start=0.0, end=0.1, speaker="SPEAKER_00"),
            Word(text="b", start=0.2, end=0.3, speaker="SPEAKER_01"),
            Word(text="c", start=0.4, end=0.5, speaker="SPEAKER_00"),
        ]

        result = _extract_speakers(words, single_speaker=False)

        assert result == ["SPEAKER_00", "SPEAKER_01"]

    def test_returns_empty_for_single_speaker_mode(self):
        words = [Word(text="a", start=0.0, end=0.1, speaker="SPEAKER_00")]

        result = _extract_speakers(words, single_speaker=True)

        assert result == []

    def test_handles_none_speaker(self):
        words = [Word(text="a", start=0.0, end=0.1, speaker=None)]

        result = _extract_speakers(words, single_speaker=False)

        assert result == ["UNKNOWN"]


class TestOptions:
    def test_default_options(self):
        opts = Options()

        assert opts.model is None
        assert opts.language is None
        assert opts.speakers is None
        assert opts.strict is False
        assert opts.verbose is False

    def test_all_options(self):
        opts = Options(
            model="large-v3",
            language="en",
            speakers=2,
            strict=True,
            verbose=True,
        )

        assert opts.model == "large-v3"
        assert opts.language == "en"
        assert opts.speakers == 2
        assert opts.strict is True
        assert opts.verbose is True
