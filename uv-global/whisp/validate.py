"""Input validation for whisp."""

from __future__ import annotations

import subprocess
from pathlib import Path

from whisp.errors import FileNotFoundError, UnsupportedFormatError


def validate_file_exists(path: str | Path) -> Path:
    """Validate that file exists.

    Args:
        path: Path to validate

    Returns:
        Resolved Path object

    Raises:
        FileNotFoundError: File does not exist
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"file not found: {path}")
    if not p.is_file():
        raise FileNotFoundError(f"not a file: {path}")
    return p.resolve()


def validate_ffmpeg_decodable(path: str | Path) -> None:
    """Validate that file is decodable by ffmpeg.

    Uses ffprobe to check if file is a valid audio/video format.

    Args:
        path: Path to audio file

    Raises:
        UnsupportedFormatError: File cannot be decoded by ffmpeg
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise UnsupportedFormatError(
                f"unsupported audio format: {path}\n{result.stderr.strip()}"
            )
    except OSError as e:
        if e.errno == 2:
            raise UnsupportedFormatError(
                "ffprobe not found. please install ffmpeg."
            )
        raise UnsupportedFormatError(
            f"error running ffprobe: {e}"
        )
    except subprocess.TimeoutExpired:
        raise UnsupportedFormatError(
            f"ffprobe timed out checking: {path}"
        )
