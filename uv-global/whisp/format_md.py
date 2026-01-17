"""Markdown rendering for whisp transcripts."""

from __future__ import annotations

from pathlib import Path

from whisp.models import Transcript, SpeakerTurn
from whisp.timefmt import format_duration, format_timestamp


def render(transcript: Transcript, single_speaker: bool = False) -> str:
    """Render transcript as commonplace-compatible markdown.

    Args:
        transcript: Transcript data to render
        single_speaker: If True, omit speaker labels (--speakers 1 mode)

    Returns:
        Markdown string with YAML frontmatter and formatted transcript
    """
    lines: list[str] = []

    lines.append(_render_frontmatter(transcript, single_speaker))
    lines.append("")
    lines.append(_render_header(transcript))
    lines.append("")
    lines.append(_render_body(transcript, single_speaker))

    return "\n".join(lines)


def _render_frontmatter(transcript: Transcript, single_speaker: bool) -> str:
    """Render YAML frontmatter."""
    source_name = Path(transcript.source).name
    duration_str = format_duration(transcript.duration)
    transcribed_str = transcript.transcribed_at.strftime("%Y-%m-%dT%H:%M:%SZ")

    lines = [
        "---",
        f"source: ./{source_name}",
        f"duration: {duration_str}",
    ]

    if single_speaker:
        lines.append("speakers: []")
    else:
        lines.append("speakers:")
        for speaker in transcript.speakers:
            lines.append(f"  - {speaker}")

    lines.extend([
        f"model: {transcript.model}",
        f"transcribed: {transcribed_str}",
        "---",
    ])

    return "\n".join(lines)


def _render_header(transcript: Transcript) -> str:
    """Render markdown header."""
    source_name = Path(transcript.source).name
    return f"# transcript: {source_name}"


def _render_body(transcript: Transcript, single_speaker: bool) -> str:
    """Render transcript body with speaker turns."""
    if not transcript.turns:
        return "[...silence]"

    paragraphs: list[str] = []

    for turn in transcript.turns:
        paragraph = _render_turn(turn, transcript.duration, single_speaker)
        paragraphs.append(paragraph)

    return "\n\n".join(paragraphs)


def _render_turn(
    turn: SpeakerTurn, audio_duration: float, single_speaker: bool
) -> str:
    """Render a single speaker turn as a paragraph."""
    timestamp = format_timestamp(turn.start_time, audio_duration)
    text = " ".join(word.text for word in turn.words)

    if single_speaker:
        return f"**{timestamp}** {text}"
    else:
        return f"**{timestamp}** {turn.speaker}: {text}"
