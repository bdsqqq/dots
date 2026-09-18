---
name: building-review-playgrounds
description: "Exposes hard-to-reach UI states through issue-scoped production-component fixtures. Use when existing routes or stories cannot reproduce states needed for review."
metadata:
  archetype: rule-following
---

# building review playgrounds

build the smallest surface that reproduces the issue, not a second implementation.

## contract

- input: issue or bounded change, production components/consumers, required states, available local data, and removal condition.
- output: reproducible route/story/fixture, state selectors or instructions, explicit fixture boundaries, and a list of temporary files or gates.
- termination: required states render through production code in representative layout, limitations are explicit, and removal is either verified or assigned to an explicit acceptance condition. capture/review claims belong to `producing-visual-evidence`.

## procedure

1. try an existing application route or component story first. add a playground only when missing data, permissions, or setup prevents exercising required states. do not create one for a single readily reachable state.
2. place it within the repository's preview conventions and scope it to the issue. prefer a local in-layout fixture when surrounding table, sidebar, scroll container, or flex context determines behavior. a helper demo does not establish that its real consumer works.
3. import production components and styles. fixture only the unavailable inputs or external boundary; preserve the rendering and interaction under review. list what is synthetic and what therefore remains unverified. use fake data, never copied customer secrets.
4. select states from the changed contract: ordinary content plus the long, empty, disabled, error, permission, or narrow-layout cases that could fail differently. preserve semantic distinctions instead of making every fixture the happy path. provide stable controls/selectors so the same state is repeatable.
5. keep fixtures out of ordinary user navigation and production data paths. a query parameter alone is not an access-control boundary. prefer local-only wiring; if a committed route is necessary, use the application's supported development guard and verify production exclusion. never weaken authentication to make capture easier.
6. record how to start and reach the fixture, its state-to-consumer mapping, and removal criteria. after review, remove temporary wiring and data within authorized scope; check imports, routes, build inputs, and the diff for residue. move genuinely useful regression coverage into the existing test/story system rather than retaining a migration museum.

## evaluation

given a table cell that clips only with long content, a standalone centered component is insufficient. load the real cell in its constrained container, inject long fixture data, and confirm the expected wrapping/overflow state is reachable. inspect the rendered result, not just route compilation. reload and reproduce it without manual database edits.

verify the ordinary route still uses ordinary data, and that a production build cannot expose local-only fixtures. after removal, run the relevant build/type check and search for the fixture identifier/imports. report any retained fixture and its owner/removal condition; never claim cleanup from an empty screenshot.

## provenance

[depot migration](https://ampcode.com/threads/T-01a08307-6d5a-715a-82c9-cddd3b28d3cc): missing workflow data needed temporary in-layout fixtures, later removed. normative: [meaningful contribution](https://gist.github.com/bdsqqq/1e7e6f454271d5f856a1176d0e800d89), [skill design](https://gist.github.com/bdsqqq/a699a7d85d43f5df0c6e0fe93c827e65). constraints above stand without opening these links.
