---
name: producing-visual-evidence
description: "Produces inspected, state-indexed evidence from real UI. Use when a visual or interaction claim needs reproducible screenshots, recordings, or GitHub review evidence."
metadata:
  archetype: rule-following
---

# producing visual evidence

a capture proves only what was exercised and inspected, not everything its caption claims.

## contract

- input: changed revision, UI claims, routes/fixtures, required states, and authorized review destination.
- output: state matrix mapped to inspected artifacts, commands/assertions, revision/viewport metadata, and explicit omissions.
- termination: each claim has observed evidence or a blocker; final artifacts are inspected and publication verified or awaiting permission. no cleanup is implied.

## procedure

1. write the state matrix before recording: consumer, input/state, action, expected outcome, viewport, evidence/assertion. choose states that discriminate plausible failures, not a count quota. for floating UI include applicable hover, keyboard focus, dismissal, action behavior, narrow/desktop widths, and edge collision. mark inapplicable states with reasons.
2. run the real application or production-component fixture; use `building-review-playgrounds` only when required states are inaccessible. load the environment's browser skill. record revision and synthetic-data boundaries. generated mockups and DOM edits that force a passing appearance are not verification.
3. execute each action and assert its result through DOM/accessibility checks. for geometry, measure relevant bounds/computed styles: overflow, wrapping, arrow overlap, clipping, or collision placement. screenshots alone cannot establish a small gap hidden by shadow. automate the observed failure and show the regression test fails without the fix in a disposable copy; disclose limitations.
4. use screenshots for static appearance; record motion when transition, sequence, or timing matters. for multi-state GIFs, keep a persistent `1/N · state` label throughout each segment, incrementing once per matrix state. labels identify observations; they must not obscure the UI or imply an unshown action succeeded.
5. extract frames or a contact sheet from the final encoded GIF/video and inspect them with the media tool against the matrix. check every ordinal, visible state, legibility, clipping, and transitions. inspect screenshots too. if labels repeat while the UI never changes, recapture. encoding success and file existence are not coverage.
6. prepare GitHub-hosted evidence for GitHub review, with the tested code revision and state mapping beside it. publishing/uploading requires explicit authorization. prefer supported attachments; if unavailable, use approved repository assets with immutable commit-pinned URLs, never a moving branch. distinguish the tested revision from an evidence-only commit. verify final links and rendering. without permission, retain local artifacts and report publication pending; do not claim reviewers can access them.

## evaluation

challenge an eight-state recording that actually opens only the first item. the matrix-to-frame comparison must reject seven missing states even if all eight labels appear. challenge a desktop-only “no overflow” claim with long content at narrow width and bounds measurements. compare action assertions with captions: an open-state image cannot prove Escape dismissal.

return decisive checks and representative inspected evidence, with missing states and fixture limitations. for temporary assets, name removal criteria and retain an authorized immutable review link before cleanup; preserve unrelated artifacts.

## provenance

[depot migration](https://ampcode.com/threads/T-01a08307-6d5a-715a-82c9-cddd3b28d3cc): incomplete GIF coverage, persistent numbering, measured geometry, and pinned evidence. normative: [meaningful contribution](https://gist.github.com/bdsqqq/1e7e6f454271d5f856a1176d0e800d89), [skill design](https://gist.github.com/bdsqqq/a699a7d85d43f5df0c6e0fe93c827e65).
