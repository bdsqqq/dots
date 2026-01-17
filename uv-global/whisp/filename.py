"""Output filename generation for whisp transcripts."""

from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path


def get_source_timestamp(path: str | Path) -> datetime:
    """Get file modification time as datetime.

    Falls back to current time if mtime unavailable.
    """
    try:
        mtime = os.path.getmtime(path)
        return datetime.fromtimestamp(mtime)
    except OSError:
        return datetime.now()


def sanitize_filename(name: str) -> str:
    """Remove or replace characters unsafe for filenames."""
    unsafe = re.sub(r'[<>:"/\\|?*]', "", name)
    return unsafe.strip()


def make_output_filename(source_path: str | Path, timestamp: datetime) -> str:
    """Generate commonplace-compliant output filename.

    Format: YYYY-MM-DDTHH-MM <original-name> -- source__transcript.md
    """
    source = Path(source_path)
    original_name = sanitize_filename(source.stem)
    ts_str = timestamp.strftime("%Y-%m-%dT%H-%M")

    return f"{ts_str} {original_name} -- source__transcript.md"
