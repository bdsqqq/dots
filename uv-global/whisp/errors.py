"""Error types for whisp with POSIX exit codes."""


class WhispError(Exception):
    exit_code: int = 1

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class InvalidArgumentsError(WhispError):
    exit_code = 2


class FileNotFoundError(WhispError):
    exit_code = 10


class UnsupportedFormatError(WhispError):
    exit_code = 11


class ModelLoadError(WhispError):
    exit_code = 20


class TranscriptionError(WhispError):
    exit_code = 30


class HFTokenMissingError(WhispError):
    exit_code = 31
