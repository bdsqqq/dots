# local production notes

the workflow is portable; the earlier M5 implementation is evidence, not a dependency. do not require the old audit project or copy its reports into this skill. if continuing that exact edit, use its frozen package rather than rebuilding it from memory.

## inspect before installing

check FFmpeg/ffprobe capabilities, the available Python environment, fonts, public download tooling and local speech/alignment models. the successful implementation used FFmpeg with libx264, libass, AAC and loudnorm; Kokoro ONNX; Pillow for an original opening card; and wav2vec2 CTC forced alignment. no browser compositor or Remotion was needed.

keep narration, footage, word timing and caption rendering separate so a voice change does not require replacing the whole renderer. avoid a framework or full generic pipeline when a small project script owns the job.

## speech lessons

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) declares Apache-2.0; [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) is MIT. inspect current weight/voice declarations and dependencies, not just the library license. phonemizer/eSpeak NG bring GPL notices. Piper is an alternative only after checking the particular implementation and voice-model licenses; voice terms can differ.
- Kokoro stock `af_heart` at speed `1.2` was executable locally, but Igor found the result **super unnatural**. that combination is not an accepted quality preset. the cause was not isolated: voice choice, delivery speed and short synthesis units may contribute. audition rather than asserting a diagnosis.
- test coherent sentence/paragraph synthesis, sensible pauses, spoken acronym forms and a small number of stock voices/speeds before full generation. compare the same passage, normalize audition levels, and listen to the actual audio rather than judging an engine name or model card.
- retain float audio until gain is chosen. the earlier TTS float output exceeded PCM full scale; measure the peak before converting to int16 to avoid overflow. apply uniform gain when appropriate, then normalize the final narration mix and remeasure after AAC encoding.

## real word timing

the workable local path used [facebook/wav2vec2-base-960h](https://huggingface.co/facebook/wav2vec2-base-960h), revision `22aad52d435eb6dbaf354bdad9b0da84ce7d6156` (Apache-2.0), with Transformers and torchaudio CTC forced alignment on CPU. pin compatible package versions from the environment that actually works; torchaudio API availability changes.

1. keep the final recorded/synthesized WAV and its exact spoken transcript. preserve the mapping from spoken acronyms or expanded numbers to display words.
2. align coherent measured speech units against real audio. use token/acoustic spans to obtain word onsets/ends, then map them back to the global timeline. never divide a sentence duration by its word count.
3. reject missing words, zero-duration spans, time reversals and audio/transcript mismatch. check both an ordinary sentence and a technical acronym by listening/watching. forced alignment can produce plausible times for a wrong transcript; shape checks alone do not validate pronunciation or truth.
4. derive visual phrases independently: generally 3–5 display words and at most two fixed-size lines. the short hook may use single-word beats, except protected claims/negations. change selected emphasis at aligned onsets; ordinary body pages stay static. acoustic and frame quantization make boundaries approximate; do not promise sample-perfect lip sync.

an earlier local Whisper attempt produced drifting/zero-duration words and was discarded. this is evidence about that attempt, not a claim all Whisper-based aligners fail. if the installed aligner does not work reliably, change it or explicitly use phrase highlighting; do not relabel interpolation as forced alignment.

## rendering choices

- scale/crop the approved source to the target frame while preserving the action. inspect representative jumps after the crop. choosing a less bloomed clip is better than trying to recover clipped pixels.
- ASS/libass can render fixed-size outlined captions, word-color changes and a small scale entrance without a browser. keep caption colors and coordinates separate from background grading.
- accept the supplied script's hook/body/emphasis intent before synthesis. `writing-attention-scripts` owns authoring when requested; this production skill also works with scripts from any other source. a previous hybrid used immediate single-word hook beats, semantic body pages and sparse yellow letter fill, replacing constant blue current-word boxes. preserve those editorial cues without silently rewriting the speech; no audience-retention lift was measured.
- prefer one continuous segment long enough for the narration. if a loop or cut is necessary, select a natural seam; no reverse playback, speed ramps or arbitrary transitions to fill time.
- choose encoding bitrate from the duration and delivery limit. reserve room for AAC/container overhead; high-motion gameplay compresses less cleanly than slides. use two-pass x264 or another measured encoding strategy, then check actual size. do not reduce readability or falsify source fps to hit a nominal target.

## execute media checks

the following commands inspect an existing final file; replace the path. retain results in the project verification record.

```sh
ffprobe -v error -show_streams -show_format -of json final.mp4
ffmpeg -v error -xerror -i final.mp4 -f null -
ffmpeg -hide_banner -i final.mp4 \
  -af 'loudnorm=I=-17:TP=-2:LRA=7:print_format=json' -f null -
ffmpeg -hide_banner -i final.mp4 -vn -af volumedetect -f null -
ffmpeg -hide_banner -i final.mp4 \
  -vf 'freezedetect=n=-50dB:d=1' -an -f null -
```

for loudnorm measurement, read **input** loudness/true peak from its analysis result: those describe the existing encoded file. the output fields describe a hypothetical normalization pass, not the file on disk. around −17 LUFS and a peak below 0 dBTP were workable starting points; listen for comfort and clipping rather than claiming those numbers prove good delivery. an absence of detected freezes proves neither genuine gameplay nor correct cropping; inspect actual video too.

caption checks should compare complete displayed text against the intended narration, verify monotonic nonzero word times within the audio, check phrase boundaries and count/measure wrapped lines at the actual font/size. validate both sides of transitions and the longest technical compound. inspect active colors in frames across a spoken phrase if a reviewer claims highlighting is absent.

distinguish encoded padding from a player's viewport. inspect square-pixel geometry and decoded frames, and compare downloaded playback when available. a crop detector should catch a deliberately padded control before its no-bars result is trusted. player-added bars are not grounds to crop the source further. distinguish a reviewer's misread of displayed acronyms from the deliberate spoken expansion used for TTS; compare the frame and the caption source before changing either.

extract a contact sheet covering the opening, sections, longest caption and bright/dark footage; also extract a representative phone-size still. inspect the actual images with `view_media`. watch/listen to the complete encoded timeline; when tool upload expansion prevents one full-file inspection, split it into consecutive stream-copy segments and cover the end without a gap.

## delivery and freeze

keep the MP4, editable narration, final WAV, word/phrase JSON, ASS/SRT as applicable, small renderer, prerequisite/setup instructions, provenance, license notices and measured verification together. a ZIP can omit public model caches and oversized footage if it includes reproducible download instructions. do not redistribute a private source report merely because the media template is reusable.

test the extracted package against the available environment. report a clean-machine install as untested unless actually executed. binary-identical video output across renders is not required; matching source inputs, correct decoded output and executed checks matter. after freezing, compute SHA-256 for the video and package in an **external** delivery manifest; an archive cannot contain its own final hash. verify the package contains the latest renderer, caption inputs, README and metrics.

## provenance of this method

inspired by [c-ehrlich/pr-brainrot](https://github.com/c-ehrlich/pr-brainrot), inspected at [`6d37b8a61406f3aba07530f8c9f0a64df7845d50`](https://github.com/c-ehrlich/pr-brainrot/commit/6d37b8a61406f3aba07530f8c9f0a64df7845d50), including its actual example and caption/config implementation. the reference established genuine first-person parkour, short outlined captions and yellow active words; it did not authorize reuse of its application code, footage, character assets or voices. do not install its paid voice/model/upload pipeline merely to copy the editing genre.

production evidence and corrections: [original local production thread](https://ampcode.com/threads/T-01a16ad5-ef4c-760b-b795-f8b8e86cfded). procedural block art was rejected; genuine gameplay with Reddit-story editing matched the requested direction; voice naturalness remains unresolved. the lesson is a reproducible method with explicit limits, not that this one render is a universal aesthetic preset.
