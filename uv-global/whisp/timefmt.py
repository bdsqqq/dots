"""Timestamp and duration formatting for whisp output."""

from __future__ import annotations


def format_timestamp(seconds: float, audio_duration_seconds: float) -> str:
    """Format timestamp as [MM:SS] or [HH:MM:SS] based on audio duration.

    Uses [HH:MM:SS] format when audio duration >= 1 hour, otherwise [MM:SS].
    """
    total_seconds = int(seconds)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60

    if audio_duration_seconds >= 3600:
        return f"[{hours:02d}:{minutes:02d}:{secs:02d}]"
    return f"[{minutes:02d}:{secs:02d}]"


def format_duration(seconds: float) -> str:
    """Format duration as human-readable string.

    Examples: '5m 42s', '1h 5m 42s' for >= 1hr, '0s' for 0.
    """
    total_seconds = int(seconds)
    if total_seconds == 0:
        return "0s"

    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60

    parts: list[str] = []
    if hours > 0:
        parts.append(f"{hours}h")
    if minutes > 0:
        parts.append(f"{minutes}m")
    if secs > 0:
        parts.append(f"{secs}s")

    return " ".join(parts)
