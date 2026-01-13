---
name: review
description: epistemic standards for evaluation and analysis. load before reviewing, debugging, or any task where findings must be defensible.
---

# review

epistemic standards for producing defensible findings.

## when to load

- evaluating code, docs, or designs
- debugging / root cause analysis
- codebase archaeology
- any task where you will report findings to others

## principles

1. **trace or delete** — every claim traces to code, logs, or data. if you can't show the evidence, delete the claim or label it a hunch.
   - *prevents: pattern → fact leap* — "this looks like X" silently becomes "this IS X"

2. **facts, not assumptions** — "the code shows X" not "this is probably X". be specific: line numbers, exact conditions, concrete paths.
   - *prevents: vague language hiding weak evidence* — hedging lets you avoid committing to what you actually know

3. **label confidence** — VERIFIED (traced), HUNCH (pattern recognition, not traced), QUESTION (needs input). never present hunches as findings.
   - *prevents: false certainty* — unlabeled claims inherit unearned authority

4. **falsify, don't confirm** — design tests that would DISPROVE your hypothesis. ask: "what would make this NOT a bug?"
   - *prevents: confirmation bias* — you naturally notice supporting evidence and ignore contradictions; tunnel vision locks you into your first theory

## quality criteria

when evaluating contributions, check:

1. **proven correctness** — have you seen it work? not "does the code look right" — have you actually run it?
2. **types tell the truth** — are you lying to the compiler? do abstractions match their names?
3. **naming is honest** — would someone reading this in six months be confused?
4. **edges tested** — what happens on the worst path, not just the happy path?
5. **self-consistent abstractions** — can you explain it start to finish, and each part in isolation?

slop indicators:
- missing tests
- contradictions in abstractions
- names that lie about what they contain

## applying to findings

before reporting an issue:

```
1. can i cite the exact code location? (line numbers, file paths)
2. did i trace the actual conditions, or pattern-match?
3. did i try to prove myself wrong?
4. what's my confidence: VERIFIED / HUNCH / QUESTION?
```

if any answer is weak, either investigate more or label appropriately.

## report format

```markdown
## finding: <title>

**confidence:** VERIFIED | HUNCH | QUESTION
**location:** file:line or range
**evidence:** what the code actually shows
**falsification attempted:** what would disprove this, did i check?
```
