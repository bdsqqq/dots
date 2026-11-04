# behavioral cases and origins

these are acceptance cases, not claims that a model followed the skill. use the
same task, fixture, tools, and budget with and without the skill; inspect actual
code/actions, not the candidate's self-report. keep acceptance criteria out of
candidate prompts. selection cases live in the collection's existing routing
fixtures; selection alone does not exercise this body.

## cases

### publish a note from CLI and HTTP

**request:** “the publish route works. add a CLI so i can publish the same notes
from a terminal. keep existing conflict behavior.”

**fixture:** file-backed notes, revision checks, an existing route, and a native
CLI parser. no procedure framework dependency.

**accept:** one callable publish operation; both adapters exercise real temporary
storage; stale revisions do not overwrite content; CLI failure is nonzero and
HTTP failure remains a conflict. preserve the route's compatibility. don't add a
framework just to wrap one function.

**known failure:** make the CLI treat a resolved conflict as success. its command
check must fail even though the direct handler check still passes.

### project node operations into a CLI

**request:** “we have a procedure router for node list/describe. expose it in a CLI;
i want future operations to appear without wiring each one twice.”

**accept:** use the existing router/adapter; inspect generated help and invoke
`node describe` with the expected positional input. add `node.exists` through the
behavioral module and verify it is callable without a second operation registry.
keep caller identity/private dependencies out of public flags.

**known failure:** add an independent adapter command table. the extension check
must detect that the third operation is missing.

### expose session history without another read

**request:** “make our session listing/reading callable directly and through agent
tools. callers may already have loaded a selected branch.”

**accept:** typed identity and branch selection; shared handlers; structured errors
through the tool adapter; a supplied snapshot still works after removing its
backing file; siblings and other workspaces do not leak into the result.

**known failure:** silently reread supplied data. removing the fixture file must
make that implementation fail, while an ordinary file-backed request still works.

### keep nearby tasks small

- “let callers replace the submit button” → component API customization, not a
  new operation registry.
- “reuse this member list in a tooltip with supplied data” → data/shell ownership;
  use this skill additionally only if extracting an independently callable action.
- “add a health route” → ordinary route work unless actual reuse/generation is
  requested. don't manufacture a domain package.

## historical examples, not current repository facts

- fleet node catalog: the September 1–3, 2026 conversation began with “schemas and
  procedures … used across clis, web apps … maybe an api too.” the subsequent
  correction rejected horizontal schema/contract/operation files in favor of
  behavioral verticals. historical implementation:
  [node-catalog public surface](https://github.com/bdsqqq/dots/blob/c413daf6/modules/fleet-mesh/node-catalog/public.ts).
- desired state: the same conversation added `desiredState.set/status` and CLI
  exposure. site/API projection was future work, not evidence of a shipped web
  adapter. native Pi session `01a05e60-d2ef-775b-8281-9964e2b29daf`, JSONL lines
  1763–2178, records implementation and live acceptance separately.
- Pi session history: October 17, 2026 instruction: “contracts first, with handlers
  implementing a contract, and those being exposed through our extensions for
  different interfaces.” historical adapter:
  [session-history](https://github.com/bdsqqq/dots/blob/e63caf6ba5db38a451739a142220f948c5762ff9/modules/pi/packages/extensions/session-history/index.ts).
  native Pi session `01a14a48-6e2f-7393-af96-dfcbe93e58b1`, JSONL lines 109–136,
  distinguishes direct `listSessions/readSession` from `history_list/history_read`.

## authoring sources

- Theo, [skill descriptions as invocation triggers](https://www.youtube.com/watch?v=e1snsuY4lTI&t=750s),
  12:30–13:30; archived automatic captions were inspected. the description routes
  requests; procedural instructions belong in the body. his
  [15:00–15:47 examples discussion](https://www.youtube.com/watch?v=e1snsuY4lTI&t=900s)
  informs the concrete publish-operation bad/good pair in this skill.
- the supplied `agent-skill-guidelines/skill-archetype-research-report.md`
  distinguishes procedure execution from pattern teaching. this skill teaches a
  design pattern, so its essential code example stays in the body, not only in
  these acceptance cases. the archive's token budgets are heuristics, not measured
  limits for this skill.
- poteto/pstack, [authoring a skill](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/authoring-a-skill.md):
  keep prose that changes decisions; reference structural sources rather than
  duplicate them. Cursor-specific built-ins and PR steps were not imported.
- poteto/pstack, [evaluation](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/eval.md):
  ordinary candidate prompts, held-back acceptance, inspect artifacts/actions.
- poteto/pstack, [encode lessons in structure](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/principle-encode-lessons-in-structure/SKILL.md):
  deterministic guarantees belong in types, boundary checks, and tests. this skill
  holds the conditional design choices, not a substitute for those mechanisms.
