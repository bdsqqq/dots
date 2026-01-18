"""Main orchestration for whisp transcription pipeline."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from whisp.models import Transcript, Word
from whisp.errors import WhispError, HFTokenMissingError


@dataclass
class Options:
    model: str | None = None
    language: str | None = None
    speakers: int | None = None
    strict: bool = False
    verbose: bool = False


def run(file: str, options: Options | None = None) -> tuple[str, str]:
    """Run the full transcription pipeline.

    Args:
        file: Path to audio file
        options: Transcription options

    Returns:
        (markdown, suggested_filename) tuple

    Raises:
        WhispError subclasses in strict mode or for fatal errors
    """
    from whisp import validate, transcribe_fw, diarize_pyannote, align, segment, format_md, filename

    opts = options or Options()

    if opts.verbose:
        print(f"processing: {file}", file=sys.stderr)

    resolved_path = validate.validate_file_exists(file)
    validate.validate_ffmpeg_decodable(resolved_path)

    words, duration = transcribe_fw.transcribe(
        str(resolved_path),
        model=opts.model,
        language=opts.language,
        verbose=opts.verbose,
    )

    diarization = _try_diarize(resolved_path, opts)
    single_speaker = opts.speakers == 1

    if diarization is not None:
        words = align.assign_speakers(words, diarization)
    else:
        words = _mark_unknown(words)

    turns = segment.words_to_turns(words)

    speakers = _extract_speakers(words, single_speaker)

    model_name = opts.model or transcribe_fw.get_default_model(
        transcribe_fw.detect_device()
    )[0]

    transcript = Transcript(
        source=str(resolved_path),
        duration=duration,
        speakers=speakers,
        model=model_name,
        turns=turns,
        transcribed_at=datetime.now(timezone.utc),
    )

    markdown = format_md.render(transcript, single_speaker=single_speaker)

    source_ts = filename.get_source_timestamp(resolved_path)
    suggested_filename = filename.make_output_filename(resolved_path, source_ts)

    if opts.verbose:
        print(f"complete: {len(turns)} turns, {len(speakers)} speakers", file=sys.stderr)

    return markdown, suggested_filename


def _try_diarize(path: Path, opts: Options) -> Any | None:
    """Attempt diarization with graceful degradation.

    Returns diarization result or None on failure (unless strict mode).
    """
    from whisp import diarize_pyannote

    if opts.speakers == 1:
        if opts.verbose:
            print("skipping diarization (single speaker mode)", file=sys.stderr)
        return None

    try:
        return diarize_pyannote.diarize(
            str(path),
            speakers_hint=opts.speakers,
            verbose=opts.verbose,
        )
    except HFTokenMissingError as e:
        if opts.strict:
            raise
        print(f"warning: {e.message}", file=sys.stderr)
        print("continuing without diarization (all speakers marked UNKNOWN)", file=sys.stderr)
        return None
    except WhispError as e:
        if opts.strict:
            raise
        print(f"warning: diarization failed: {e.message}", file=sys.stderr)
        print("continuing without diarization (all speakers marked UNKNOWN)", file=sys.stderr)
        return None


def _mark_unknown(words: list[Word]) -> list[Word]:
    """Mark all words with UNKNOWN speaker."""
    from dataclasses import replace
    return [replace(w, speaker="UNKNOWN") for w in words]


def _extract_speakers(words: list[Word], single_speaker: bool) -> list[str]:
    """Extract unique speaker list from words."""
    if single_speaker:
        return []
    seen: set[str] = set()
    speakers: list[str] = []
    for word in words:
        speaker = word.speaker or "UNKNOWN"
        if speaker not in seen:
            seen.add(speaker)
            speakers.append(speaker)
    return speakers
