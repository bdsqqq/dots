"""Tests for transcribe_fw module."""

from dataclasses import dataclass
from unittest.mock import MagicMock, patch

import pytest

from whisp.models import Word
from whisp.errors import ModelLoadError, TranscriptionError
from whisp.transcribe_fw import detect_device, get_default_model, transcribe


class TestDetectDevice:
    """Tests for detect_device function."""

    def test_returns_cpu_when_torch_unavailable(self):
        with patch.dict("sys.modules", {"torch": None}):
            result = detect_device()
            assert result == "cpu"

    def test_returns_cuda_when_available(self):
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = True
        with patch.dict("sys.modules", {"torch": mock_torch}):
            with patch("whisp.transcribe_fw.torch", mock_torch, create=True):
                result = detect_device()
                assert result == "cuda"

    def test_returns_cpu_when_cuda_unavailable(self):
        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = False
        with patch.dict("sys.modules", {"torch": mock_torch}):
            with patch("whisp.transcribe_fw.torch", mock_torch, create=True):
                result = detect_device()
                assert result == "cpu"


class TestGetDefaultModel:
    """Tests for get_default_model function."""

    def test_cuda_returns_large_v3_float16(self):
        model, compute_type = get_default_model("cuda")
        assert model == "large-v3"
        assert compute_type == "float16"

    def test_cpu_returns_medium_int8(self):
        model, compute_type = get_default_model("cpu")
        assert model == "medium"
        assert compute_type == "int8"

    def test_unknown_device_returns_medium_int8(self):
        model, compute_type = get_default_model("mps")
        assert model == "medium"
        assert compute_type == "int8"


@dataclass
class MockWord:
    """Mock faster-whisper word."""

    word: str
    start: float
    end: float


@dataclass
class MockSegment:
    """Mock faster-whisper segment."""

    words: list[MockWord]


@dataclass
class MockInfo:
    """Mock faster-whisper transcription info."""

    duration: float


class TestTranscribe:
    """Tests for transcribe function."""

    def test_returns_words_and_duration(self):
        mock_model = MagicMock()
        mock_segments = [
            MockSegment([MockWord("hello", 0.0, 0.5), MockWord("world", 0.6, 1.0)])
        ]
        mock_info = MockInfo(duration=5.0)
        mock_model.transcribe.return_value = (iter(mock_segments), mock_info)

        with patch(
            "faster_whisper.WhisperModel", return_value=mock_model, create=True
        ):
            words, duration = transcribe("/path/to/audio.m4a")

        assert len(words) == 2
        assert words[0].text == "hello"
        assert words[0].start == 0.0
        assert words[1].text == "world"
        assert duration == 5.0

    def test_word_timestamps_always_true(self):
        mock_model = MagicMock()
        mock_model.transcribe.return_value = (iter([]), MockInfo(duration=0.0))

        with patch(
            "faster_whisper.WhisperModel", return_value=mock_model, create=True
        ):
            transcribe("/path/to/audio.m4a")

        call_kwargs = mock_model.transcribe.call_args.kwargs
        assert call_kwargs["word_timestamps"] is True

    def test_custom_model_used(self):
        mock_model_class = MagicMock()
        mock_model = MagicMock()
        mock_model.transcribe.return_value = (iter([]), MockInfo(duration=0.0))
        mock_model_class.return_value = mock_model

        with patch("faster_whisper.WhisperModel", mock_model_class, create=True):
            transcribe("/path/to/audio.m4a", model="tiny")

        call_args = mock_model_class.call_args
        assert call_args[0][0] == "tiny"

    def test_language_passed_through(self):
        mock_model = MagicMock()
        mock_model.transcribe.return_value = (iter([]), MockInfo(duration=0.0))

        with patch(
            "faster_whisper.WhisperModel", return_value=mock_model, create=True
        ):
            transcribe("/path/to/audio.m4a", language="en")

        call_kwargs = mock_model.transcribe.call_args.kwargs
        assert call_kwargs["language"] == "en"

    def test_model_load_failure_raises_model_load_error(self):
        with patch(
            "faster_whisper.WhisperModel",
            side_effect=Exception("download failed"),
            create=True,
        ):
            with pytest.raises(ModelLoadError) as exc_info:
                transcribe("/path/to/audio.m4a")
            assert "download failed" in str(exc_info.value)

    def test_transcription_failure_raises_transcription_error(self):
        mock_model = MagicMock()
        mock_model.transcribe.side_effect = Exception("ffmpeg error")

        with patch(
            "faster_whisper.WhisperModel", return_value=mock_model, create=True
        ):
            with pytest.raises(TranscriptionError) as exc_info:
                transcribe("/path/to/audio.m4a")
            assert "ffmpeg error" in str(exc_info.value)

    def test_strips_word_whitespace(self):
        mock_model = MagicMock()
        mock_segments = [MockSegment([MockWord(" hello ", 0.0, 0.5)])]
        mock_model.transcribe.return_value = (iter(mock_segments), MockInfo(duration=1.0))

        with patch(
            "faster_whisper.WhisperModel", return_value=mock_model, create=True
        ):
            words, _ = transcribe("/path/to/audio.m4a")

        assert words[0].text == "hello"
