---
name: review-rounds
description: iterative code review with spawned subagents. orchestrates review/fix cycles until verified clean. use for multi-file reviews, pre-merge validation, or quality passes where first-clean can't be trusted.
---
# review-rounds

systematic review using spawned subagents with iterative fix cycles.

**prerequisite skills**: `spawn`, `coordinate`, `report`

## core rule: don't trust first clean

round 5 finding bugs after round 4 was clean is common. run **2-3 verification rounds minimum** after issues stop appearing.

## round lifecycle

```
round N:
  1. spawn review agents (parallel: code + docs)
  2. wait for reports
  3. if issues → spawn fix agents → wait → proceed to N+1
  4. if clean → proceed to N+1 anyway (verify the clean)
  5. repeat until 2+ consecutive rounds where BOTH code and docs are clean
```

## skills review agents should load

instruct review agents to load these skills before reviewing:

- `write` — academish voice, precision without hyperbole, supported claims
- `document` — only document non-obvious why

these define what "quality" means in this context. without them, reviews catch syntax but miss substance.

## review agent focus areas

### code review
- types tell the truth?
- naming honest?
- abstractions self-consistent?
- edge cases tested?
- claims supported?

### docs review
- docs match implementation?
- examples compile?
- only documents non-obvious why?
- avoids hyperbole and absolutist language?

## ambiguous decisions

when review finds issues requiring product decisions ("remove feature X or implement it?"), **pause and ask user**. don't make product decisions unilaterally.

## summary format

after completion:

| round | code | docs |
|-------|------|------|
| 1 | 3 issues → fixed | clean |
| 2 | clean | 1 issue → fixed |
| 3 | clean | clean |
| 4 | clean | clean |

list all changes made across fix phases.
