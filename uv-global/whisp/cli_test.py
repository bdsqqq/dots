"""Tests for whisp.cli module."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from whisp.cli import build_parser, main
from whisp.errors import FileNotFoundError, TranscriptionError, HFTokenMissingError


class TestBuildParser:
    def test_creates_parser(self):
        parser = build_parser()
        assert parser.prog == "whisp"

    def test_file_argument_required(self):
        parser = build_parser()
        with pytest.raises(SystemExit):
            parser.parse_args([])

    def test_parses_file_argument(self):
        parser = build_parser()
        args = parser.parse_args(["audio.mp3"])
        assert args.file == "audio.mp3"

    def test_output_option(self):
        parser = build_parser()
        args = parser.parse_args(["audio.mp3", "-o", "out.md"])
        assert args.output == "out.md"

    def test_output_long_option(self):
        parser = build_parser()
        args = parser.parse_args(["audio.mp3", "--output", "out.md"])
        assert args.output == "out.md"

    def test_model_option(self):
        parser = build_parser()
        args = parser.parse_args(["audio.mp3", "-m", "large-v3"])
        assert args.model == "large-v3"

    def test_language_option(self):
        parser = build_parser()
        args = parser.parse_args(["audio.mp3", "-l", "es"])
        assert args.language == "es"

    def test_speakers_option(self):
        parser = build_parser()
        args = parser.parse_args(["audio.mp3", "-s", "3"])
        assert args.speakers == 3

    def test_strict_flag(self):
        parser = build_parser()
        args = parser.parse_args(["audio.mp3", "--strict"])
        assert args.strict is True

    def test_verbose_flag(self):
        parser = build_parser()
        args = parser.parse_args(["audio.mp3", "-v"])
        assert args.verbose is True

    def test_suggest_filename_flag(self):
        parser = build_parser()
        args = parser.parse_args(["audio.mp3", "--suggest-filename"])
        assert args.suggest_filename is True

    def test_all_options_combined(self):
        parser = build_parser()
        args = parser.parse_args([
            "audio.mp3",
            "-o", "out.md",
            "-m", "medium",
            "-l", "en",
            "-s", "2",
            "--strict",
            "-v",
        ])
        assert args.file == "audio.mp3"
        assert args.output == "out.md"
        assert args.model == "medium"
        assert args.language == "en"
        assert args.speakers == 2
        assert args.strict is True
        assert args.verbose is True


class TestMain:
    @pytest.fixture
    def mock_run(self):
        with patch("whisp.cli.run") as r:
            r.return_value = ("# transcript\n\nhello world", "2025-01-15T10-30 audio -- source__transcript.md")
            yield r

    @pytest.fixture
    def mock_io(self):
        with patch("whisp.cli.write_stdout") as ws, \
             patch("whisp.cli.atomic_write") as aw:
            yield ws, aw

    def test_returns_zero_on_success(self, mock_run, mock_io):
        result = main(["audio.mp3"])
        assert result == 0

    def test_calls_run_with_file(self, mock_run, mock_io):
        main(["audio.mp3"])
        mock_run.assert_called_once()
        args, kwargs = mock_run.call_args
        assert args[0] == "audio.mp3"

    def test_passes_options_to_run(self, mock_run, mock_io):
        main(["audio.mp3", "-m", "large-v3", "-l", "es", "-s", "2", "--strict", "-v"])
        args, kwargs = mock_run.call_args
        options = args[1]
        assert options.model == "large-v3"
        assert options.language == "es"
        assert options.speakers == 2
        assert options.strict is True
        assert options.verbose is True

    def test_writes_to_stdout_by_default(self, mock_run, mock_io):
        write_stdout, atomic_write = mock_io
        main(["audio.mp3"])
        write_stdout.assert_called_once()
        atomic_write.assert_not_called()

    def test_writes_to_file_with_output_option(self, mock_run, mock_io, tmp_path):
        write_stdout, atomic_write = mock_io
        output_file = tmp_path / "out.md"
        main(["audio.mp3", "-o", str(output_file)])
        atomic_write.assert_called_once()
        write_stdout.assert_not_called()

    def test_uses_suggested_filename_for_directory_output(self, mock_run, mock_io, tmp_path):
        write_stdout, atomic_write = mock_io
        main(["audio.mp3", "-o", str(tmp_path)])
        call_args = atomic_write.call_args[0]
        assert "2025-01-15T10-30 audio -- source__transcript.md" in str(call_args[0])

    def test_suggest_filename_prints_and_exits(self, mock_run, capsys):
        result = main(["audio.mp3", "--suggest-filename"])
        assert result == 0
        captured = capsys.readouterr()
        assert "2025-01-15T10-30 audio -- source__transcript.md" in captured.err


class TestMainErrors:
    def test_file_not_found_returns_exit_code(self, capsys):
        with patch("whisp.cli.run") as r:
            r.side_effect = FileNotFoundError("file not found: missing.mp3")
            result = main(["missing.mp3"])
            assert result == 10
            captured = capsys.readouterr()
            assert "error:" in captured.err

    def test_transcription_error_returns_exit_code(self, capsys):
        with patch("whisp.cli.run") as r:
            r.side_effect = TranscriptionError("transcription failed")
            result = main(["audio.mp3"])
            assert result == 30

    def test_hf_token_missing_returns_exit_code(self, capsys):
        with patch("whisp.cli.run") as r:
            r.side_effect = HFTokenMissingError("token missing")
            result = main(["audio.mp3"])
            assert result == 31

    def test_error_message_printed_to_stderr(self, capsys):
        with patch("whisp.cli.run") as r:
            r.side_effect = FileNotFoundError("file not found: missing.mp3")
            main(["missing.mp3"])
            captured = capsys.readouterr()
            assert "file not found: missing.mp3" in captured.err


class TestMainVerbose:
    def test_verbose_prints_write_path(self, tmp_path, capsys):
        with patch("whisp.cli.run") as r, \
             patch("whisp.cli.atomic_write"):
            r.return_value = ("# markdown", "suggested.md")
            output_file = tmp_path / "out.md"
            main(["audio.mp3", "-o", str(output_file), "-v"])
            captured = capsys.readouterr()
            assert "wrote:" in captured.err
