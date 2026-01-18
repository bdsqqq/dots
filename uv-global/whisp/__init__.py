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
    "format_timestamp",
    "format_duration",
    "get_source_timestamp",
    "make_output_filename",
    "words_to_turns",
    "assign_speakers",
    "render",
    "run",
    "Options",
]

from whisp.models import Word, SpeakerTurn, Transcript
from whisp.app import run, Options
from whisp.errors import (
    WhispError,
    InvalidArgumentsError,
    FileNotFoundError,
    UnsupportedFormatError,
    ModelLoadError,
    TranscriptionError,
    HFTokenMissingError,
)
from whisp.timefmt import format_timestamp, format_duration
from whisp.filename import get_source_timestamp, make_output_filename
from whisp.segment import words_to_turns
from whisp.align import assign_speakers
from whisp.format_md import render
