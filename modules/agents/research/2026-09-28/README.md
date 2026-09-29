# fewer reminders, better feedback

research date: 2026-09-28. **proposal, not installed policy.**

the most useful next move is not another agent framework. it is to repair the
instruction/tool contract, reduce redundant context, and make completion easier
to verify. then test whether bounded parallel work saves *your* attention.

this is a hypothesis about productivity, not a measured improvement. we found
concrete local inconsistencies; the videos and repositories establish what their
authors recommend, not that copying them will improve this setup.

## what was done

- screened the latest **150 uploads** on [theo's channel](https://www.youtube.com/@t3dotgg/videos).
- downloaded **15 timestamped automatic transcripts**, covering **8h 38m** and
  **109,809 caption words**. **12/15** fall within june 28–september 28.
- assigned four non-overlapping transcript groups to summarization agents.
- separately audited local instructions/skill loading and researched poteto's
  official repositories. pstack is pinned to
  [`adf3218`](https://github.com/cursor/plugins/tree/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack).
- preserved sources, caveats, disagreements, and proposed evaluation cases.

no live skills, memory settings, model defaults, or tool policies were changed.
no installation, activation, commit, push, publication, or model-comparison run
was performed. unrelated concurrent changes under `modules/pi` were left alone.

### read this, then choose a slice

| artifact | purpose |
|---|---|
| [skill authoring guidance](skill-authoring.md) | proposed writing/revision procedure, template, and test cases |
| [local baseline](local-baseline.md) | traced setup defects, existing strengths, and probe limitations |
| [verification record](verification.md) | checks run, independent corrections, and remaining coverage gaps |
| [poteto research](poteto.md) | pinned principles, source conflicts, and harness assumptions |
| [instructions and skills](summaries/instructions-and-skills.md) | global/project split, descriptions, examples, selective adoption |
| [context and verification](summaries/context-and-verification.md) | memory quality, architecture, disposable probes, review |
| [planning and orchestration](summaries/planning-and-orchestration.md) | planning, loops, delegation, supervision, workflow evolution |
| [interfaces and models](summaries/interface-and-models.md) | human coordination, dictation, observability, model selection |

## the synthesis

### 1. fix contradictions before adding instructions

**VERIFIED locally:** `remember` recommends retrieval fallbacks the global
instructions prohibit; `dig` prescribes verification delegation without the
global “only when useful” threshold; broad `write`/`review` triggers reload
already-present policy. the custom skill tool also accepts an `arguments`
parameter its executor does not consume. see
[baseline findings 1–6](local-baseline.md#findings), including falsification.

**recommendation:** reconcile these contracts first. neither more prose nor a
new orchestration layer can reliably compensate for inconsistent instructions.
remove duplication only after preserving the actual preferences and boundaries.

this follows theo's advice to change guidance in response to observed failures,
not copy his file ([august 11, 19:03](https://www.youtube.com/watch?v=e1snsuY4lTI&t=1143s)),
and poteto's distinction between missing guidance, missed triggers, and failure
to follow existing instructions
([reflection synthesizer](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/reflect/references/synthesizer.md#L15-L22)).

### 2. separate policy, workflow, facts, and enforcement

**proposed placement rule:**

| information | home | not its home |
|---|---|---|
| stable personal boundaries and interaction preferences | one canonical global instruction source | repeated in every skill |
| repository vocabulary, architecture, supported surfaces, operational hazards | project guidance and nearby rationale | personal memory as a second architecture database |
| reusable, conditional procedure | narrowly triggered skill | always-loaded instructions |
| mechanically checkable invariant | types, lint, tests, scripts, or tool contract | “remember to…” |
| temporary goal, plan, and verified state | task artifact/handoff | permanent global rules |
| cross-project preference or historical constraint absent from code | governed memory with provenance | unreviewed automatic doctrine |

**source support:** theo's global/project distinction
([global, 05:55](https://www.youtube.com/watch?v=e1snsuY4lTI&t=355s);
[project, 24:18](https://www.youtube.com/watch?v=e1snsuY4lTI&t=1458s))
and poteto's
[encode-lessons-in-structure](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/principle-encode-lessons-in-structure/SKILL.md#L9-L26).
these placement choices are recommendations, not proof prose is always inferior.
judgment, product taste, and reasons for constraints still need language.

### 3. make verification a capability, not a reminder

theo's august account includes agents submitting videos that visibly show a
failure. an attached artifact is not a passed test
([august 24, 23:12](https://www.youtube.com/watch?v=0wemf5SZkW4&t=1392s)).
poteto requires generated verification workflows to be run end-to-end, with
isolation, readiness, observations, and owned-process cleanup
([verification generator](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/create-verification-skill/SKILL.md#L13-L40)).

**recommendation:** choose one frequently changed project surface and make its
existing test/runtime path usable by a fresh agent. include expected observations
and an intentionally broken fixture to show the check detects the defect.
preserve the current nix policy distinguishing local checks, evaluation,
artifact builds, and runtime behavior.

do not build a generic verification platform first. inspect the current harness;
fill one concrete gap. for this repository, source → installed → discovered →
invoked skill parity is a candidate first path.

### 4. give work a completion contract, not a mandatory ceremony

theo's september investigation prompt names the affected users, priorities,
uncertainty, and an early exit; “path to a solution” explicitly avoids authorizing
implementation ([september 9, 06:34](https://www.youtube.com/watch?v=q1D90-uGvBg&t=394s)).
he also switches to full access in that demonstration
([10:12](https://www.youtube.com/watch?v=q1D90-uGvBg&t=612s)).
borrow the investigation contract, not that permission setting: prose expressing
read-only intent does not enforce read-only execution.
poteto's delegation brief adds writable scope, acceptance, verification,
timebox, and prohibitions
([brief](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/orchestrate.md#L38-L56)).

**proposed compact contract for nontrivial work:**

```text
outcome: the user-visible result, not a list of tools to run
mode/scope: investigate or change; owned files; protected state
constraints: what must remain true; uncertainties that matter
done: observable acceptance + relevant verification
stop: genuine blocker, permission boundary, budget, or failed approach
return: result, evidence/revision, unresolved claims, next decision
```

infer these fields from a clear request; do not turn them into a questionnaire.
small tasks do not need a document. within authorized scope, continue after status
updates instead of stopping at a plan. if verification exposes a bad requirement,
return to the requirement rather than endlessly patching its implementation.

### 5. parallelize independent work; keep one integration owner

**source evolution matters:** may's workflow was largely serial; june introduced
dynamic loops; september shows parallel investigations and an actionable thread
inbox. this is not a timeless prescription to spawn more agents.
see [the dated comparison](summaries/planning-and-orchestration.md#evolution-not-a-universal-recipe).

**recommendation:** start with independent read-only investigations or reviews.
for implementation, partition writable scope and declare dependencies. one owner
resolves conflicts and checks the integrated result. review verdicts belong to
the actual revision/artifact, not merely a task name.

bound automatic retries and stop on repeated findings, worsening checks, or the
agreed budget. a research/default pilot could allow two repair passes before
escalation; that number is our proposed control, not a source-backed optimum.
no implicit commits, pushes, merges, or external backlog writes.

### 6. optimize the human feedback loop

theo's useful interface claims concern finding work, knowing its host/worktree,
viewing results, and making the next decision—not eliminating shell tools
([august 17, 06:22](https://www.youtube.com/watch?v=dLhcLqoff6k&t=382s)).
his dictation workflow delegates intent and prerequisites, while revealing errors
in machine names ([september 16, 13:40](https://www.youtube.com/watch?v=NvVbCqDgfCs&t=820s)).

**recommendation:** measure the friction in resuming and accepting work before
building another dashboard or moving everything remote. a useful status record
answers: what outcome, where, active/blocked/review-ready/settled, what evidence,
and what decision is needed? check existing pi/t3 capabilities first.

use html when comparison or interaction benefits from it; plain text when it
does not. the existing `html-thingy` skill means this is not a missing capability.
publication remains a separate permission. speech is an optional input mode,
not authorization to guess consequential paths, hosts, or recipients.

## what we should not copy

| tempting reading | evidence against it |
|---|---|
| “turn off all memory” | the memory video criticizes stale/duplicated project auto-memory while admitting useful user context; curated pi memory has different governance. [summary](summaries/context-and-verification.md) |
| “install the entire skill collection” | theo selects individual skills, rejects matt's workflow as too prescriptive for himself, and flags cursor coupling. [august 19, 28:06](https://www.youtube.com/watch?v=0oXOOlqVu5M&t=1686s) |
| “autonomous merge is the goal” | anecdotes include regressions, unsafe merge recommendations, and costly loops; local authorization remains narrower. [workflow limits](summaries/planning-and-orchestration.md) |
| “use today's highest-ranked model everywhere” | anecdotes, changed tasks, interface preference, and vendor claims confound rankings. retain task-specific evaluation. [model limits](summaries/interface-and-models.md) |
| “more review agents prove correctness” | agreement is not observed behavior; the coordinator must inspect evidence and resolve disagreement against source. [poteto](poteto.md) |
| “disposable code is harmless” | scripts can delete data, leak secrets, or create bills; experimental isolation and permissions still matter. [disposable-code limits](summaries/context-and-verification.md) |

## proposed rollout

these are separate, reviewable slices—not permission to implement them all.

| order | slice | acceptance evidence |
|---|---|---|
| 1 | reconcile memory/delegation guidance; resolve skill discovery/arguments contracts | targeted instruction cases; source/install/load/invoke probe; arguments regression test |
| 2 | reduce global/skill duplication and narrow overlapping triggers | positive/negative trigger cases; preserve authorization and evidence behavior |
| 3 | adopt and test the [skill-authoring procedure](skill-authoring.md) on one existing skill | body behavior test plus held-out trigger cases; no automatic installation |
| 4 | make one project verification path reproducible | fresh isolated run; known failure detected; proof corresponds to current artifact |
| 5 | pilot completion contracts and bounded parallel investigation | compare human repair time, useful findings, coordination cost, and completion |
| 6 | improve task resume/review surface where measured friction remains | timed resume/acceptance tasks; fewer wrong-thread actions or forgotten blockers |

**my recommended next slice: order 1.** it has traced inconsistencies, a
reproduced discovery omission, and bounded acceptance criteria. it does not
depend on believing either creator's claimed productivity gains.

### measure improvement without gaming it

primary goal: more **accepted, verified outcomes per hour of human attention**,
with no relaxation of safety or quality. do not substitute lines generated,
unattended runtime, agent count, or pull-request count.

freeze task/fixture, base revision, skill revisions, model/settings, and tools.
compare baseline with one change at a time. use repeated matched runs on:
read-only diagnosis, a small fix, cross-surface work, skill writing, and review.
include negative cases where no skill/delegation/mutation is appropriate.

record correctness and permissions first; then human correction/inspection time,
missed requirements, false findings, premature stops, elapsed time, and cost.
reject a candidate that breaches a boundary or hides a failure. for quality-safe
candidates, retain it only when matched tasks show less human effort or better
accepted outcomes without disproportionate operational cost. a small pilot
discovers failure modes; it does not establish a universal effect size.

## corpus and selection

dates below use yt-dlp's `upload_date`; localized watch pages/search results can
display the preceding calendar day. selection began with titles and descriptions,
then the full downloaded captions were assigned for reading. this is a curated
sample, not an exhaustive review of every upload. separate livestream/shorts
tabs were not inventoried.

| date | video / local transcript | reason |
|---|---|---|
| 09-25 | [Getting the most out of Opus 5.5](sources/ejjBbaq9RmY.md) | completion, steering, stop conditions |
| 09-18 | [Please stop using stupid models](sources/iBrAWpjXNxs.md) | task reliability and evaluation caveats |
| 09-16 | [How I Code Without Typing](sources/NvVbCqDgfCs.md) | intent, prerequisites, ergonomics |
| 09-09 | [You're using AI agents wrong](sources/q1D90-uGvBg.md) | current investigation/review workflow |
| 09-07 | [Stop Pretending You Understand Your Codebase](sources/5KvY8CnBB3w.md) | recoverable architecture knowledge |
| 08-25 | [Turn off Claude Code's Memory](sources/Jf54k7tFeEc.md) | stale context and structural enforcement |
| 08-24 | [Boris Is Right Again (I Hate It)](sources/0wemf5SZkW4.md) | planning versus implementation versus verification |
| 08-19 | [So I tried Matt's skills...](sources/0oXOOlqVu5M.md) | selective skills, poteto, interviews |
| 08-17 | [I'm done with terminals](sources/dLhcLqoff6k.md) | coordination and feedback interface |
| 08-11 | [My AGENTS.md & SKILLS.md Breakdown](sources/e1snsuY4lTI.md) | instruction and skill authoring |
| 07-22 | [Write Code You Will Never Read Again](sources/434cG4g5KLE.md) | disposable experiments versus shipped code |
| 07-21 | [Claude Code's creator has some really good advice](sources/xmGY276gEFY.md) | leverage through tooling and tests |
| 06-18* | [I guess we're writing loops now?](sources/iJVJwmCKW9o.md) | evolution and limits of loops |
| 05-27* | [How I code with AI changed a lot](sources/xJaMTo2YgO8.md) | earlier serial/conversational baseline |
| 05-13* | [Stop letting your agents write Markdown.](sources/S9EGx6ik-18.md) | output-format counterarguments |

`*` explicit recency exceptions, not current product documentation. model-launch
news, vendor disputes, hardware news, and unrelated programming reactions were
generally excluded. retained model videos contain operating advice; their
rankings are not proposed policy.

### provenance and reproducibility

[manifest](sources/manifest.json) records URLs, dates, selection reasons, channel
identity, duration, descriptions, caption type, download outcome, retrieval time,
and raw caption SHA-256. [inventory](sources/channel-inventory.json) preserves the
screened title list. raw `*.en-orig.json3` files preserve downloaded caption
events; matching markdown files normalize whitespace and attach event timestamps.

acquisition used yt-dlp `2026.06.09`, without browser cookies or video/audio
downloads. all selected caption downloads succeeded. timestamps reaching the
end do not prove word accuracy or recover text shown only on screen. sponsor
segments and quoted speakers are distinguished in summaries, not deleted from
the source. no transcription was checked against the audio.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s modules/agents/research/2026-09-28 -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 modules/agents/research/2026-09-28/verify.py
```

`acquire.py` is a networked research generator, not installed runtime code.
rerunning it refreshes the snapshot, so preserve this corpus first if doing a
later comparison. verification is offline and does not install or activate
anything. it checks artifact consistency and local links, not semantic truth,
external URL availability, or productivity.
