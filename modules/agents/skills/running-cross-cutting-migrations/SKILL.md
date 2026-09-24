---
name: running-cross-cutting-migrations
description: "Coordinates bounded migrations across independently owned code clusters. Use when inventory, shared contracts, adoption, and rollout need one integration owner."
metadata:
  archetype: rule-following
---

# running cross-cutting migrations

compose capabilities, not review ceremonies. the coordinator owns integration and independent validation.

## WHEN NOT TO USE

skip for localized changes, one-source lookups, or ordinary reviews. load the needed leaf skill. composition does not require multiple agents.

before spawning, answer:
1. can i do/verify it myself in under 10 minutes? if yes, do it.
2. is there one source of truth? read it directly; do not multiply interpretations.
3. will agents produce conflicting findings about the same artifact? prefer one grounded pass over a review court.
4. are exit criteria explicit? define them before assigning work.
5. is work truly independent? shared files or unsettled contracts require sequencing.

delegate only for independent work, genuine specialization, or useful context isolation. name that benefit; complexity alone does not qualify.

## contract

- input: migration outcome, scope, compatibility requirements, repository state, and release authorization.
- output: integrated change, accounted-for occurrences/exceptions, validated evidence, and explicit rollout/cleanup status.
- termination: acceptance criteria hold on the integrated revision; requested deployment and cleanup are reconciled, or specific blockers/approval boundaries are reported. merged is not deployed.

## compose only what is needed

load skills by name when their stage is needed; their contracts own the details:

| capability | handoff |
| --- | --- |
| `shaping-and-shipping-software` | scoped outcome and owned issues |
| `inventorying-codebase-patterns` | reproducible occurrence map and exceptions |
| `building-review-playgrounds` | reachable representative consumer states |
| `desloping-code-changes` | justified diff and retained constraints |
| `producing-visual-evidence` | inspected claims mapped to states/revisions |

if a dependency is unavailable, report it rather than inventing a replacement methodology.

settle shared contracts before adoption. assign disjoint clusters with exact file ownership, forbidden shared files, exceptions, outputs, and exit criteria. transfer the actual code/base; a commit identifier does not transfer unpushed work. keep merge/release authority explicit.

use one progress surface. when Linear updates are authorized, link parent outcome to owned children; keep completed/current work, blockers, and evidence visible. avoid duplicate trackers. worker completion is not acceptance.

inspect returned diffs/evidence and independently run combined checks on the integrated revision. reopen slices for concrete failures, not mandatory review rounds. require observed behavior and regression proof, not worker confidence. account for every occurrence or exception.

before closing rollout, check the actual deployed revision and release state when deployment is requested. do not deploy merely to complete a checklist. keep cleanup explicit: remove expired fixtures/catalog gates/assets within scope, preserve useful regression tests and durable migration boundaries, then verify removal. publication and remote changes need authorization.

## evaluation

a one-file five-minute change must yield no delegation. two clusters editing the same shared component must serialize until ownership is resolved. child checks passing with an integrated failure must remain incomplete. a merged change with a pending deployment must be reported as pending, not shipped.

## provenance

[depot migration](https://ampcode.com/threads/T-01a08307-6d5a-715a-82c9-cddd3b28d3cc): adoption ownership and rollout reconciliation. normative: [meaningful contribution](https://gist.github.com/bdsqqq/1e7e6f454271d5f856a1176d0e800d89), [skill design](https://gist.github.com/bdsqqq/a699a7d85d43f5df0c6e0fe93c827e65).
