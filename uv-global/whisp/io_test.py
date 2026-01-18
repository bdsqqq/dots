"""Tests for io module."""

import tempfile
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import pytest

from whisp.io import write_stdout, atomic_write


class TestWriteStdout:
    """Tests for write_stdout function."""

    def test_writes_content_to_stdout(self):
        output = StringIO()
        with patch("sys.stdout", output):
            write_stdout("hello world")
        assert output.getvalue() == "hello world\n"

    def test_adds_newline_if_missing(self):
        output = StringIO()
        with patch("sys.stdout", output):
            write_stdout("no newline")
        assert output.getvalue().endswith("\n")

    def test_does_not_duplicate_newline(self):
        output = StringIO()
        with patch("sys.stdout", output):
            write_stdout("has newline\n")
        assert output.getvalue() == "has newline\n"


class TestAtomicWrite:
    """Tests for atomic_write function."""

    def test_writes_content_to_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "output.txt"
            atomic_write(path, "test content")
            assert path.read_text() == "test content"

    def test_creates_parent_directories(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "nested" / "deep" / "output.txt"
            atomic_write(path, "nested content")
            assert path.read_text() == "nested content"

    def test_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "output.txt"
            path.write_text("original")
            atomic_write(path, "updated")
            assert path.read_text() == "updated"

    def test_no_partial_file_on_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "output.txt"
            atomic_write(path, "content")
            files = list(Path(tmpdir).iterdir())
            assert len(files) == 1
            assert files[0].name == "output.txt"

    def test_no_temp_file_on_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "output.txt"
            atomic_write(path, "content")
            temp_files = list(Path(tmpdir).glob(".*"))
            assert len(temp_files) == 0

    def test_no_partial_without_keep_partial(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "output.txt"
            path_str = str(path)

            class WriteError(Exception):
                pass

            def failing_write(*args, **kwargs):
                raise WriteError("write failed")

            with patch("whisp.io.os.fdopen", side_effect=failing_write):
                with pytest.raises(WriteError):
                    atomic_write(path, "content", keep_partial=False)

            files = list(Path(tmpdir).iterdir())
            assert len(files) == 0

    def test_keeps_partial_file_on_failure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "output.txt"

            class WriteError(Exception):
                pass

            original_fdopen = __import__("os").fdopen

            def failing_fdopen(fd, mode):
                f = original_fdopen(fd, mode)
                f.write("partial content")
                f.flush()
                raise WriteError("write failed")

            with patch("whisp.io.os.fdopen", side_effect=failing_fdopen):
                with pytest.raises(WriteError):
                    atomic_write(path, "full content", keep_partial=True)

            partial_files = list(Path(tmpdir).glob("*.partial"))
            assert len(partial_files) == 1
            assert partial_files[0].read_text() == "partial content"

    def test_accepts_path_object(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "output.txt"
            atomic_write(path, "path object")
            assert path.read_text() == "path object"

    def test_accepts_string_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = str(Path(tmpdir) / "output.txt")
            atomic_write(path, "string path")
            assert Path(path).read_text() == "string path"
