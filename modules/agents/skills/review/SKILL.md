---
name: review
description: "Evaluate implementation changes or pull requests for actionable defects, using traced behavior, counterevidence, and severity. Read-only by default. Not a prerequisite for debugging, general investigation, or routine factual answers."
---

# review

evaluate a specific change against its intended behavior. do not fix it, rewrite
tests, post comments remotely, or change git state unless separately authorized.
use only checks compatible with that boundary; report when a useful reproduction
would require mutation or external effects.

## procedure

1. establish the reviewed revision/diff, intended outcome, and constraints. read
   applicable project guidance and relevant tests. distinguish pre-existing
   behavior from regressions introduced by the change.
2. trace the changed behavior across its boundary: caller → changed code →
   consumer or observable effect. inspect guards, defaults, ownership, failure
   paths, and platform assumptions that could invalidate a suspected defect.
3. prioritize concrete correctness, security, data-loss, compatibility, and
   operational risks. inspect names/types/abstractions when they conceal a real
   contract mismatch; do not turn personal style preferences into defects.
4. for each candidate, state the triggering conditions and consequence. ask what
   would make it safe, then check that counterexample: an upstream guard, a
   synchronous operation, an unreachable state, or an explicit requirement.
5. run the narrowest safe relevant check when available. distinguish static
   tracing from observed execution. missing tests mean a coverage gap, not proof
   of a bug; passing tests do not establish behavior they never exercise.
6. discard refuted candidates. report actionable findings first, followed by
   consequential uncertainties and verification limits. do not inflate the
   report to fill a template.

## severity and evidence

assign severity by demonstrated impact and reach, not by alarming vocabulary:

- **critical:** immediate containment needed for a reachable catastrophic failure.
- **high:** blocks core behavior or exposes substantial security/data-loss risk.
- **medium:** meaningful failure under specific, plausible conditions.
- **low:** limited impact with a concrete reason to fix.

honor a requested project's severity scale instead when one exists. keep severity
separate from confidence: a high-impact hypothesis remains unverified.

each finding should fit in a compact paragraph or short block containing:

- severity and an action-oriented title;
- `file:line` (or source URL), triggering conditions, and observable consequence;
- evidence and confidence: VERIFIED (traced), HUNCH (not traced), or QUESTION;
- the counterevidence checked and any remaining reproduction limitation.

keep hunches/questions separate from confirmed defects. finish with checks run
and gaps. if none survive, say “no actionable findings in the reviewed scope,”
not “the change is correct.”

## contrastive example

**unsupported:** “high / VERIFIED: race in `invalidator.ts`; it calls several
async functions.”

**evidence-bearing, illustrative:** “medium / VERIFIED by reproduction:
`src/cache/invalidator.ts:47-52` returns before `write()` settles. when a caller
reads after awaiting invalidation, it can receive the old value. a delayed-write
fixture reproduced that ordering. checked for a caller-side await/lock and a
synchronous write implementation; neither guards this path.”

if only source tracing was done, say so instead of claiming the fixture ran.
the number of agreeing reviewers is not execution evidence.
