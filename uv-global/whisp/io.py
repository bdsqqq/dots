"""I/O utilities for whisp."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


def write_stdout(content: str) -> None:
    """Write content to stdout.

    Args:
        content: Content to write
    """
    sys.stdout.write(content)
    if not content.endswith("\n"):
        sys.stdout.write("\n")
    sys.stdout.flush()


def atomic_write(
    path: str | Path,
    content: str,
    keep_partial: bool = False,
) -> None:
    """Write content to file atomically.

    Uses temp file + rename to avoid partial writes on failure.

    Args:
        path: Destination file path
        content: Content to write
        keep_partial: If True, keep .partial file on failure

    Raises:
        OSError: Failed to write file
    """
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)

    temp_path = None
    try:
        fd, temp_path = tempfile.mkstemp(
            dir=dest.parent,
            prefix=f".{dest.name}.",
            suffix=".tmp",
        )
        with os.fdopen(fd, "w") as f:
            f.write(content)

        os.replace(temp_path, dest)
        temp_path = None

    except Exception:
        if temp_path and os.path.exists(temp_path):
            if keep_partial:
                partial_path = dest.with_suffix(dest.suffix + ".partial")
                os.replace(temp_path, partial_path)
            else:
                os.unlink(temp_path)
        raise
