# proposed model cards

2026-09-29. human-readable routing guidance, **not installed model metadata**.
capability descriptions are **HUNCH** based on the
[source evidence](sources/theo-evidence.md); identifiers/prices are documented
facts where linked. no matched local model benchmark ran.

## gpt-6.1 sol — default worker and investigator

**description:** preferred candidate for everyday coding, scoped implementation,
root-cause investigation, repository research, and detailed code review. verify
findings against source and executable checks. use explicit completion criteria;
escalate stalled broad work rather than spending indefinitely.

- start: medium for normal work, high for substantive review/architecture.
  these are proposed settings, not theo-established optima.
- strengths suggested by theo: review depth, detail checking, useful scoped work.
- watch for: stalled unattended rewrites, first-draft bugs, UI taste/mechanics.
- route: existing codex subscription, **once exact client/backend support is
  confirmed**. installed `gpt-6-sol` is not verified as this model.
- official api ID: `gpt-6.1-sol`.
- standard api price: $2 input / $0.10 cached input / $10 output per million
  tokens; cache write $2.50. not a subscription-cost estimate.
- evidence: [official model](https://developers.openai.com/api/docs/models/gpt-6.1-sol);
  [theo audit](https://www.youtube.com/watch?v=vu8X3YroB-w&t=788s);
  [counterexample](https://www.youtube.com/watch?v=vu8X3YroB-w&t=959s).

## gpt-6 astra — hard-problem escalation

**description:** reserve for difficult reasoning, unresolved architecture or
debugging questions, and work where sol repeatedly fails. request an alternative
explanation backed by evidence; do not equate higher effort with correctness.

- start: retain existing oracle/review xhigh as the escalation baseline.
- evidence: vendor positions it for hardest end-to-end work; theo reports
  inconsistency and some remaining strengths over sol.
- route: installed `openai-codex/gpt-6-astra`; account access untested here.
- standard api price: $10 input / $1 cached input / $50 output per million
  tokens; cache write $12.50. fivefold sol base rates do not prove fivefold
  task cost or subscription consumption.
- evidence: [official model](https://developers.openai.com/api/docs/models/gpt-6-astra);
  [theo's qualified comparison](https://www.youtube.com/watch?v=vu8X3YroB-w&t=656s).

## luna — bounded retrieval and housekeeping

**description:** use the existing 5.6 luna route for targeted code location,
document/image extraction, session fact extraction, titles, and recaps. escalate
ambiguous interpretation, conflicting evidence, or broad synthesis to sol.

- start: existing low setting; retain baseline before testing a generation change.
- installed routes: `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-6-luna`.
- both declare image input in the local catalog; declaration is not a visual
  quality test. preserve sufficient context for long documents.
- 6 luna is a candidate upgrade, not the name of our existing deployed default.
- vendor positioning: mechanical, clear, repeatable tasks.
- evidence: [6 luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna);
  local role defaults cited in [routing report](README.md#local-configuration-evidence).

## claude opus 5.5 — optional implementation specialist, different budget/harness

**description:** candidate for broad long-running implementation, collaborative
iteration, and rewrites that repeatedly stall with sol. supply concrete done
criteria and visual direction. pair with sol investigation/review when useful;
opus is not a substitute for observed verification.

- start: high; xhigh when missed details justify it. avoid max as a blanket
  default. official api default is medium; theo's high recommendation is a
  workflow preference, not a protocol requirement.
- strengths suggested by theo: implementation persistence and collaboration.
- watch for: premature stops, cleanup omissions, max-effort stalls, design
  needing direction. neither flawless autonomy nor best zero-direction design.
- **not included in your codex subscription.**
- pi use: separately billed anthropic api/provider route.
- subscription use: native/unmodified claude code harness, with its own
  tools, settings, shared limits, and workflow costs. do not install claude
  subscription oauth as a pi subsidy.
- official api ID: `claude-opus-5-5`.
- standard api price: $4 input / $0.20 cache read / $20 output per million
  tokens; five-minute cache write $5. actual task cost depends on behavior.
- evidence: [official model](https://platform.claude.com/docs/en/models/opus-5-5/overview);
  [effort contract](https://platform.claude.com/docs/en/build-with-claude/effort);
  [theo high/xhigh](https://www.youtube.com/watch?v=ejjBbaq9RmY&t=721s);
  [subscription boundary](https://code.claude.com/docs/en/legal-and-compliance).

## spark — optional narrow text-only experiment

**description:** possible low-latency candidate for titles or short mechanical
text extraction. not recommended for consequential synthesis or visual analysis
without task-specific evidence.

- installed route: `openai-codex/gpt-5.3-codex-spark`.
- local catalog: text-only, 128k context versus 272k for the other installed
  codex models. do not route images or oversized session transcripts here.
- no task-specific quality/latency comparison was performed; do not replace
  luna based on the name or presumed cheapness.

all prices are standard api list rates at research time. long-context premiums,
processing modes, tools, token counts, and cache behavior can change actual
cost. subscription quotas are a separate contract.
