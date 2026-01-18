"""Command-line interface for whisp."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from whisp import __version__
from whisp.app import run, Options
from whisp.errors import WhispError
from whisp.io import write_stdout, atomic_write


def build_parser() -> argparse.ArgumentParser:
    """Build argument parser for whisp CLI."""
    parser = argparse.ArgumentParser(
        prog="whisp",
        description="transcribe audio to markdown with speaker diarization",
    )

    parser.add_argument(
        "file",
        help="audio file to transcribe",
    )

    parser.add_argument(
        "-o", "--output",
        metavar="PATH",
        help="output file path (default: stdout)",
    )

    parser.add_argument(
        "-m", "--model",
        metavar="MODEL",
        help="whisper model name (default: auto-select based on device)",
    )

    parser.add_argument(
        "-l", "--language",
        metavar="LANG",
        help="language code (default: auto-detect)",
    )

    parser.add_argument(
        "-s", "--speakers",
        type=int,
        metavar="N",
        help="number of speakers hint (1 = skip diarization)",
    )

    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit with error code on any failure (no graceful degradation)",
    )

    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="print progress to stderr",
    )

    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    parser.add_argument(
        "--suggest-filename",
        action="store_true",
        help="print suggested output filename to stderr and exit",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    """Main CLI entry point.

    Args:
        argv: Command-line arguments (default: sys.argv[1:])

    Returns:
        Exit code (0 for success, non-zero for errors)
    """
    parser = build_parser()
    args = parser.parse_args(argv)

    options = Options(
        model=args.model,
        language=args.language,
        speakers=args.speakers,
        strict=args.strict,
        verbose=args.verbose,
    )

    try:
        markdown, suggested_filename = run(args.file, options)
    except WhispError as e:
        print(f"error: {e.message}", file=sys.stderr)
        return e.exit_code

    if args.suggest_filename:
        print(suggested_filename, file=sys.stderr)
        return 0

    if args.output:
        output_path = Path(args.output)
        if output_path.is_dir():
            output_path = output_path / suggested_filename
        atomic_write(output_path, markdown)
        if args.verbose:
            print(f"wrote: {output_path}", file=sys.stderr)
    else:
        write_stdout(markdown)

    return 0
