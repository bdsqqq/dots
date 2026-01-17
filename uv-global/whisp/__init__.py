"""whisp - audio to markdown transcription CLI."""

__version__ = "0.1.0"
__all__ = [
    "__version__",
    "Word",
    "SpeakerTurn",
    "Transcript",
    "WhispError",
    "InvalidArgumentsError",
    "FileNotFoundError",
    "UnsupportedFormatError",
    "ModelLoadError",
    "TranscriptionError",
    "HFTokenMissingError",
]

from whisp.models import Word, SpeakerTurn, Transcript
from whisp.errors import (
    WhispError,
    InvalidArgumentsError,
    FileNotFoundError,
    UnsupportedFormatError,
    ModelLoadError,
    TranscriptionError,
    HFTokenMissingError,
)
