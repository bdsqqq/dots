---
name: making-brainrot-videos
description: "Turns a supplied script into a locally rendered brainrot or Reddit-story video over licensed footage, with narration and synchronized captions. Use for script-to-video production or revising its voice/edit; not script-only writing, ordinary summaries, post descriptions, UI animation or diagram-led explainers."
---

# making brainrot videos

turn a supplied script into a watchable narrated video. own footage, speech, timing, captions, rendering and verification—not script authoring.

## establish the brief from the request

- accept a plain-text script or structured spoken beats with optional hook/body roles, caption pages, emphasis and pronunciation notes. no particular writer, schema or other skill is required. preserve the supplied wording, qualifications and intended emphasis.
- identify duration, aspect ratio, privacy boundary and requested background. if a full video is requested from raw notes, use `writing-attention-scripts` for authoring first, then return here for production. for a script-only request, use that skill and stop before production.
- if only production is requested and no script is supplied, ask for it; do not silently author a different story. do not restart an investigation to narrate its findings.
- default to a 90–150-second, 720×1280 H.264/AAC video when unspecified. adapt to the actual request rather than padding or cramming material to hit a template.
- use local FFmpeg and open-source local speech/alignment by default. inspect model, voice, font and footage licenses. reuse installed tooling before installing alternatives; public dependency downloads do not authorize sending private text/audio to services.
- preserve existing outputs in a fresh versioned directory. a finished render stays frozen while revisions are made separately.

## source the background from a reusable footage bank

read [footage banks and provenance](references/footage.md) before choosing a clip.

1. match the requested genre literally. **Minecraft parkour means genuine first-person Minecraft parkour**, not procedural blocks, simulated gameplay, illustrations or slides. for other backgrounds, use the requested activity and inspect that it is actually shown.
2. look in CC/public-domain footage banks or creator collections that explicitly license reuse. prefer CC0/public domain or CC BY with clear provenance. a “no copyright” title, search filter or downloadable URL is not permission.
3. inspect the individual item's creator, original source, exact license/version and suitability for editing and intended distribution. retain the permission evidence and prepare credit before rendering. gameplay recording rights do not erase the game publisher's rights or policies.
4. download public footage without account access, cookies, purchases or circumvention. if a source fails, find another legitimate source in the requested genre; do not quietly substitute generated art. ask only if the requested genre or rights cannot be satisfied.
5. preview motion and the actual vertical crop. keep the next landing/action visible. prefer native vertical clips, continuous traversal, stable exposure and no distracting overlays, violent flashing, watermarks or music. avoid severe shader bloom at selection time; grading cannot recover clipped detail.

## prepare the script for production

1. freeze an editable copy of the supplied script. separate spoken text from section labels, citations and production directions; do not read stage directions aloud.
2. retain coherent sentence/paragraph synthesis units. derive short display pages without changing the spoken wording. keep negation and its claim together, and preserve adjacent qualifications.
3. use supplied hook/body/emphasis cues. when absent, choose display-only boundaries and sparse emphasis from existing words; do not invent a hook, consequence, joke or call to action.
4. retain spoken/display mappings for acronym pronunciation. if a script cannot fit the requested runtime intelligibly, report the conflict and ask whether to shorten it or extend the video; do not remove caveats or accelerate it into noise.

## settle the voice

- **voice quality is a separate iteration, not a solved dependency.** make a 15–25-second audition containing ordinary prose, a technical term and a transition before synthesizing the whole script. listen to it; inspect pronunciation, emphasis, pacing and sentence endings. if the user is choosing a new voice, present a small comparison rather than committing to an unreviewed full render.
- local Kokoro ONNX is a working baseline, not a required voice. choose available local open-source alternatives when they sound better and their terms fit. use stock generic voices, not celebrity/character cloning; no paid/hosted fallback without explicit authorization.
- synthesize coherent sentences or paragraphs for prosody. **do not synthesize each 2–5-word caption separately.** natural speech units and visual caption units are different. pronunciation text may expand acronyms; display text should stay readable. retain their mapping.
- freeze the narration WAV before word alignment. changing voice, speed, wording or pauses invalidates existing timings. do not try to repair mechanical delivery with faster captions or louder music.

## edit like a Reddit story, not a dashboard

use [the local production notes](references/local-production.md) for tooling and checks.

- full-bleed moving footage in the requested aspect ratio. use source-realistic 30 or 60 fps; do not manufacture smoothness by duplicating frames and calling it 60 fps.
- start speech and moving footage immediately. use single-word beats for the short opening, then graduate into stable **roughly 3–5-word semantic phrases**, usually one or two lines. a post card is optional only when requested/useful; it must not introduce a silent wait or hide the hook. never invent a real post, author, votes or endorsement.
- keep captions near the center but above the next landing/action. use fixed readable bold white text and a black outline/shadow, usually sentence case. rewrap or split pages instead of auto-shrinking; wording changes belong to an authorized script revision. choose semantic boundaries, not blindly every third word.
- emphasize a small number of meaningful phrases with colored letter fill; keep placement/word widths stable. ordinary body captions stay still. avoid a moving tight background box behind heavily outlined letters: the outline can swallow its color at phone size. restrained hook entrances are enough; every word need not bounce or change color.
- obtain real local acoustic timing/forced alignment where practical. reject zero-duration words, drift and text/audio mismatches. time selected word/phrase emphasis to actual speech. distinguish selective semantic emphasis from continuous karaoke; neither should be relabeled as the other. if reliable word timing is unavailable, disclose phrase-level timing—never fake equal-time word alignment.
- use restrained caption entrances, continuous footage and few cuts. no persistent large cards, opaque panels, border chrome or gratuitous transitions. the background must remain gameplay/footage, not a technical slide deck.
- keep background audio muted unless its rights and role are clear. narration must be intelligible without competing music. normalize loudness and measure the encoded result, not only the source WAV.

## preview, verify, freeze

1. render a **10–15-second final-resolution preview** and a representative 360×640 phone-size still before the full encode. inspect both with `view_media`; judge genre fit, actual motion, caption readability, action visibility, voice and sync—not just whether the render succeeded. correct proven defects, not every speculative reviewer comment.
2. render the full video. decode it end to end; verify streams, dimensions, fps, duration, audio amplitude/loudness, caption text coverage, timing, word durations and line fit. inspect a contact sheet across sections and lighting states.
   if bars are reported, distinguish encoded padding from the player's viewport: inspect SAR/DAR, decoded frames and the actual viewer. when downloaded playback is full-bleed but an embedded player adds bars, do not crop away gameplay to compensate. do not claim the viewing problem is fixed from file checks alone.
3. inspect the entire encoded timeline with `view_media` for the actual spoken claims, audio, captions and motion. if the inspector cannot ingest it, use consecutive stream-copy excerpts covering the whole timeline; do not replace full review with a few stills. corroborate a questionable inspection claim against frames/audio before changing the edit.
4. freeze the accepted encode. package matching editable narration, word/phrase timing, captions, renderer, pinned dependency instructions, provenance, credits/licenses, measured verification and checksums. omit private subject material from a reusable skill/template. include footage only when its size and redistribution terms fit; otherwise retain it locally and provide a provenance-documented downloader. public availability and byte identity are not guaranteed.
5. smoke-test the extracted package with the actual renderer. report what ran, what was inspected, remaining voice/source limitations, exact output paths and delivery state. do not imply a clean-machine install, runtime claim validation or publication occurred when it did not. stop after the accepted cut; optional polishing is a new revision.

## references and regression cases

- [footage banks and provenance](references/footage.md)
- [local production and previous lessons](references/local-production.md)
- [selection and behavior cases](references/cases.md)
