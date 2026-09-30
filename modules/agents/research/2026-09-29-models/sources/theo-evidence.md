# theo model evidence — 2026-09-29

## result and limits

VERIFIED: acquired and read the full automatic captions for [gpt-6.1 sol](https://www.youtube.com/watch?v=vu8X3YroB-w), plus the [pacing discussion](https://www.youtube.com/watch?v=IBcBKgYUghU). read both existing opus/model-selection transcripts in full without copying them.

the september 28 saved inventory does **not** contain the september 29 sol video. a fresh, bounded eight-upload inventory located it. the channel listing called it “Sol 6.1 is Astra with Sonnet Pricing”; video metadata called it “OpenAI fights back”. both captures are preserved; this is a title discrepancy, not evidence of different videos.

all findings below are VERIFIED **as caption-supported statements**, not independently verified model capabilities, prices, audio wording, or speaker attribution. automatic captions repeatedly render sol as “Soul”, claude as “cloud”, and some prices without decimal points. raw bytes and reading copies are unchanged. no cookies, audio, or video were acquired. two caption download attempts total, both successful; metadata-only discovery probes were additional.

## source artifacts

paths in this section are relative to this document:

- [sol reading copy](vu8X3YroB-w.md), [raw captions](vu8X3YroB-w.en-orig.json3), [full yt-dlp metadata](vu8X3YroB-w.metadata.json), [manifest](vu8X3YroB-w.manifest.json), [download log](vu8X3YroB-w.download.log).
- [pacing reading copy](IBcBKgYUghU.md), [raw captions](IBcBKgYUghU.en-orig.json3), [full yt-dlp metadata](IBcBKgYUghU.metadata.json), [manifest](IBcBKgYUghU.manifest.json), [download log](IBcBKgYUghU.download.log).
- [refreshed inventory](channel-inventory-latest8.json); [original inventory](../../2026-09-28/sources/channel-inventory.json).
- [opus 5.5, september 25](../../2026-09-28/sources/ejjBbaq9RmY.md), https://www.youtube.com/watch?v=ejjBbaq9RmY.
- [model selection, september 18](../../2026-09-28/sources/iBrAWpjXNxs.md), https://www.youtube.com/watch?v=iBrAWpjXNxs.

## gpt-6.1 sol: evidence and counterevidence

| timestamp / reading-copy lines | supported claim | attribution / limitation |
|---|---|---|
| [01:22–01:34](https://www.youtube.com/watch?v=vu8X3YroB-w&t=82s), 46–53 | early access; theo says openai did not pay him and controlled publication timing, not wording. | author disclosure, not independently audited. |
| [03:38–04:13](https://www.youtube.com/watch?v=vu8X3YroB-w&t=218s), 121–140; [09:05–09:20](https://www.youtube.com/watch?v=vu8X3YroB-w&t=545s), 269–276 | his terminal bench results are provisional: two misconfigured runs, initially no medium run, incomplete max results backfilled with xhigh, three h100-dependent tasks omitted, local vms. | author-run modified benchmark, NOT a clean vendor or independent leaderboard comparison. |
| [04:15–05:02](https://www.youtube.com/watch?v=vu8X3YroB-w&t=255s), 141–159; [21:07–21:34](https://www.youtube.com/watch?v=vu8X3YroB-w&t=1267s), 610–620 | reports sol low matching opus max's deep-swe score at roughly 21 cents / 4.8 minutes versus about 50 minutes and roughly 70× cost. | author's benchmark claim; task/effort-specific, not general real-world speed or cost. first price transcription is ambiguous, later “21 cents” is explicit. |
| [07:07–07:53](https://www.youtube.com/watch?v=vu8X3YroB-w&t=427s), 215–234 | quotes $2/m input, $10/m output, $0.10/m cache reads; same headline price as gpt-6 sol and one fifth astra. | reported release pricing; not verified against vendor documentation here. |
| [10:56–12:35](https://www.youtube.com/watch?v=vu8X3YroB-w&t=656s), 320–370 | says astra's inconsistency is fixed “mostly, not entirely”; lower peaks, below opus in some 3d tasks, below astra in computer use but useful daily. | author experience, explicitly qualified. invoices/wire-form anecdote retained human send approval; not evidence autonomous money transfers are safe. |
| [13:08–14:45](https://www.youtube.com/watch?v=vu8X3YroB-w&t=788s), 387–430 | deep review/audit strength. orchestrator audit roughly astra quality at half cost, but opus and sonnet were cheaper and less thorough there. t3 improvement test: sol 87.4, astra 83.8, grok 80.7; sol $2.15, opus $5, sonnet nearly $9. | author's local tests and judging; no universal ranking. crucial counterexample to “sol always costs less than opus”. |
| [14:50–15:57](https://www.youtube.com/watch?v=vu8X3YroB-w&t=890s), 432–463 | reads an opus-generated assessment: strong scoped work, weaker long unattended building, process obedience can stop progress without asking for help; first drafts had bugs. | model-generated assessment of theo's traces, not an independent evaluator. |
| [15:59–17:02](https://www.youtube.com/watch?v=vu8X3YroB-w&t=959s), 464–496 | theo corroborates stalled typescript-to-rust work despite token use; prefers opus for heavy unattended rewrites. sol and opus both made fleet-management mistakes; astra did better there. | author anecdotes, no controlled equal-harness comparison. |
| [17:44–19:31](https://www.youtube.com/watch?v=vu8X3YroB-w&t=1064s), 516–567 | model-generated cost analysis emphasizes cached reads; claimed 96% cache reads and $1,550 repricing versus $5,700 guessed-price total. separate comparison reports smaller average request context than sonnet. | scoped to his analyzed sessions; not a universal cache-hit rate or independently checked bill. “bloated system prompts barely matter” concerns cost, not behavioral quality. |
| [21:34–22:14](https://www.youtube.com/watch?v=vu8X3YroB-w&t=1294s), 620–638 | proposes opus calling sol for investigation, root cause analysis, triage, and review, while retaining opus as primary implementation model. | proposed personal workflow, not a tested prescription for this repository. |
| [22:20–25:36](https://www.youtube.com/watch?v=vu8X3YroB-w&t=1340s), 641–722 | attractive fish/submarine graphics and useful blender modeling, but poor ui taste, excessive text, worse movement/frame rate, weak game loop. | author demo commentary; no visuals/audio inspected in this task. |
| [26:06–27:43](https://www.youtube.com/watch?v=vu8X3YroB-w&t=1566s), 736–786 | early-access restrictions prevented coding into public projects, skewing use toward internal projects and audits. reports finding blocked follow-up messages and disappearing setup-progress regressions via code reading plus computer use. | strong harness/access confound; bug claims not independently reproduced here. |
| [27:51–30:15](https://www.youtube.com/watch?v=vu8X3YroB-w&t=1671s), 790–861 | “I like using them in tandem”; sol reviews/details, opus collaborates/implements. sol later found unused legacy code left behind by opus's successful rewrite. sol replaces sonnet for him, not opus. | author's actual conclusion contradicts interpreting “better than astra” as best at every task. captions confuse model names around 28:26; do not quote that passage as an exact completion attribution. |

no clear general-purpose sol effort default is prescribed in this transcript. low performs well on one benchmark; high/xhigh/max numbers have the disclosed limitations. do not infer “always use low” or transfer opus effort guidance to sol.

## opus 5.5: operating advice and caveats

| timestamp / existing reading-copy lines | supported claim | attribution / limitation |
|---|---|---|
| [00:00–00:14](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=0s), 10–18 | likes output code, interaction, and staying on task for long work, except max. | theo's experience. |
| [02:28–03:54](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=148s), 92–131 | hand over whole tasks with observable completion: feature, screenshot, pr. remove generic “think carefully” language. | reading/discussing addy osmani's anthropic guide, with theo's endorsement and examples. |
| [04:15–05:11](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=255s), 142–174 | says a max run stalled for 6.5 hours, then completed about ten minutes after switching to high and requesting continuation. | single sequential anecdote; prior work/context and intervention confound effort comparison. |
| [08:02–11:41](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=482s), 261–366 | define done and genuine reasons to ask; his remote-run example still stopped after phase zero despite a broader request. | direct counterexample to unconditional autonomy claims. |
| [12:01–14:45](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=721s), 375–448 | recommends high or xhigh; says xhigh slightly slower, high sometimes misses details. skatebench xhigh→max: 78→79%, average tokens 338→5,000, average response time 6→50 seconds; says 13× cost. | author's benchmark and interpretation. his assertion that max forces thinking is not a verified api contract. |
| [16:19–18:17](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=979s), 494–552 | not necessarily better zero-direction design than fable; benefits from explicit positive/negative direction and annotated screenshots. | theo's observations plus vendor-guide advice. |
| [18:18–21:06](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=1098s), 553–642 | define stop conditions, preserve destructive-action approval, ask for subagents for broad audits/migrations/reviews. theo says opus otherwise seems reluctant to delegate. | guide advice and author experience separated; runtime support for subagents is assumed. |
| [22:29–25:14](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=1349s), 684–762 | favors cross-family review; openai finds more issues but also more irrelevant ones. opus 5.5 improves over opus 5 in his local test. reviewers should mark unverifiable claims and use browser/runtime/tests. | personal comparisons; old sol references here are **gpt-6 sol**, not gpt-6.1 sol. |
| [25:53–26:46](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=1553s), 784–812 | guide describes safety flags switching to older models and settings to pause/error instead; theo reports fewer flags recently. | vendor-guide behavior relayed by theo, not runtime-tested here. |

## earlier “stupid models” video: do not flatten chronology

- [03:27–06:31](https://www.youtube.com/watch?v=iBrAWpjXNxs&t=207s), lines 118–204: theo explicitly accepts that switching from astra to older sol can improve experience because astra is inconsistent. he admits overrating opus 5 earlier. this is september 18, **before opus 5.5 and sol 6.1**.
- [08:55–10:38](https://www.youtube.com/watch?v=iBrAWpjXNxs&t=535s), lines 269–314: rerun previously failed tasks when evaluating new models; narrow well-specified tickets may not expose differences. his desired workflow starts with a bug screenshot and ends with tested, recorded, reviewed changes.
- [12:22–13:11](https://www.youtube.com/watch?v=iBrAWpjXNxs&t=742s), lines 364–388: credits another developer's overnight runs for exposing tooling/codebase failure cases; advocates fixing the environment rather than only prompts. not proof model choice alone causes success.
- [18:48–20:07](https://www.youtube.com/watch?v=iBrAWpjXNxs&t=1128s), lines 546–584: argues for valuing preparation/review time alongside token spend; explicitly excludes students and people who cannot afford expensive subscriptions from his criticism. quoted subscription-equivalent usage is dated, not a current entitlement.
- [21:29–24:05](https://www.youtube.com/watch?v=iBrAWpjXNxs&t=1289s), lines 621–685: author reports longer historical runs, then gives a hypothetical compounded-failure example. duration is not verified successful output; toy independent-window arithmetic is not empirical proof of exponential capability growth.

## verification

reused normalization and timestamp functions from the september 28 acquisition script. [helper](acquire_theo.py) verifies raw and metadata sha256, inventory hash/membership, channel/id/duration, monotonically ordered caption starts, near-start/end coverage, counts, and exact normalized reading-copy equality.

| artifact | rows / words | first–last caption starts | video duration | largest caption-start gap |
|---|---|---|---|---|
| sol 6.1 | 873 / 6,329 | 4.08–1855.52 seconds | 1858 seconds | 7.12 seconds |
| pacing | 765 / 5,304 | 0–1648 seconds | 1649 seconds | 4.081 seconds |

- sol raw sha256: `c0db1df5e18f6f882f19c903b9d85622204e8a543ef19eaf4425b2ef1e1e5d74`.
- sol metadata sha256: `844e8541983423a9f0dead12842f9b48ef1b7d3c2fed3116280343587d542ce5`.
- both new artifact checks passed. isolated temporary-copy corruption of raw captions was rejected.
- `python3 -B modules/agents/research/2026-09-28/verify.py` passed: 15 existing caption hashes/reading copies, 109,809 words, 74 local links.
- coverage checks establish preservation of the supplied caption event stream, not that every spoken word was captioned. no audio accuracy, vendor pricing, model performance, or live harness claims were independently verified.
- all writes stayed within this `sources/` directory. no live config, prior transcript, commit, or deployment changed.
