# poteto workflow research

research date: 2026-09-28. scope: official poteto sources, especially cursor’s pstack. this preserves a read-only source investigation for later synthesis with theo’s workflow videos; no theo video claims were verified in this slice.

## conclusion and evidence boundary

borrow the decision rules, evidence contracts, and skill-maintenance loop, not the entire cursor orchestration apparatus.

**VERIFIED** below means the pinned source prescribes the behavior, not that the behavior improves outcomes. adaptations are **HUNCH**: hypotheses to evaluate in a single-user pi setup, not measured gains.

sources were fetched with read-only github api/raw requests. no source instructions were executed and nothing was installed. the [pstack readme, lines 3–11][claims] claims everyday use, higher-quality code, and confident parallelism. these are author claims, not benchmark results. no controlled outcome evidence was inspected.

## revision evidence

github returned these exact revisions and committer timestamps, all utc:

| repository | inspected revision | timestamp |
|---|---|---|
| cursor/plugins | `adf3218ca2f5b9971eedc07a76bef22df7701539` | 2026-09-28 15:05:24 |
| poteto/how | `b1ef42969ea7a2bb50aa26c2480274828a0385e7` | 2026-04-14 22:14:27 |
| poteto/brainmaxxing | `ec4d8e43dee639d6f5d94aed3ca16af7b298ecfc` | 2026-02-27 19:47:24 |
| poteto/noodle | `82d2921c52370f23f29086de81ccfb600939c037` | 2026-03-19 07:41:03 |
| poteto/verification-skill-example | `d5abe70d0d8c671672b6cef4069363f26c488feb` | 2026-07-30 20:07:46 |

the latest commit affecting pstack was [poteto-authored `12d587d`][pstack-change], september 23, 2026, 20:03:21 utc. its message reports rule-conflict fixes and version 0.15.5. inspected files below are pinned to the containing repository revision, not mutable `main`.

**date check:** none exceeds the supplied september 28, 2026 date. `pushed_at` sometimes differs from head commit time; those fields describe different events. the readme describes work at cursor, while the current github profile listed xai and react compiler. employment wording may be stale; that does not establish stale workflow content. the profile observation is mutable, unlike the file citations.

## eleven principles

### 1. make a mode a router

**VERIFIED:** [`poteto-mode`, lines 115–143][router] routes investigation, bug fixes, features, prototypes, evaluation, shipping, and session pickup to separate playbooks. skipped steps remain visible with reasons.

**HUNCH, pi adaptation:** use a small routing skill that selects existing skills and defines completion evidence. keep investigation explicitly read-only; avoid duplicating every workflow in always-loaded guidance.

**tradeoff:** the [non-negotiables][triggers] trigger architectural exploration whenever code crosses a function boundary. that is broad enough to burden small edits. preserve routing without inheriting automatic design panels.

### 2. earn parallelism through decomposition

**VERIFIED:** [`how`, lines 13–50][how] chooses one explainer for narrow questions and two to four distinct exploration angles for complex systems. when uncertain, it chooses the simple path. its [explainer reference][explainer] requires checking code to reconcile contradictions.

**HUNCH, pi adaptation:** delegate non-overlapping questions with evidence requirements, then reconcile results. this is more bounded than “always spawn agents.”

**version check:** the [standalone how skill][standalone-how] also includes critique mode. current pstack’s `how` is not an identical copy. do not silently combine their contracts or assume model defaults are durable design principles.

### 3. name principles only when they change decisions

**VERIFIED:** [`poteto-mode`, lines 15–39][triggers] requires reading each applied principle’s leaf file and naming the choice it changed.

**HUNCH, pi adaptation:** short steering phrases such as “prove it works” and “subtract before adding” can point to precise rules. require an observable consequence, not a ceremonial list in every reply.

the [laziness principle][laziness] favors deletion, consolidated decisions, and the smallest sufficient diff. its recommendation to flatten tracing across more than three files or layers is an author heuristic, not an established architecture threshold. use maintenance cost and local structure to judge exceptions.

### 4. verify the actual claim

**VERIFIED:** [`prove-it-works`][proof] rejects compilation, cached screenshots, and agent self-reports as substitutes for direct observation. it prefers deterministic, rerunnable checks.

the [bug-fix playbook][bug-fix] requires reproduction, hypothesis elimination, and verification on the original surface. inconclusive or wrong-surface evidence is not a pass.

**HUNCH, pi adaptation:** completion reports should distinguish typechecked, built, runtime-tested, and unverified. retain failing/passing evidence where practical. this complements local nix consumption-boundary checks rather than replacing them with generic “tests passed.” evidence must match the behavioral claim and affected artifact.

### 5. verification skills should be executable

**VERIFIED:** [`create-verification-skill`][verification-generator] discovers how to launch, drive, observe, and isolate an application. generated skills include readiness checks, a read-only “doctor,” evidence retention, owned-process cleanup, and a behavior-level feature map.

the generator must execute its instructions end-to-end. an unexecuted skill is a draft.

**HUNCH, pi adaptation:** start project-local verification knowledge with one real user path, then expand alongside feature changes. prefer existing harnesses over new tooling.

**falsification boundary:** the [atlas example][fictional] explicitly says it is fictional and omits the driver. it demonstrates document structure, not working automation or measured coverage.

### 6. test behavior without canonizing a faulty heuristic

**VERIFIED:** [`test-behavior-not-implementation`][tests] prefers consumer-visible results over constant pinning, self-referential expectations, and mock-call counting. it preserves relational table checks and compile-time tests.

**HUNCH, pi adaptation:** ask what defect an assertion detects. exercise the mechanism consuming configuration rather than merely repeating configured values.

**counterexample:** the source says its listed weak-assertion shapes survive every imported function returning `undefined`. that is overbroad: `expect(f()).toBeDefined()` fails if `f()` returns `undefined`. this logical counterexample disproves the blanket classification, not the usefulness of stronger assertions. retain the behavioral goal; do not turn its list into an automatic deletion rule.

### 7. skill prose should change behavior

**VERIFIED:** the [authoring playbook][authoring] requires frontmatter and link validation, structural test cases, and delegation to existing skills rather than restatement. it says to keep prose that changes decisions.

**HUNCH, pi adaptation:** give each skill recognizable triggers, bounded scope, concrete steps, evidence expectations, and authoritative references. delete duplicated policy; retain rationale when a rule would otherwise be confusing.

**unavailable implementation:** [`create-skill` is a cursor built-in and not bundled][external-skills]. its description-optimization and draft/test/iterate loops are referenced elsewhere, but their implementation was not inspected. port explicit requirements, not an unresolved invocation or imagined implementation.

### 8. evaluate skill changes on realistic tasks

**VERIFIED:** the [eval playbook][eval] hides evaluation framing from candidates, uses organic prompts, anonymizes outputs, and checks actual file reads rather than self-reported compliance. the parent reads every output instead of accepting the judge unquestioningly.

**HUNCH, pi adaptation:** compare baseline and edited skills on representative tasks. examine routing, unauthorized actions, evidence quality, and unnecessary work.

**tradeoff:** authoring permits skipping tests for subjective changes, while evaluation offers a way to inspect behavioral effects. cheap comparisons suit consequential prose changes; punctuation does not need a multi-model tournament. blinding and model agreement do not independently establish correctness.

### 9. reflection should produce reviewed proposals

**VERIFIED:** [`reflect`][reflect] rejects one-offs, scopes transcript access to the workspace, uses three review lenses, and requires explicit approval before skill edits.

its [synthesizer][synthesizer] distinguishes missing guidance, buried guidance, missed triggers, and failures to follow already-clear instructions.

**HUNCH, pi adaptation:** preserve that diagnosis. missed activation may need description tuning, not another paragraph. present accepted/rejected/backlog proposals and read the target before recommending changes.

**local constraint:** upstream automatically files backlog items externally. local policy requires authorization. workspace scoping is useful but insufficient for pi memory: preserve existing verified-projection and producer-owned evidence boundaries rather than importing transcript-mining commands.

### 10. encode recurring corrections structurally

**VERIFIED:** [`encode-lessons-in-structure`][structure] routes recurring errors toward types, lint rules, helpers, checks, or scripts. prose remains for judgment that cannot be enforced.

**HUNCH, pi adaptation:** prefer a tested validator over “remember to validate.” keep project facts and rationale near project code; personal guidance should hold genuinely cross-project preferences.

**historical conflict:** [brainmaxxing meditate][meditate] directly edits skills and deletes stale notes, while current pstack reflection waits for approval. these are distinct policies, not one consistent autonomous learning system. brainmaxxing also includes an explicit planning skill; pstack’s [readme][planning] says planning is not the author’s default. preserve provenance when comparing these snapshots.

### 11. handoffs need state and evidence

**VERIFIED:** the [orchestration brief][brief] specifies goal, writable scope, context, acceptance, verification, timebox, prohibitions, and report shape. its [verification ledger][ledger] keys verdicts to commit sha, invalidates stale verification, and bounds retries.

**HUNCH, pi adaptation:** use the brief contract and a compact resume record: intent, current artifact, verified revision, unresolved claims, next action.

**tensions:** [pickup][pickup] calls the prior trail authoritative but also requires checking inherited claims. reuse valid receipts without treating narrative as proof. [pause-safely][pause] automatically commits; that conflicts with this workspace’s explicit-commit boundary.

the orchestration playbook itself says single-session work should avoid its program machinery. a personal workflow generally needs fewer roles, not a standing coordinator fleet.

## local constraints and next hypotheses

do not import upstream’s [blanket permission for team-chat and ticket actions][autonomy], automatic commits, pushes, or destructive cleanup. authorization remains local. cursor task schemas, model names, cloud environments, graph-management tooling, and mcp access assumptions are implementation-specific.

the inspected [noodle readme][noodle] establishes a separate go-based orchestration project. it does not establish that pstack depends on noodle or that either improves outcomes.

recommended experiments, not claimed gains:

1. test a small router against direct use of existing skills.
2. run one project verification skill end-to-end, retaining evidence after cleanup.
3. evaluate one recurring skill failure before and after a bounded edit.
4. compare a concise evidence-bearing handoff against narrative-only pickup.

for later theo synthesis, compare when planning earns its cost, when parallelism helps, what counts as proof, who owns integration, and how lessons become tested changes. the working hypothesis is fewer duplicated instructions plus stronger verification, not more autonomous machinery.

## primary permalinks

[claims]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/README.md#L3-L11
[pstack-change]: https://github.com/cursor/plugins/commit/12d587dfb20741cafc376c42c696c5f6e2a64487
[router]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/SKILL.md#L115-L143
[triggers]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/SKILL.md#L15-L39
[how]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/how/SKILL.md#L13-L50
[explainer]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/how/references/explainer-prompt.md#L19-L23
[standalone-how]: https://github.com/poteto/how/blob/b1ef42969ea7a2bb50aa26c2480274828a0385e7/skills/how/SKILL.md#L10-L33
[laziness]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/principle-laziness-protocol/SKILL.md#L9-L18
[proof]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/principle-prove-it-works/SKILL.md#L9-L22
[bug-fix]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/bug-fix.md#L5-L15
[verification-generator]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/create-verification-skill/SKILL.md#L13-L40
[fictional]: https://github.com/poteto/verification-skill-example/blob/d5abe70d0d8c671672b6cef4069363f26c488feb/README.md#L3-L39
[tests]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/principle-test-behavior-not-implementation/SKILL.md#L9-L25
[authoring]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/authoring-a-skill.md#L5-L12
[external-skills]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/README.md#L229-L237
[eval]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/eval.md#L5-L24
[reflect]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/reflect/SKILL.md#L13-L64
[synthesizer]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/reflect/references/synthesizer.md#L15-L22
[structure]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/principle-encode-lessons-in-structure/SKILL.md#L9-L26
[meditate]: https://github.com/poteto/brainmaxxing/blob/ec4d8e43dee639d6f5d94aed3ca16af7b298ecfc/.agents/skills/meditate/SKILL.md#L44-L61
[planning]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/README.md#L239-L241
[brief]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/orchestrate.md#L38-L56
[ledger]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/orchestrate.md#L85-L100
[pickup]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/session-pickup.md#L5-L9
[pause]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/pause-safely.md#L5-L8
[autonomy]: https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/SKILL.md#L79-L95
[noodle]: https://github.com/poteto/noodle/blob/82d2921c52370f23f29086de81ccfb600939c037/README.md#L1-L18
