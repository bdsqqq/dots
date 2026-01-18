# whisp implementation plan

greenfield implementation from SPEC.md. **zero source code exists.**

## status: not started

**dependencies confirmed** in `../pyproject.toml`:
- faster-whisper ✓
- pyannote.audio ✓
- torch (transitive dep; darwin arm64 → torch 2.8.0 from pypi with mps=True) ✓
- `[project.scripts]` entry point ✓
- pytest + pytest-cov in dev dependency-group ✓
- pytest config for `*_test.py` discovery ✓

## priority order

items sorted by dependency chain. earlier items block later ones.

### P0 — skeleton (blocks everything)

- [ ] create `whisp/__init__.py` (version, package exports)
- [ ] create `whisp/__main__.py` (entry point stub)
- [ ] create `whisp/py.typed` (pep 561 marker)
- [ ] `whisp/models.py` — `Word`, `SpeakerTurn`, `Transcript` dataclasses
- [ ] `whisp/errors.py` — `WhispError` base + specific errors with exit codes (2, 10, 11, 20, 30, 31)

### P1 — pure core (no ML, fast tests)

- [ ] `whisp/timefmt.py`:
  - `format_timestamp(seconds, audio_duration_seconds) -> str` — `[MM:SS]` or `[HH:MM:SS]`
  - `format_duration(seconds) -> str` — `5m 42s`, `1h 5m 42s`
- [ ] `whisp/filename.py`:
  - `get_source_timestamp(path) -> datetime` (mtime)
  - `make_output_filename(source_path, timestamp) -> str`
- [ ] `whisp/segment.py`:
  - `words_to_turns(words, gap_threshold=1.5) -> list[SpeakerTurn]`
  - new block on speaker change OR gap > threshold
- [ ] `whisp/align.py`:
  - `assign_speakers(words, diarization_tracks) -> list[Word]`
  - midpoint assignment, no-match → UNKNOWN
- [ ] `whisp/format_md.py`:
  - `render(transcript, single_speaker=False) -> str`
  - YAML frontmatter, empty audio (`[...silence]`), single_speaker mode (no labels), UNKNOWN labels

### P2 — adapters (ML dependencies)

- [ ] `whisp/transcribe_fw.py`:
  - `detect_device() -> str` (cuda/cpu; mps → cpu)
  - `get_default_model(device) -> tuple[str, str]` (model, compute_type)
  - `transcribe(path, model, language, verbose) -> tuple[list[Word], float]`
  - always `word_timestamps=True`
- [ ] `whisp/diarize_pyannote.py`:
  - `check_hf_token()` — exit 31 if missing
  - `diarize(path, speakers_hint, verbose) -> diarization_tracks`

### P3 — I/O + validation

- [ ] `whisp/validate.py`:
  - `validate_file_exists(path)` — raises FileNotFoundError → exit 10
  - `validate_ffmpeg_decodable(path)` — `ffprobe -v error`, exit 11 on failure
- [ ] `whisp/io.py`:
  - `write_stdout(content)`
  - `atomic_write(path, content, keep_partial=False)` — temp + atomic rename; `.partial` on failure if keep_partial

### P4 — orchestration

- [ ] `whisp/app.py`:
  - `run(file, options) -> tuple[str, str]` (markdown, suggested_filename)
  - graceful degradation: diarization failure → warn stderr, UNKNOWN labels, exit 0
  - strict mode: component failure → hard exit with specific code
  - verbose mode: progress to stderr

### P5 — CLI

- [ ] `whisp/cli.py`:
  - argparse with all flags per SPEC
  - validation flow: exists → decodable → run
  - exception → exit code mapping
- [ ] finalize `whisp/__main__.py`:
  - `main()` wrapper
  - exception handling

### P6 — polish

- [ ] help text matches SPEC cli section exactly
- [ ] verbose output: model loading %, transcription progress, diarization status
- [ ] `--keep-partial` integration in io.py
- [ ] exit code 20: pattern-match model load exceptions for network/download errors

## testing strategy

### unit tests (pure, fast) — implement alongside P1

| module | test focus |
|--------|------------|
| timefmt | 0s, 59s, 59m59s, 1hr boundary, hours in duration |
| filename | sanitization, format, mtime extraction |
| segment | speaker changes, gap detection, UNKNOWN grouping |
| align | midpoint assignment, overlap handling, no-match → UNKNOWN |
| format_md | YAML validity, empty audio, single_speaker mode, UNKNOWN labels |
| errors | exit codes correct per error type |

### adapter tests (mocked ML) — implement with P2

| module | mock strategy |
|--------|---------------|
| transcribe_fw | mock faster_whisper.WhisperModel; verify word_timestamps=True |
| diarize_pyannote | mock pipeline; verify HF_TOKEN check |

### integration tests (optional)

- end-to-end with mocked adapters returning deterministic data
- golden markdown snapshot tests

recommendation: mock ML in CI; manual real-model tests locally.

## deferred (v2)

- chunked diarization for 3hr+ files (speaker stitching at boundaries)
- overlap annotation `[overlap]` markers
- distil-large-v3 benchmarking for mps
- sentence boundary heuristics for segmentation

## module structure

```
whisp/
├── __init__.py        # version, package exports
├── __main__.py        # entry point: main()
├── py.typed           # pep 561 marker
├── cli.py             # argparse, exit code mapping
├── app.py             # orchestration (graceful/strict policy)
├── models.py          # Word, SpeakerTurn, Transcript dataclasses
├── errors.py          # WhispError base + specific errors with exit codes
├── timefmt.py         # [MM:SS]/[HH:MM:SS], duration formatting
├── filename.py        # output filename generation
├── format_md.py       # frontmatter + markdown rendering
├── segment.py         # words → speaker turns
├── align.py           # word-level speaker assignment
├── transcribe_fw.py   # faster-whisper adapter
├── diarize_pyannote.py# pyannote adapter
├── io.py              # atomic write, stdout, temp files
└── validate.py        # file exists, ffprobe validation
```

tests colocated: `module.py` → `module_test.py` (pytest configured in pyproject.toml)
