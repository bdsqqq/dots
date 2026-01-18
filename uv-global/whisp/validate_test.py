"""Tests for validate module."""

import builtins
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from whisp.errors import FileNotFoundError, UnsupportedFormatError
from whisp.validate import validate_file_exists, validate_ffmpeg_decodable

builtins_FileNotFoundError = builtins.FileNotFoundError


class TestValidateFileExists:
    """Tests for validate_file_exists function."""

    def test_returns_path_for_existing_file(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"test")
            f.flush()
            result = validate_file_exists(f.name)
            assert isinstance(result, Path)
            assert result.exists()
            Path(f.name).unlink()

    def test_accepts_path_object(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"test")
            f.flush()
            result = validate_file_exists(Path(f.name))
            assert isinstance(result, Path)
            Path(f.name).unlink()

    def test_raises_for_nonexistent_file(self):
        with pytest.raises(FileNotFoundError) as exc_info:
            validate_file_exists("/nonexistent/path/file.m4a")
        assert "file not found" in str(exc_info.value)

    def test_raises_for_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with pytest.raises(FileNotFoundError) as exc_info:
                validate_file_exists(tmpdir)
            assert "not a file" in str(exc_info.value)

    def test_returns_resolved_path(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"test")
            f.flush()
            result = validate_file_exists(f.name)
            assert result.is_absolute()
            Path(f.name).unlink()


class TestValidateFfmpegDecodable:
    """Tests for validate_ffmpeg_decodable function."""

    def test_valid_file_passes(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stderr = ""

        with patch("subprocess.run", return_value=mock_result):
            validate_ffmpeg_decodable("/path/to/audio.m4a")

    def test_invalid_file_raises_unsupported_format(self):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = "Invalid data found"

        with patch("subprocess.run", return_value=mock_result):
            with pytest.raises(UnsupportedFormatError) as exc_info:
                validate_ffmpeg_decodable("/path/to/bad.txt")
            assert "unsupported audio format" in str(exc_info.value)

    def test_ffprobe_not_found_raises_unsupported_format(self):
        error = builtins_FileNotFoundError(2, "No such file or directory", "ffprobe")
        with patch(
            "whisp.validate.subprocess.run",
            side_effect=error,
        ):
            with pytest.raises(UnsupportedFormatError) as exc_info:
                validate_ffmpeg_decodable("/path/to/audio.m4a")
            assert "ffprobe not found" in str(exc_info.value)

    def test_timeout_raises_unsupported_format(self):
        with patch(
            "whisp.validate.subprocess.run",
            side_effect=subprocess.TimeoutExpired("ffprobe", 30),
        ):
            with pytest.raises(UnsupportedFormatError) as exc_info:
                validate_ffmpeg_decodable("/path/to/audio.m4a")
            assert "timed out" in str(exc_info.value)

    def test_calls_ffprobe_with_correct_args(self):
        mock_result = MagicMock()
        mock_result.returncode = 0

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            validate_ffmpeg_decodable("/path/to/audio.m4a")

        call_args = mock_run.call_args
        cmd = call_args[0][0]
        assert cmd[0] == "ffprobe"
        assert "-v" in cmd
        assert "error" in cmd
        assert "/path/to/audio.m4a" in cmd



