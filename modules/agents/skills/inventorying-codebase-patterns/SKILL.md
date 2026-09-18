---
name: inventorying-codebase-patterns
description: "Builds replayable, source-derived catalogs with drift checks. Use when a migration or audit needs a trustworthy inventory across files."
metadata:
  archetype: rule-following
---

# inventorying codebase patterns

make the inventory reproducible; a plausible count is not coverage.

## contract

- input: repository/revision, pattern definition, included paths, exclusions, and consumers of the inventory.
- output: deterministic generator, catalog with source coordinates and exceptions, and an exercised non-writing `--check` wired into the relevant validation path.
- termination: replay is stable, detection and stale-output tests pass, and unresolved extraction limits are reported. an inventory does not authorize migration.

## procedure

1. inspect real occurrences before choosing extraction. use scoped text search for discovery; use the repository's parser when aliases, nested syntax, conditional classes, or wrappers affect meaning. document unsupported dynamic expressions rather than guessing values.
2. define the inclusion rule and test both a known match and a near-match that must be excluded. search separately for alternative spellings/imports or wrappers to challenge completeness. exclude generated output from its own inputs.
3. emit normalized paths, source coordinates, stable ordering, and only fields consumers need. omit timestamps and machine-specific paths. distinguish static alternatives from values known to occur at runtime. keep intentional exceptions identifiable, not buried in counts.
4. derive generated data and consumer types from one source of truth. for literal records, prefer `type Variant = (typeof variants)[number]` over a parallel handwritten shape. do not cast away extraction failures. generated files name their regeneration command; edits belong upstream.
5. make write mode regenerate; make `--check` compute expected output and compare without modifying files, exiting nonzero on missing or stale output. ensure formatting is deterministic in both modes.
6. invoke the check from the actual ci/package validation entry point when the catalog must stay current. inspect command order: regeneration before comparison can silently repair drift and defeat the gate. declaring a script is not wiring it into ci.

## evaluation

in a disposable copy, generate twice and compare bytes. independently assert expected records for a small fixture containing an alias, a conditional branch, and an excluded near-match when supported. then corrupt a generated count or remove the output: run the actual validation entry point, expect nonzero, and confirm it did not repair the file. regenerate and expect success. change an input occurrence too; the check must detect source drift, not only file corruption. preserve the original worktree.

report the commands, decisive outputs, scope, and known blind spots. if the catalog is temporary, name its removal condition and which durable enforcement replaces it; do not preserve a second truth after its consumer disappears.

## provenance

[depot migration](https://ampcode.com/threads/T-01a08307-6d5a-715a-82c9-cddd3b28d3cc): source-derived types and a stale catalog missed by ci until the check was wired and falsified. normative: [meaningful contribution](https://gist.github.com/bdsqqq/1e7e6f454271d5f856a1176d0e800d89), [skill design](https://gist.github.com/bdsqqq/a699a7d85d43f5df0c6e0fe93c827e65). constraints above stand without opening these links.
