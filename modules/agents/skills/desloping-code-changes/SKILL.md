---
name: desloping-code-changes
description: "Tests whether code-change complexity is justified by behavior and local contracts. Use for a focused craft review of copied styling, wrappers, names, types, or abstractions in a diff."
metadata:
  archetype: epistemic
---

# desloping code changes

every proposed cleanup needs evidence that it improves this change. fewer lines are not automatically better, and an unchanged diff is a valid result.

## contract

- input: bounded diff, intended behavior, repository conventions, and whether edits are authorized.
- output: justified edits or location-specific findings; retained exceptions; verification results and unresolved uncertainty.
- termination: every candidate is accepted with evidence, rejected, or explicitly unresolved; accepted edits are verified. no finding quota, repeated clean-round requirement, or expansion into unrelated code. review-only requests remain read-only.

## test necessity before deleting

read the owning component and relevant consumers. distinguish incidental implementation carried from old code from a constraint the new implementation still needs. ask what removing the candidate would break, then inspect or exercise that case. never infer redundancy solely from visual similarity or a name.

for each consequential finding record:
- location and the specific behavior or contract at stake;
- VERIFIED for traced evidence, HUNCH for an untested interpretation, or QUESTION for a missing product decision;
- what would disprove the finding and whether that check ran.

resolve ordinary uncertainty by reading the source or testing. ask only when missing intent materially changes the decision. do not manufacture certainty to make a review sound finished.

## inspect the changed surface

- **copied styling:** shared defaults should own common chrome. keep semantic colors, width/wrapping, positioning, and interaction exceptions where consumers genuinely need them. do not mechanically strip all classes or replace intentional distinctions with global defaults.
- **wrappers and props:** remove forwarding-only layers and redundant options only after tracing layout, semantics, refs, event handling, and library composition requirements. a wrapper can be necessary even if it has no styling. an option the underlying primitive cannot support is a dishonest API, not flexibility.
- **comments and stacking:** delete narration of obvious code and agent/process instructions from product code. retain concise reasons for non-obvious constraints. a large z-index or pseudo-element patch needs an actual stacking/geometry reason; inspect the owning primitive before layering another workaround.
- **names and types:** names are contracts. reject names requiring “but actually…” explanations, duplicated generated schemas, and assertions that hide incompatible values. derive a type from authoritative data where appropriate; do not introduce a renamed alias that preserves the same lie.
- **abstractions:** prefer the existing owner/API. a new helper must remove meaningful duplication or own a coherent responsibility, not merely relocate lines. keep a simple exceptional case local rather than designing hypothetical configuration.
- **scope:** exclude opportunistic renames, formatting churn, unrelated bug fixes, and temporary capture/coordination residue. do not overwrite another author's changes. a clean implementation may still have missing evidence; route that gap to `producing-visual-evidence` instead of redesigning code to make screenshots easier.

## canonical counterexamples

**“all wrappers are slop.”** a content primitive uses flex layout; text and an inline duration become separate flex items. wrapping the whole sentence restores inline text flow. keep that wrapper and test mixed text plus the emphasized value at narrow width. similarly, a nowrap span around `--push.` can preserve punctuation attachment; deleting it because spans look redundant changes typography. the criterion is observed flow, not tag count.

**“shared defaults mean no consumer classes.”** a long identifier overflows a narrow viewport, but the consumer intentionally allows wider content on desktop. retain the bounded width/wrapping exception and verify both widths. removing it as duplication loses behavior; imposing the largest width everywhere also fails. exact historical viewport sizes are test inputs, not universal design tokens.

**“a visual patch proves the primitive is fixed.”** an added mask hides a floating arrow's broken border while its ownership is wrong. inspect the library's current composition contract and rendered geometry before retaining the mask. in the Depot migration, Base UI popup/arrow ownership mattered; that is evidence to inspect underlying APIs, not a portable rule to copy one library's dimensions into every tooltip.

## evaluation and exit

challenge the pass with both a removable and a necessary construct: a prop equal to its verified default, and a wrapper required to keep sentence flow. a bad pass deletes both; a useful pass removes only the redundant prop and explains the retained wrapper with evidence. also reject an attractive abstraction with only one trivial caller unless it owns a real contract.

when editing, keep behavior preservation separate from intentional behavior changes. run the narrow checks that exercise accepted edits. for a behavior correction, observe the failure, automate that observation, and confirm the test fails without the fix in a disposable copy when practical. explicitly report any missing regression proof. UI appearance changes need rendered inspection; geometric claims need measurements, not merely type checking. do not claim the result works because it reads well.

finish when this diff's supported issues are resolved or reported. summarize why the retained complexity is necessary and what remains unverified; do not write a praise-filled cleanup report.

## provenance

[depot migration](https://ampcode.com/threads/T-01a08307-6d5a-715a-82c9-cddd3b28d3cc): responsive width, punctuation, flex text flow, unsupported portal options, and arrow-mask corrections. normative: [meaningful contribution](https://gist.github.com/bdsqqq/1e7e6f454271d5f856a1176d0e800d89), [skill design](https://gist.github.com/bdsqqq/a699a7d85d43f5df0c6e0fe93c827e65). constraints above stand without opening these links.
