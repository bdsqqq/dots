"""Word segmentation into speaker turns for whisp."""

from __future__ import annotations

from whisp.models import Word, SpeakerTurn


def words_to_turns(
    words: list[Word], gap_threshold: float = 1.5
) -> list[SpeakerTurn]:
    """Group words into speaker turns.

    A new turn starts when:
    1. Speaker changes, OR
    2. Gap between consecutive words > gap_threshold seconds
    """
    if not words:
        return []

    turns: list[SpeakerTurn] = []
    current_speaker = words[0].speaker or "UNKNOWN"
    current_start = words[0].start
    current_words: list[Word] = [words[0]]

    for i, word in enumerate(words[1:], start=1):
        prev_word = words[i - 1]
        word_speaker = word.speaker or "UNKNOWN"
        gap = word.start - prev_word.end

        should_break = word_speaker != current_speaker or gap > gap_threshold

        if should_break:
            turns.append(
                SpeakerTurn(
                    speaker=current_speaker,
                    start_time=current_start,
                    words=current_words,
                )
            )
            current_speaker = word_speaker
            current_start = word.start
            current_words = [word]
        else:
            current_words.append(word)

    turns.append(
        SpeakerTurn(
            speaker=current_speaker,
            start_time=current_start,
            words=current_words,
        )
    )

    return turns
