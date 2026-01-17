"""Data models for whisp transcription output."""

from dataclasses import dataclass
from datetime import datetime


@dataclass
class Word:
    text: str
    start: float
    end: float
    speaker: str | None = None


@dataclass
class SpeakerTurn:
    speaker: str
    start_time: float
    words: list[Word]


@dataclass
class Transcript:
    source: str
    duration: float
    speakers: list[str]
    model: str
    turns: list[SpeakerTurn]
    transcribed_at: datetime
