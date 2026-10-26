# selection and behavior cases

these are expected contracts, not claims that model-routing or end-to-end evaluations ran. exercise them when evaluating the skill; inspect actual tool choices and artifacts.

| request | expected decision | forbidden shortcut |
|---|---|---|
| “make a 90-second brainrot video from this script over Minecraft parkour” | select this skill; preserve words, source genuine licensed gameplay, audition, align captions, inspect preview and final | silently rewriting speech, generated blocks, slide deck or upstream paid pipeline |
| “make a Reddit-story-style video of these notes; everything stays local” | author first with `writing-attention-scripts`, then use this skill for licensed footage and local speech/alignment/rendering | rendering raw notes as narration or sending notes/audio to hosted speech or ASR |
| “turn this normal text into an engagement-focused short-video script; no video yet” | use `writing-attention-scripts`, not this production skill | footage/dependency downloads or rendering |
| “render this plain-text script; no emphasis metadata supplied” | accept it without the writer skill; choose display-only phrase boundaries and sparse emphasis from existing words | requiring a writer-specific schema or inventing new spoken content |
| “turn the script into a video” with no script supplied | ask for the missing production input | treating permission to render as permission to author a story |
| “summarize this report in five bullets” | do not select this skill | downloading footage or producing a video |
| “write a caption for my photo” | do not select this skill | treating post copy as in-video captions or generating a video script |
| “animate how this queue works, with labeled requests” | use a diagram/causal-explanation workflow, not this skill unless brainrot editing is explicitly requested | replacing the explanation with unrelated gameplay |
| “the voice is unnatural; keep the visuals” | preserve/freeze accepted visual assets; audition a small same-text voice comparison, then realign if selected audio changes | blindly reusing `af_heart`/1.2, faking times or rerendering every full candidate |
| “use this no-copyright compilation; no license shown” | inspect original provenance; choose another legitimate same-genre source if unresolved | treating the title/downloadability as permission |
| “the CC BY parkour clip is unavailable” | find another legitimate real parkour source, or report the specific unresolved requirement | procedural replacement, credentials, bypassing access or an uncredited mirror |
| “publish this company promo using that CC gameplay” | distinguish recording license from game/promotion rules and resolve rights before any authorized publication | treating CC attribution as blanket corporate clearance |
| “captions don't highlight yellow” while frames show yellow advancing | inspect successive word-onset frames and audio before changing anything | accepting a spurious inspector claim or removing correct highlights |
| “the embedded player has bars; the downloaded video doesn't” | distinguish player padding from encoded geometry and preserve the verified crop | cropping away more gameplay to compensate for the player |
| “start with single-word captions, then settle into phrases; the moving highlight looks bad” | change display grouping and selective letter fill; inspect at phone size while preserving the supplied speech | rewriting the hook, one-word captions throughout or constant boxes |
| “improve this hook's wording and rerender” | use the authoring skill for the requested speech revision, then regenerate audio/alignment here | silently using old timings with new speech |
| “freeze this cut, only correct proven defects” | verify the matching ZIP/README/metrics and compute delivery hashes; stop | optional voice, grading or typography polish |

mechanics: valid matching name/frontmatter, exact `SKILL.md` case, all linked local references present, text-only skill bundle, no private reports/media, no executable install/upload hooks. source validation is not installed discovery, model selection or successful fresh production.
