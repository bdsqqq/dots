"""Word-level speaker assignment for whisp."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from whisp.models import Word


def assign_speakers(
    words: list[Word], diarization_tracks: Any
) -> list[Word]:
    """Assign speaker labels to words based on diarization tracks.

    Uses midpoint assignment: each word gets the speaker whose segment
    contains the word's midpoint. Words with no matching segment get UNKNOWN.

    Args:
        words: List of words with timestamps
        diarization_tracks: Pyannote diarization object with itertracks() method

    Returns:
        New list of Word objects with speaker field set
    """
    result: list[Word] = []

    for word in words:
        midpoint = (word.start + word.end) / 2
        speaker = "UNKNOWN"

        for turn, _, label in diarization_tracks.itertracks(yield_label=True):
            if turn.start <= midpoint <= turn.end:
                speaker = label
                break

        result.append(replace(word, speaker=speaker))

    return result
