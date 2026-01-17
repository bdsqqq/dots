# whisp

audio → commonplace-compatible markdown. optionally with speaker diarization.

## jobs to be done

| # | job | trigger | outcome |
|---|-----|---------|---------|
| 1 | transcribe with diarization | explicit invocation with file path | markdown transcript with raw speaker IDs + timestamps |
| 2 | commonplace-compliant output | transcription completes | file named per conventions, frontmatter with source metadata |

## topics of concern

| topic | jtbd | one-sentence | sections |
|-------|------|--------------|----------|
| transcription | 1 | converts audio to text with word timestamps | [pipeline](#pipeline), [model defaults](#model-defaults), [language detection](#language-detection) |
| diarization | 1 | identifies which speaker said each word | [alignment](#alignment-word-level-assignment), [speaker count](#speaker-count-behavior), [memory](#memory-and-long-files) |
| output-format | 2 | produces commonplace-compliant markdown | [output format](#output-format), [empty audio](#empty-audio--silence) |
| cli | 1,2 | parses arguments and validates inputs | [cli](#cli), [supported formats](#supported-formats) |
| error-handling | 1,2 | manages failures gracefully with specific exit codes | [error handling](#error-handling), [partial output](#partial-output) |

## scope

one job: `whisp <file>` → markdown transcript (with raw speaker IDs and timestamps if diarization enabled; timestamps only if `--speakers 1`).

no subcommands. no daemon. no watch mode. looping is consumer's concern.

## pipeline

```
audio file
    → faster-whisper (transcription + word timestamps)
    → pyannote.audio (speaker diarization) [unless --speakers 1]
    → align speakers to words
    → format as markdown
    → stdout (or file via -o)
```

## decisions

### diarization is optional (default: enabled)

pyannote runs unless `--speakers 1` is passed. single-speaker audio skips diarization entirely — this is a valid use case, not degradation.

when `--speakers 1`: output contains timestamps only, no speaker labels. this differentiates intentional single-speaker mode from diarization failure (which uses UNKNOWN).

rationale: the pipeline's value is audio → commonplace markdown. diarization adds "who said what" when relevant, but N=1 recordings are common and shouldn't pay the diarization cost.

### alignment: word-level assignment

the hard problem: whisper and pyannote operate independently. whisper produces words with timestamps. pyannote produces speaker segments with timestamps.

chosen approach: assign each word to the speaker whose segment contains its midpoint.

```python
def align_words(words, diarization):
    for word in words:
        midpoint = (word.start + word.end) / 2
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            if turn.start <= midpoint <= turn.end:
                word.speaker = speaker
                break
        else:
            word.speaker = "UNKNOWN"
    return words
```

this handles:
- speaker changes mid-sentence (each word assigned correctly)
- overlapping speech (word goes to speaker with segment covering its midpoint)

tradeoff: requires `word_timestamps=True` in faster-whisper. worth it — segment-level majority vote mislabels overlapping voices, which degrades output quality unacceptably.

### model defaults

| device | whisper model | compute_type | rationale |
|--------|---------------|--------------|-----------|
| cuda | large-v3 | float16 | best accuracy, gpu handles it |
| mps | large-v3 | int8 | mps supported via cpu fallback in ctranslate2 |
| cpu | medium | int8 | large-v3 too slow on cpu |

override with `--model`. no `--device` flag — backend determined at install time by uv.nix.

hunch: distil-large-v3 might be better default for mps. needs benchmarking.

note on darwin performance: whisper.cpp with ANE is ~2x faster than faster-whisper on apple silicon (51s vs 113s for 200s audio). but whisper.cpp lacks pyannote integration. for batch processing, unified python stack wins over speed. revisit if users complain.

### output format

speaker labels use raw pyannote IDs (e.g., `SPEAKER_00`, `SPEAKER_01`). consumer handles mapping to human names if needed.

#### multi-speaker (diarization enabled)

```markdown
---
source: ./recording.m4a
duration: 5m 42s
speakers:
  - SPEAKER_00
  - SPEAKER_01
model: large-v3
transcribed: 2026-01-17T14:30:00Z
---

# transcript: recording.m4a

**[00:00]** SPEAKER_00: first segment of speech.

**[00:14]** SPEAKER_01: response from second speaker.

**[01:23]** SPEAKER_00: back to first speaker.
```

#### single-speaker (`--speakers 1`)

no speaker labels, timestamps only:

```markdown
---
source: ./recording.m4a
duration: 5m 42s
speakers: []
model: large-v3
transcribed: 2026-01-17T14:30:00Z
---

# transcript: recording.m4a

**[00:00]** first segment of speech.

**[00:14]** continuation of transcript.

**[01:23]** more content.
```

#### diarization failure (graceful degradation)

all segments labeled UNKNOWN to indicate failure:

```markdown
**[00:00]** UNKNOWN: first segment of speech.
```

filename: `YYYY-MM-DDTHH-MM <original-name> -- source__transcript.md`

timestamp in filename comes from file mtime, falls back to transcription time.

duration: human-readable format (`5m 42s`, `1h 5m 42s` for >= 1hr).

timestamp granularity: segment-level only. `[MM:SS]` for <1hr, `[HH:MM:SS]` otherwise.

### segmentation

words group into paragraphs. new paragraph starts when:
1. speaker changes, OR
2. gap between consecutive words > 1.5s

this produces readable chunks without NLP overhead.

### stdout default

```bash
whisp meeting.m4a              # prints to stdout
whisp meeting.m4a -o out.md    # writes to file
whisp meeting.m4a > out.md     # equivalent
```

rationale: unix philosophy. enables piping, redirection, composition. `-o` exists for convenience.

### error handling

default: graceful degradation.

if diarization fails mid-run:
1. warn to stderr
2. continue with transcription only (all segments labeled UNKNOWN)
3. exit 0 — output is still useful

override with `--strict`: any component failure → hard exit with specific code.

rationale: most users want some output over nothing. strict mode for pipelines that require guarantees.

### exit codes

| code | meaning |
|------|---------|
| 0 | success |
| 1 | general error |
| 2 | invalid arguments |
| 10 | file not found |
| 11 | unsupported format |
| 20 | model download failed (best-effort detection) |
| 30 | diarization failed (only with --strict) |
| 31 | hf token missing/invalid |

grouped by domain. room to grow.

### partial output

no partial files on failure. write to temp, atomic rename on success.

rationale: partial transcriptions are usually useless. leaving garbage creates cleanup burden.

exception: `--keep-partial` preserves temp file as `.partial` on failure. use for debugging very long files.

## cli

```
whisp - transcribe audio to markdown

usage: whisp [options] <file>

arguments:
  file                  audio file to transcribe

options:
  -o, --output PATH     write output to file (default: stdout)
  --model MODEL         whisper model: tiny|base|small|medium|large-v3
  --language LANG       ISO 639-1 code (default: auto-detect)
  --speakers N          expected speaker count (1 = skip diarization)
  --strict              fail hard on any component error
  --keep-partial        preserve partial output on failure
  -v, --verbose         print progress to stderr
  -h, --help            show this help
```

stdin not supported. audio requires random access.

## supported formats

faster-whisper uses ffmpeg internally. any format ffmpeg decodes is supported: mp3, m4a, wav, flac, ogg, webm, mp4, mkv, etc.

validation: run `ffprobe -v error` at CLI stage. if ffprobe fails, exit 11.

## language detection

default: auto-detect via whisper's built-in language detection.

if detection confidence is low, whisper proceeds with best guess. no failure mode — low confidence transcription is still useful.

`--language` overrides detection entirely. use when you know the language and want to skip detection overhead.

## speaker count behavior

`--speakers N` is a hint to pyannote, not a constraint. pyannote may find more or fewer speakers than specified.

common scenario: `--speakers 2` on a meeting recording, but pyannote finds 3 (background voice, brief interjection). output will contain SPEAKER_00, SPEAKER_01, SPEAKER_02.

this is expected behavior. diarization often miscounts — the hint improves accuracy but doesn't guarantee exact count.

## empty audio / silence

if audio contains no detected speech, output includes:

```markdown
---
source: ./silence.m4a
duration: 0m 42s
speakers: []
model: large-v3
transcribed: 2026-01-17T14:30:00Z
---

# transcript: silence.m4a

[...silence]
```

this is valid output, not an error. the file was processed successfully; it just contained no speech.

## dependencies

already in uv-global pyproject.toml:
- faster-whisper
- pyannote.audio
- torch (backend selected per host)

runtime:
- HF_TOKEN env var (required for pyannote gated models)

### open diarization alternatives

pyannote requires accepting a license on huggingface (gated model). if this becomes a blocker:

| option | license | notes |
|--------|---------|-------|
| nvidia nemo | Apache 2.0 | fully open, heavier setup |
| speechbrain | Apache 2.0 | diarization recipes, more DIY |
| resemblyzer | Apache 2.0 | embeddings only, build clustering yourself |

for v1, accept pyannote license (one-time click) and use HF_TOKEN. defer nemo exploration if gating becomes pain.

## memory and long files

pyannote is the memory bottleneck — it loads full audio and accumulates speaker embeddings globally.

| audio length | approx ram (combined pipeline) | notes |
|--------------|-------------------------------|-------|
| < 1hr | ~4-6GB | safe on 8GB device |
| 1-2hr | ~6-10GB | marginal on 8GB, safe on 16GB |
| 3hr+ | ~12GB+ | OOM risk on 16GB, needs mitigations |

**observed failure modes:**
- pyannote OOM at embedding clustering phase for 4hr+ audio
- faster-whisper generally handles long files well (streams 30s chunks internally)

**mitigations for constrained devices:**
- reduce `embedding_batch_size` in pyannote (32 → 4 saves ~0.5GB)
- use `--speakers 1` to skip diarization entirely (faster-whisper alone handles long files)
- accept that 3hr+ files with diarization may fail on 8GB devices

**chunking diarization is hard:**
pyannote builds global speaker clusters. chunking breaks identity continuity — "Speaker 1" in chunk A ≠ "Speaker 1" in chunk B without post-hoc matching.

for v1: document limits, recommend users with 8GB RAM skip diarization for files > 1hr. chunked diarization is a v2 concern if users hit this wall.

## open questions

1. **mps benchmarking** — need to validate actual performance on m2 before shipping. current data suggests faster-whisper is 2x slower than whisper.cpp on darwin. acceptable for batch, but should document.

2. **overlap annotation** — pyannote 3.1 detects overlapping speech. currently discarded. could add `[overlap]` marker in output. defer decision until v1 is validated.

3. **chunked diarization** — if users hit memory walls, implement overlapping-chunk approach with speaker embedding matching at boundaries. deferred to v2.
