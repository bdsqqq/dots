"""Tests for diarize_pyannote module."""

import os
from dataclasses import dataclass
from unittest.mock import MagicMock, patch

import pytest

from whisp.errors import HFTokenMissingError, TranscriptionError
from whisp.diarize_pyannote import check_hf_token, diarize


class TestCheckHfToken:
    """Tests for check_hf_token function."""

    def test_returns_hf_token_from_env(self, monkeypatch):
        monkeypatch.setenv("HF_TOKEN", "test-token")
        assert check_hf_token() == "test-token"

    def test_returns_hugging_face_hub_token_from_env(self, monkeypatch):
        monkeypatch.delenv("HF_TOKEN", raising=False)
        monkeypatch.setenv("HUGGING_FACE_HUB_TOKEN", "hub-token")
        assert check_hf_token() == "hub-token"

    def test_hf_token_takes_precedence(self, monkeypatch):
        monkeypatch.setenv("HF_TOKEN", "primary")
        monkeypatch.setenv("HUGGING_FACE_HUB_TOKEN", "secondary")
        assert check_hf_token() == "primary"

    def test_raises_when_no_token(self, monkeypatch):
        monkeypatch.delenv("HF_TOKEN", raising=False)
        monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)
        with pytest.raises(HFTokenMissingError) as exc_info:
            check_hf_token()
        assert "hugging face token required" in str(exc_info.value)


@dataclass
class MockSegment:
    """Mock pyannote segment."""

    start: float
    end: float


class MockDiarization:
    """Mock pyannote diarization result."""

    def __init__(self, tracks: list[tuple[float, float, str]]):
        self._tracks = tracks

    def itertracks(self, yield_label: bool = False):
        for start, end, speaker in self._tracks:
            if yield_label:
                yield MockSegment(start, end), None, speaker
            else:
                yield MockSegment(start, end), None


class TestDiarize:
    """Tests for diarize function."""

    def test_raises_without_token(self, monkeypatch):
        monkeypatch.delenv("HF_TOKEN", raising=False)
        monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)
        with pytest.raises(HFTokenMissingError):
            diarize("/path/to/audio.m4a")

    def test_returns_diarization_result(self, monkeypatch):
        monkeypatch.setenv("HF_TOKEN", "test-token")
        mock_diarization = MockDiarization([
            (0.0, 1.0, "SPEAKER_00"),
            (1.5, 2.5, "SPEAKER_01"),
        ])
        mock_pipeline = MagicMock()
        mock_pipeline.return_value = mock_diarization

        with patch(
            "pyannote.audio.Pipeline.from_pretrained",
            return_value=mock_pipeline,
            create=True,
        ):
            result = diarize("/path/to/audio.m4a")

        assert result is mock_diarization

    def test_passes_speakers_hint(self, monkeypatch):
        monkeypatch.setenv("HF_TOKEN", "test-token")
        mock_diarization = MockDiarization([])
        mock_pipeline = MagicMock()
        mock_pipeline.return_value = mock_diarization

        with patch(
            "pyannote.audio.Pipeline.from_pretrained",
            return_value=mock_pipeline,
            create=True,
        ):
            diarize("/path/to/audio.m4a", speakers_hint=3)

        call_kwargs = mock_pipeline.call_args.kwargs
        assert call_kwargs["num_speakers"] == 3

    def test_no_speakers_hint_by_default(self, monkeypatch):
        monkeypatch.setenv("HF_TOKEN", "test-token")
        mock_diarization = MockDiarization([])
        mock_pipeline = MagicMock()
        mock_pipeline.return_value = mock_diarization

        with patch(
            "pyannote.audio.Pipeline.from_pretrained",
            return_value=mock_pipeline,
            create=True,
        ):
            diarize("/path/to/audio.m4a")

        call_kwargs = mock_pipeline.call_args.kwargs
        assert "num_speakers" not in call_kwargs

    def test_model_load_failure_raises_transcription_error(self, monkeypatch):
        monkeypatch.setenv("HF_TOKEN", "test-token")

        with patch(
            "pyannote.audio.Pipeline.from_pretrained",
            side_effect=Exception("auth failed"),
            create=True,
        ):
            with pytest.raises(TranscriptionError) as exc_info:
                diarize("/path/to/audio.m4a")
            assert "load diarization model" in str(exc_info.value)

    def test_diarization_failure_raises_transcription_error(self, monkeypatch):
        monkeypatch.setenv("HF_TOKEN", "test-token")
        mock_pipeline = MagicMock()
        mock_pipeline.side_effect = Exception("audio decode error")

        with patch(
            "pyannote.audio.Pipeline.from_pretrained",
            return_value=mock_pipeline,
            create=True,
        ):
            with pytest.raises(TranscriptionError) as exc_info:
                diarize("/path/to/audio.m4a")
            assert "diarization failed" in str(exc_info.value)

    def test_uses_correct_model_name(self, monkeypatch):
        monkeypatch.setenv("HF_TOKEN", "test-token")
        mock_diarization = MockDiarization([])
        mock_pipeline = MagicMock()
        mock_pipeline.return_value = mock_diarization
        mock_from_pretrained = MagicMock(return_value=mock_pipeline)

        with patch(
            "pyannote.audio.Pipeline.from_pretrained",
            mock_from_pretrained,
            create=True,
        ):
            diarize("/path/to/audio.m4a")

        call_args = mock_from_pretrained.call_args
        assert call_args[0][0] == "pyannote/speaker-diarization-3.1"
        assert call_args[1]["use_auth_token"] == "test-token"
