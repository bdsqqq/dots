# model routing for a codex-only subscription

research date: 2026-09-29. **recommendation, not installed configuration.**

## adoption follow-up

later on september 29, the user authorized adoption and confirmed sol 6.1
availability in this live session. committed-source defaults now select
`openai-codex/gpt-6.1-sol`: medium for main, delegate, librarian and memory;
high for oracle and code-review. luna roles and the evaluator baseline remain
unchanged. the original research/registry snapshot below is historical, not a
current rollout blocker. no claim that `gpt-6-sol` is an alias is needed.

delegate now explicitly passes its configured model and reasoning on fresh
and continued calls. previously it passed neither: a separate process loaded
startup settings or restored child-session settings, rather than inheriting
the parent's live selection. ancestry linkage does not copy runtime settings.

typechecking and extension tests passed. six memory admission/remote-race
integration failures reproduced with the original astra/low defaults.
the mbp-m2 system derivation evaluated and its home-manager activation artifact
built; no activation or live sub-agent inference was performed.

---

**use sol 6.1 for day-to-day work and substantive investigation/review; keep
luna for bounded extraction and housekeeping; retain astra as an escalation,
not the routine default. do not buy a claude subscription solely from these videos.**

confidence: **HUNCH** for these assignments. source claims and configuration
facts below are **VERIFIED as documented**, not verified model performance.
your positive sol experience is relevant local evidence, but not a comparison
across every agent role.

## what changed

acquired full timestamped automatic captions for theo's new sol video and a
pacing discussion, then analyzed them alongside the retained opus 5.5 and
model-selection videos. see [evidence and provenance](sources/theo-evidence.md).
generated the [model cards](model-cards.md). no live defaults, installed tool
descriptions, dependencies, authentication, or nix wiring changed.

automatic captions are not audio-verified. screenshots/game behavior were not
visually inspected. vendor benchmarks and theo's experiments are evidence of
their claims, not our own matched tests.

## routing recommendation

`sol 6.1` below means the new model, **not** the installed `gpt-6-sol`.
effort choices are starting hypotheses, not benchmark-established optima.

| agent / work | current committed default | recommended model / effort | reason and escalation |
|---|---|---|---|
| main pi: normal implementation, debugging, coordination | astra / low | sol 6.1 / medium | your experience plus theo's scoped-work observations; escalate stalled or high-risk work |
| delegate: independent implementation | startup settings or restored child model | sol 6.1 / medium | same default; split broad work into verifiable slices rather than assume unattended reliability |
| finder: conceptual local code search | 5.6 luna / low | retain 5.6 luna / low initially | bounded search; retry with sol when relationships or contradictions require reasoning |
| librarian: multi-repository research | astra / low | sol 6.1 / medium | source correlation and investigation; luna only for tightly bounded retrieval |
| oracle: difficult reasoning, architecture, root cause | astra / xhigh | sol 6.1 / high; astra / xhigh escalation | sol investigation evidence is strong enough for a trial, not proof it replaces astra on hardest tasks |
| code-review | astra / xhigh | sol 6.1 / high | strongest direct video fit; require reproduction and relevance, not number of findings |
| look-at: image/document extraction | 5.6 luna / low | retain 5.6 luna / low | image input is supported locally; escalate ambiguous diagrams/UI interpretation to sol |
| read-session: goal-focused transcript extraction | 5.6 luna / low | retain 5.6 luna / low | extraction is narrower than synthesis; sol for conflicting accounts/ancestry-sensitive conclusions |
| session-name and session-recap | 5.6 luna / low | retain 5.6 luna / low | short housekeeping; frontier reasoning is not justified by evidence here |
| memory reflection/maintainer | astra / low | sol 6.1 / medium, after admission fixtures pass | consequential synthesis; cheap title generation is not equivalent to durable-memory decisions |
| compaction and branch summaries | active session model | active sol model | no separate model selector established; changing main default changes these too |
| skill-routing evaluator | astra / low | pin astra baseline; add a separate sol trial | do not silently change the measuring instrument alongside the candidate |

retain existing luna first to avoid changing two variables at once. **gpt-6-luna**
is a candidate successor, not a proven upgrade for vision, extraction, or memory.
spark is a possible text-only housekeeping experiment; it is not a look-at
replacement and its smaller context is a liability for long transcripts.

### local configuration evidence

paths below are relative to `modules/pi/`, except the final two:

- main: `settings.json:2,13-14`.
- oracle: `packages/extensions/oracle/index.ts:49`.
- review: `packages/extensions/code-review/index.ts:47`.
- librarian: `packages/extensions/librarian/index.ts:46`.
- finder: `packages/extensions/finder/index.ts:50`.
- look-at: `packages/extensions/look-at/index.ts:46`.
- read-session: `packages/extensions/read-session/index.ts:48`.
- naming: `packages/extensions/session-name/index.ts:28-30`.
- recap: `packages/extensions/session-recap/index.ts:27-56`.
- delegate does not pass a model: `packages/extensions/delegate/index.ts:198-209`;
  child model argument is conditional: `packages/core/pi-spawn/index.ts:623`.
- memory deployed defaults: `modules/pi-memory/default.nix:15-16`.
- evaluator: `modules/agents/evaluate-skill-routing.ts:95,120-125`.

delegate does **not** reliably inherit an interactive parent model selection.
fresh children use startup defaults; restored children can retain their model.
extension overrides use `@bds_pi/<extension>` in `bds-pi.json` and
`bds-pi.local.json`; machine-local overrides were not inspected.

finder's source header still describes gemini flash
(`packages/extensions/finder/index.ts:2-11`), although its executable default
is codex luna. this report does not install that stale description.
zed is a separate harness: `modules/zed/settings.json:116-123` selects
anthropic sonnet. pi provider identifiers cannot be assumed to work there.

## a real rollout blocker: model identity

offline enumeration of the installed pi-ai catalog found:

```text
openai-codex/gpt-5.3-codex-spark
openai-codex/gpt-5.5
openai-codex/gpt-5.6-luna
openai-codex/gpt-5.6-sol
openai-codex/gpt-5.6-terra
openai-codex/gpt-6-astra
openai-codex/gpt-6-luna
openai-codex/gpt-6-sol
```

source: `modules/pi/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json:1`.
**no `gpt-6.1-sol` entry.** the official api ID is
[`gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
api IDs do not prove the codex backend accepts the same string. do not relabel
`gpt-6-sol`, guess an alias, or write an unsupported live default.

next implementation slice: verify the supported codex selector for sol 6.1,
update the client registry through its supported mechanism if needed, then
exercise a fresh main session and fresh delegate. catalog support is not
account entitlement or successful server acceptance. no provider request ran.

## what theo actually supports

- [sol, 13:08](https://www.youtube.com/watch?v=vu8X3YroB-w&t=788s):
  strong audit/review results in his own tests.
- [sol, 15:59](https://www.youtube.com/watch?v=vu8X3YroB-w&t=959s):
  stalled unattended rewrite; opus preferred for that work.
- [sol, 27:51](https://www.youtube.com/watch?v=vu8X3YroB-w&t=1671s):
  complementary roles—sol checks details, opus collaborates/implements.
- [opus, 12:01](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=721s):
  high/xhigh preferred over max, with anecdotal and local benchmark support.
- [opus, 22:29](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=1349s):
  cross-family reviews can help; openai also produces irrelevant findings.

counterevidence matters: sol's provisional terminal benchmark had incomplete
runs and omitted hardware-dependent tasks; early-access restrictions skewed
theo's real usage toward internal audits. opus also stopped prematurely in his
demonstration. neither “sol low everywhere” nor “opus always finishes” follows.

## subscription decision

**today: keep codex-only.** no anthropic spend is required by this routing.
api token prices are not included-subscription task prices.

pi's installed `openai-codex` provider implements a subscription route through
`chatgpt.com/backend-api`; the `openai` provider uses separately billed api
credentials. this establishes implementation, not an independently verified
blanket authorization for direct third-party oauth inference. openai documents
custom clients through [codex app server](https://developers.openai.com/codex/app-server)
and separates [api-key billing](https://developers.openai.com/codex/auth).

for opus there are two materially different choices:

1. **stay in pi:** anthropic api/provider credentials, separate metered billing.
   no claude-code subscription subsidy is assumed.
2. **add a claude subscription:** use the unmodified claude code/native
   anthropic harness. it is an additional workflow, not an opus toggle in pi.
   an interface hosting the unmodified binary can be different from pi directly
   routing inference; do not conflate them.

[anthropic's authentication rules](https://code.claude.com/docs/en/legal-and-compliance)
restrict subscription oauth to native application use and disallow third-party
applications routing requests with their users' subscription credentials.
[claude/code usage is shared](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan);
five-hour and weekly limits mean a subscription is not unlimited background compute.

**reconsider a subscription if** recurring broad rewrites, long implementation
runs, or UI collaboration still consume substantial human rescue time with sol.
theo provides a hypothesis that opus helps those tasks—not proof it offsets
subscription cost and the loss of your pi tools/workflow.

compare actual failed/expensive tasks, not generic demos. keep fixtures,
permissions, completion criteria, and tooling as comparable as possible; record
harness differences. prioritize verified correctness, rescue/review time,
unfinished scope, elapsed time, quota use, and actual spending. do not estimate
subscription savings from token-price ratios. buy only if accepted outcomes
improve enough to justify both the bill and harness friction.

## verification and falsification

- new caption manifests bind raw bytes/metadata to normalized timestamped text;
  end coverage and counts checked. isolated corrupt-caption fixture rejected.
- original 15-video corpus verifier passed.
- official sol/opus model pages and anthropic authentication rules retrieved
  september 29; prices are documented, not bills measured on this account.
- local registry examined offline; no credentials, completions, account quota,
  machine-local overrides, or deployed runtime tested.
- routing would be disproved by matched tasks showing more rescue effort,
  missed defects, irrelevant review findings, or failures than current defaults.
  that comparison has **not** run.
- no nix evaluation/build needed: research artifacts are not installed runtime
  or evaluation inputs. no claim of runtime model verification.
