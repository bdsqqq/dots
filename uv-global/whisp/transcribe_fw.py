"""Faster-whisper transcription adapter for whisp."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from whisp.models import Word
from whisp.errors import ModelLoadError, TranscriptionError

if TYPE_CHECKING:
    from faster_whisper import WhisperModel


def detect_device() -> str:
    """Detect best available device for transcription.

    Returns 'cuda' if available, else 'cpu'.
    MPS is not supported by ctranslate2, falls back to cpu.
    """
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        pass
    return "cpu"


def get_default_model(device: str) -> tuple[str, str]:
    """Get default model and compute type for device.

    Returns:
        (model_name, compute_type) tuple
    """
    if device == "cuda":
        return ("large-v3", "float16")
    else:
        return ("medium", "int8")


def transcribe(
    path: str,
    model: str | None = None,
    language: str | None = None,
    verbose: bool = False,
) -> tuple[list[Word], float]:
    """Transcribe audio file using faster-whisper.

    Args:
        path: Path to audio file
        model: Whisper model name (default: auto-select based on device)
        language: Language code (default: auto-detect)
        verbose: Print progress to stderr

    Returns:
        (words, duration) tuple where words is list of Word objects

    Raises:
        ModelLoadError: Failed to load whisper model
        TranscriptionError: Transcription failed
    """
    device = detect_device()
    model_name, compute_type = get_default_model(device)
    if model:
        model_name = model

    if verbose:
        print(f"loading {model_name} on {device}...", file=sys.stderr)

    try:
        from faster_whisper import WhisperModel

        whisper = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
        )
    except Exception as e:
        raise ModelLoadError(f"failed to load model {model_name}: {e}") from e

    if verbose:
        print("transcribing...", file=sys.stderr)

    try:
        segments, info = whisper.transcribe(
            path,
            language=language,
            word_timestamps=True,
        )

        words: list[Word] = []
        for segment in segments:
            if segment.words:
                for w in segment.words:
                    words.append(Word(text=w.word.strip(), start=w.start, end=w.end))

        duration = info.duration

    except Exception as e:
        raise TranscriptionError(f"transcription failed: {e}") from e

    if verbose:
        print(f"done. {len(words)} words in {duration:.1f}s", file=sys.stderr)

    return words, duration
