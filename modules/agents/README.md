# agent guidance and its contracts

global instructions define stable personal defaults; skills supply conditional
procedures. repeatable invariants belong in executable checks. the separation
keeps routine tasks from loading every workflow while making substantial work
easier to verify.

## ownership

| source | purpose |
|---|---|
| [`config/global-agents.md`](../../config/global-agents.md) | voice, permissions, completion, delegation, evidence, governed memory |
| [`skills/write/SKILL.md`](skills/write/SKILL.md) | substantial prose composition/editing, not every response |
| [`skills/review/SKILL.md`](skills/review/SKILL.md) | read-only implementation review |
| [`skills/dig/SKILL.md`](skills/dig/SKILL.md) | uncertain multi-step investigation, direct-first and optionally delegated |
| [`skills/making-meaningful-contributions/SKILL.md`](skills/making-meaningful-contributions/SKILL.md) | pre-submission readiness, not a second general review |
| [`skills/remember/SKILL.md`](skills/remember/SKILL.md) | authorized personal memory capture; project knowledge stays in the repository |
| [`skills/designing-agent-skills/SKILL.md`](skills/designing-agent-skills/SKILL.md) | authoring, selection cases, and behavioral evaluation |

the default completion contract is outcome, scope, constraints, acceptance,
and stop conditions—not a mandatory planning document. complete all agreed slices
of a bulk pass. independent delegates get owned scope and evidence requirements;
one primary owner integrates. when repeated attempts fail, change the approach
or report a blocker instead of endlessly retrying the same strategy.

## source versus installed

feature-owned skills keep their canonical `SKILL.md` beside their Nix declaration
and native settings; see the [editable module pattern](../README.md).
the portable collection keeps cross-cutting workflows and relative entrypoint
links for `gog`, `wacli`, `goplaces`, `openhue`, `xurl`, `weather`, `remindctl`,
and `obsidian`: `skills/<cli>/SKILL.md -> ../../../<cli>/SKILL.md`.

[`default.nix`](default.nix) links `~/.config/agents/skills`,
`~/.agents/skills`, `~/.claude/skills`, and `~/.cursor/skills` out of store to
the live `skills/` checkout. source edits apply immediately; a running session's
already-loaded skills and instructions need refresh.

the collection root owns these aliases; feature modules must not add nested
`home.file` skill entries beneath them. hosts select packages through explicit
feature imports. a discoverable skill does not establish binary installation,
runtime availability, account access, or authorization to act.

external skills are vendored, not fetched: `linear` from `bdsqqq/lnr`,
`hunk-review` from `modem-dev/hunk`, and `vercel-react-best-practices` /
`web-design-guidelines` from `vercel-labs/agent-skills`. update them by copying
upstream. skills that other programs install into an agent's skills directory
land in this checkout as untracked files; commit or discard them.
`reverse-engineer-anything` stays with its installed REA release through
[`../pi/settings.json`](../pi/settings.json), not this collection.

the [pi skill executor](../pi/packages/extensions/skill/index.ts) keeps caller
arguments after the instruction block as a lossless JSON string. absence/blank
input preserves prior output. escaping tag delimiters avoids making caller input
look like a second instruction block; it is not a security sandbox.

## run the checks

requires the existing `modules/pi` dependency installation and Node with native
type stripping. all new maintenance scripts/tests are typescript.

```bash
node --experimental-strip-types modules/agents/check-skills.ts
node --experimental-strip-types --test modules/agents/check-skills.test.ts \
  modules/agents/evaluate-skill-routing.test.ts modules/agents/cli-live-skills.test.ts
(cd modules/pi && pnpm exec tsc -p ../agents/tsconfig.json)
```

the checker uses native discovery, exact directory-entry casing, frontmatter,
portable entrypoint references, and source/discovered parity. supporting-document
internal links warn separately; `--all-document-links` audits them strictly.
the warning distinction preserves imported historical evidence without making
its unavailable old appendices part of today's executable workflow contract.
heading fragments and remote links are not validated.

`tsconfig.json` uses strict checking with `skipLibCheck`, matching pi's treatment
of upstream declarations. that checks our source, not every vendor declaration.

when model invocation is authorized:

```bash
node --experimental-strip-types modules/agents/evaluate-skill-routing.ts --live
# narrower investigation of one case:
node --experimental-strip-types modules/agents/evaluate-skill-routing.ts \
  --live --case dig-not-known-lookup
```

the runner uses existing Codex OAuth without API-key fallback, fresh requests,
source descriptions, and ordinary fixture prompts. only `skill` and native
`read` metadata are advertised; no executor runs and no user session history is
sent. reports retain observed calls, clarification text, usage, and source hashes.
these are selection probes—not complete production sessions or skill-body tests.

missing input can legitimately require clarification. positive fixtures supply
the material needed for their task. incomplete-input behavior belongs in a
different case, not a falsely failing positive routing gate.

## historical implementation verification — 2026-09-29

these results describe that earlier artifact and fixture set, before the current
live collection and colocated CLI entrypoint links. they are not verification
of today's discovery layout or counts.

**VERIFIED within this scope:**

- 39 Node tests: structural/native loading, scorer negative controls, and seven
  evaluated-hook runtime cases on a case-insensitive darwin filesystem.
- 31 pi tests: executor outcomes, prompt policy, and actual Codex request-builder
  registry/schema parity for source and built tools.
- strict agent-script and pi typechecks; pi formatter and package build.
- all 12 live selection probes passed on the final fixture set; see
  [recorded fingerprints and observations](routing-observations.json).
- native `mbp-m2` system derivation evaluated; home-manager activation artifact
  built, not activated.
- a verification-only `extendModules` source override included the untracked
  authoring skill without staging: all 24 local entrypoints byte-matched the
  built artifact, and all 28 local/external skills were natively discoverable.
  generated repair-hook ordering was inspected after `linkGeneration`.

earlier probes failed: one positive task lacked its notes, another lacked a patch,
and the first harness advertised no read tool for a file lookup. those runs were
not relabeled as passes; input/tool coverage was corrected and the final set
rerun. the scoring tests retain missing-selection and clarification failure cases.

remaining gaps: skill-body compliance and productivity are not measured by these
probes; linux activation behavior was not built; deployed home copies were not
changed. eight old internal source-link occurrences remain warnings locally
(eleven including external skills in the built collection). no host activation,
commits, pushes, or external publication occurred.

## iterate on outcomes

after substantive changes, rerun affected checks and compare matched tasks.
measure accepted, verified outcomes per hour of human attention. track correction
and inspection time, missed requirements, false findings, permissions, latency,
and cost. more generated code, agent count, or unattended runtime is not a quality
metric. preserve authorization and correctness before optimizing throughput.

the [theo/poteto research](research/2026-09-28/README.md) records source attribution
and qualifications; its original baseline describes the setup before this pass.
