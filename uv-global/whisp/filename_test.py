"""Tests for filename module."""

import tempfile
from datetime import datetime
from pathlib import Path

import pytest

from whisp.filename import get_source_timestamp, make_output_filename, sanitize_filename


class TestGetSourceTimestamp:
    """Tests for get_source_timestamp function."""

    def test_returns_datetime_from_existing_file(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"test")
            f.flush()
            result = get_source_timestamp(f.name)
            assert isinstance(result, datetime)
            Path(f.name).unlink()

    def test_nonexistent_file_returns_now(self):
        before = datetime.now()
        result = get_source_timestamp("/nonexistent/path/file.m4a")
        after = datetime.now()
        assert before <= result <= after

    def test_accepts_path_object(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"test")
            f.flush()
            result = get_source_timestamp(Path(f.name))
            assert isinstance(result, datetime)
            Path(f.name).unlink()


class TestSanitizeFilename:
    """Tests for sanitize_filename function."""

    def test_removes_unsafe_characters(self):
        assert sanitize_filename('file<>:"/\\|?*name') == "filename"

    def test_preserves_safe_characters(self):
        assert sanitize_filename("my-file_name.test") == "my-file_name.test"

    def test_strips_whitespace(self):
        assert sanitize_filename("  filename  ") == "filename"

    def test_empty_string(self):
        assert sanitize_filename("") == ""


class TestMakeOutputFilename:
    """Tests for make_output_filename function."""

    def test_basic_format(self):
        ts = datetime(2026, 1, 17, 14, 30)
        result = make_output_filename("recording.m4a", ts)
        assert result == "2026-01-17T14-30 recording -- source__transcript.md"

    def test_preserves_original_name(self):
        ts = datetime(2026, 1, 17, 14, 30)
        result = make_output_filename("my podcast episode.mp3", ts)
        assert result == "2026-01-17T14-30 my podcast episode -- source__transcript.md"

    def test_sanitizes_unsafe_chars(self):
        ts = datetime(2026, 1, 17, 14, 30)
        result = make_output_filename('file:with"bad*chars.m4a', ts)
        assert result == "2026-01-17T14-30 filewithbadchars -- source__transcript.md"

    def test_handles_path_object(self):
        ts = datetime(2026, 1, 17, 14, 30)
        result = make_output_filename(Path("/some/path/audio.m4a"), ts)
        assert result == "2026-01-17T14-30 audio -- source__transcript.md"

    def test_strips_extension(self):
        ts = datetime(2026, 1, 17, 14, 30)
        result = make_output_filename("file.tar.gz", ts)
        assert result == "2026-01-17T14-30 file.tar -- source__transcript.md"
