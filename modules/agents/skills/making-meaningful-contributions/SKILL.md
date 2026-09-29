---
name: making-meaningful-contributions
description: "Check implementation work for pre-submission readiness: scope, behavioral evidence, regression coverage, and a reviewer-ready handoff. Use when preparing to submit completed work, not for general code review or ongoing investigation."
---

# making meaningful contributions

a readiness gate for work you intend to hand off. evaluating readiness is
read-only; preparation, fixes, commits, pushes, and publication require their
respective authorization. this skill does not grant it.

> "your job is to deliver code you have proven to work." —
> [simon willison](https://simonwillison.net/2025/Dec/18/code-proven-to-work/)

apply that standard with bounded evidence: untested behavior is **unverified**,
not necessarily broken. help reviewers understand what was demonstrated and what
they would still be accepting on trust.

## readiness gate

1. **scope:** compare the final diff with the requested outcome. identify unrelated
   changes, generated artifacts, and affected consumers. preserve others' work;
   flag scope drift rather than discarding it.
2. **behavior:** state the input, observable outcome, and failure boundary. select
   checks by how the change is consumed, following project verification guidance.
   distinguish parsing, typechecking, builds, runtime checks, and visual evidence.
3. **regression evidence:** for a fix, prefer a focused test that fails without the
   fix and passes with it. inspect whether its assertion actually detects the
   reported defect. never revert someone else's working tree to demonstrate this;
   use an authorized isolated fixture or report that sensitivity is unverified.
4. **edges:** cover consequential invalid inputs, failures, lifecycle transitions,
   or platforms implicated by the change. explain omitted coverage rather than
   demand every conceivable test or a manual check for every patch.
5. **review:** use the [review procedure](../review/SKILL.md) for evaluating defects
   in the final revision. resolve findings only within authorized scope. when
   evidence already applies to the unchanged revision, reuse it rather than
   commission another review merely to satisfy ceremony.
6. **handoff:** provide the changed behavior and rationale, relevant paths,
   commands/results, remaining risks, and any decision needed. keep evidence tied
   to the final artifact; rerun affected checks after further changes.

## readiness decision

- **ready within stated scope:** relevant checks passed and no known blocking
  findings remain. this is not a guarantee beyond the checked behavior.
- **blocked:** a known defect, failed required check, or missing requirement needs
  resolution before submission.
- **needs acceptance of a gap:** tooling, platform, or evidence is unavailable.
  state the missing command/observation and consequence; do not silently mark it
  passed or assume the reviewer accepts the risk.

stop at the assessment unless further action was requested. avoid repeated
polishing loops once the acceptance evidence is sufficient.

## contrastive examples

**weak handoff:** “implemented the cache fix; tests pass.”

**bounded handoff:** “invalidation now waits for persistence. the delayed-write
regression test failed on the old implementation and passes on this revision.
typecheck passed. multi-process invalidation was not exercised.”

use that wording only when those checks actually ran.

**contract mismatch:** naming a value `VersionedStructuredRequestWithOptions`
while accepting unversioned requests hides a boundary from callers. either the
name or the accepted contract needs clarification; a longer name alone does not
make the contribution ready.

the gate exists to reduce evidence reconstruction for reviewers, not to turn
submission into a claim of universal correctness.
