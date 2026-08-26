# darwin transcription

local transcription for Apple Silicon hosts. this replaces the dead `r56`
execution boundary without pretending that voice identification is
diarization.

## boundaries

- whisper.cpp and Metal handle ASR.
- Silero identifies speech, not speakers.
- known OBS tracks provide reliable speaker labels.
- mono recordings use closed-set ECAPA identification. short, low-similarity,
  and low-margin segments remain `unknown`.
- the durable `igor-pt-clean` centroid is included by default. it predates model
  revision metadata, so runs using it are always marked for review.
- raw ASR is retained. QC flags suspicious output rather than deleting it.
- `complete.json` is written last. its presence means artifact validation
  finished, not that humans approved the transcript.

Homebrew supplies whisper.cpp because the locked nixpkgs version trails the
version used by the proven local workflow. `doctor` records and checks that
mutable boundary.

## bootstrap

```bash
darwin-transcription models fetch
darwin-transcription doctor
```

models are revision-pinned and verified in
`~/Library/Caches/darwin-transcription/models`. model downloads are explicit so
a multi-gigabyte network transfer cannot make Darwin activation fail.

## profiles

enroll from isolated, single-speaker audio:

```bash
darwin-transcription profile enroll carol \
  "/path/to/carol-track.wav" \
  --language pt \
  --source-note "verified isolated OBS track"
```

the pipeline samples non-silent three-second windows and writes a durable
centroid under `01_files/_utilities/speaker-profiles`.

## transcription

mono archive audio requires at least two profiles:

```bash
darwin-transcription transcribe mono \
  "01_files/superwhisper/recordings/1754593864/output.opus" \
  --language pt \
  --profile "carol=01_files/_utilities/speaker-profiles/carol.ecapa.json"
```

known-track OBS recordings use absolute ffprobe stream indexes:

```bash
darwin-transcription transcribe tracks "00_inbox/session.mkv" \
  --language en \
  --track igor=2 \
  --track guest=3
```

each source/configuration/model fingerprint gets an immutable output directory
under `02_temp/darwin-transcription/<recording>/<fingerprint>/`.
