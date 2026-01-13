---
name: rounds
description: iterate with spawned agents until stable. use for multi-pass review, verification, or any task where first-clean can't be trusted.
---

# rounds

iterate with spawned agents until results stabilize.

**prerequisite skills**: `spawn`, `coordinate`, `report`

## core rule: don't trust first clean

round 5 finding issues after round 4 was clean is common. run **2-3 verification rounds minimum** after issues stop appearing.

## round lifecycle

```
round N:
  1. spawn agents for task (parallel if independent)
  2. wait for reports
  3. if issues → spawn fix agents → wait → proceed to N+1
  4. if clean → proceed to N+1 anyway (verify the clean)
  5. repeat until 2+ consecutive clean rounds
```

## injecting skills into spawned agents

tell spawned agents which foundation skills to load. example for code review:

```
load the review skill before evaluating. load the write skill for report quality.
```

adapt based on task:
- code review → inject `review`, `write`
- investigation → inject `review`, `dig`
- docs review → inject `review`, `write`, `document`

## ambiguous decisions

when agents find issues requiring product decisions ("remove feature X or implement it?"), **pause and ask user**. don't make product decisions unilaterally.

## summary format

after completion:

| round | result |
|-------|--------|
| 1 | 3 issues → fixed |
| 2 | clean |
| 3 | clean |

list all changes made across fix phases.
