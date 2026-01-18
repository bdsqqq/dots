"""Pyannote diarization adapter for whisp."""

from __future__ import annotations

import os
import sys
from typing import Any

from whisp.errors import HFTokenMissingError, TranscriptionError


def check_hf_token() -> str:
    """Check for Hugging Face token in environment.

    Returns:
        The HF token if found

    Raises:
        HFTokenMissingError: Token not found in HF_TOKEN or HUGGING_FACE_HUB_TOKEN
    """
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not token:
        raise HFTokenMissingError(
            "hugging face token required for diarization. "
            "set HF_TOKEN or HUGGING_FACE_HUB_TOKEN environment variable."
        )
    return token


def diarize(
    path: str,
    speakers_hint: int | None = None,
    verbose: bool = False,
) -> Any:
    """Run speaker diarization on audio file.

    Args:
        path: Path to audio file
        speakers_hint: Hint for number of speakers (optional)
        verbose: Print progress to stderr

    Returns:
        Pyannote diarization result with itertracks() method

    Raises:
        HFTokenMissingError: HF token not configured
        TranscriptionError: Diarization failed
    """
    token = check_hf_token()

    if verbose:
        print("loading diarization model...", file=sys.stderr)

    try:
        from pyannote.audio import Pipeline

        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            token=token,
        )
    except Exception as e:
        raise TranscriptionError(f"failed to load diarization model: {e}") from e

    if verbose:
        print("diarizing...", file=sys.stderr)

    try:
        kwargs: dict[str, Any] = {}
        if speakers_hint is not None:
            kwargs["num_speakers"] = speakers_hint

        diarization = pipeline(path, **kwargs)

    except Exception as e:
        raise TranscriptionError(f"diarization failed: {e}") from e

    if verbose:
        speakers = set(label for _, _, label in diarization.itertracks(yield_label=True))
        print(f"found {len(speakers)} speakers", file=sys.stderr)

    return diarization
