# local agent baseline

date: 2026-09-28. scope: local instructions, skills, installation, and relevant pi loading/policy. the broader research corpus contains 15 videos per the research coordinator; this report does not evaluate those videos or pstack.

source HEAD at preservation: `3b02938a3c464ea2acbfa2a4497f3487f284b484`. the audit examined working-tree files, not an immutable checkout. before creating this report, `git status --short` showed:

```text
 M modules/pi/package.json
 M modules/pi/packages/core/pi-spawn/index.ts
 M modules/pi/packages/core/pi-spawn/package.json
 D modules/pi/packages/core/pi-spawn/remote-services.ts
 D modules/pi/packages/core/pi-spawn/remote.ts
 M modules/pi/packages/core/sub-agent-render/index.ts
 M modules/pi/packages/extensions/delegate/index.ts
 M modules/pi/pnpm-lock.yaml
 M modules/pi/pnpm-workspace.yaml
?? modules/agents/research/
```

these pre-existing changes were not modified. the initial audit was read-only; this preservation creates only this report. no quality or productivity gain is established.

source citations are pinned to the preservation HEAD so later implementation
does not retarget historical evidence. filesystem/runtime observations still
describe the audited working tree, not a replay of an immutable checkout.

## source-of-truth and load map

- **instructions:** [default.nix:8–16,33–40](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/default.nix#L8) links `config/global-agents.md` into commonplace and pi/claude/cursor/codex instruction locations. filesystem resolution confirmed commonplace and pi both reach that source.
- **local skills:** [default.nix:25–30,42–43](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/default.nix#L25) recursively installs 23 source directories into `~/.config/agents/skills`, also exposed through `.agents/skills` and cursor. all 23 local skill bodies byte-matched installed counterparts.
- **external skills:** [skills.nix:7–23](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills.nix#L7) overlays linear, hunk-review, vercel-react-best-practices, and web-design-guidelines from flake inputs.
- **remote projection:** [skills.nix:1–3](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills.nix#L1) identifies the portable authority; [project-skills.sh:1–3,30–42](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/git/project-skills.sh#L1) overlays owned directories while retaining destination-only skills. it is not a mirror.
- **pi:** [settings.json:3–5,21](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/pi/settings.json#L3) selects the installed directory and disables skill-command discovery. [skill/index.ts:69–89](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/pi/packages/extensions/skill/index.ts#L69) uses native discovery with defaults enabled. installed pi 0.87.1 `docs/skills.md:43–53` distinguishes advertised descriptions, on-demand bodies, and explicit commands.

## findings

### 1. repeated baseline policy

**VERIFIED.** [global instructions:1–23,48–58](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/config/global-agents.md#L1) overlap [write:13–30](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/write/SKILL.md#L13) and [review:19–29](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/review/SKILL.md#L19). this audit session also received the global source as both user-level pi instructions and ancestor commonplace instructions.

**falsification:** resolving both links ruled out independently maintained copies, not duplicate injected content. performance effects were not measured.

**candidate:** retain canonical policy; reserve optional skill bodies for task-specific procedures/examples. test context deduplication separately.

### 2. broad triggers weaken selective loading

**VERIFIED.** [write:3](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/write/SKILL.md#L3) applies to nearly every non-code-only response. [review:3,10–15](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/review/SKILL.md#L3) covers defensible findings; [dig:3,10](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/dig/SKILL.md#L3) covers investigations and requires review.

**falsification:** inspected actual descriptions, not names. a narrower existing counterexample is [building-review-playgrounds:3](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/building-review-playgrounds/SKILL.md#L3): use only when existing routes/stories cannot reproduce needed states.

**candidate:** adopt explicit applicability boundaries; evaluate whether general writing/review policy needs another load.

### 3. investigation procedure omits the global delegation threshold

**VERIFIED.** [global instructions:44–46](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/config/global-agents.md#L44) permit delegation when independent breadth or adversarial review materially helps. [dig:42–50,125–139](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/dig/SKILL.md#L42) prescribes verification agents per major claim and a multi-agent pipeline.

**falsification:** no small-task exemption appears in that procedure. global conditions can govern it; the instructions are compatible when delegation materially helps. this does not prove habitual overdelegation.

**candidate:** make the pipeline conditional and give it stopping criteria.

### 4. memory retrieval guidance contradicts the accepted boundary

**VERIFIED.** [global instructions:75–79](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/config/global-agents.md#L75) prohibit canonical-memory fallback searches and direct raw-session retrieval. [remember:129–140](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/remember/SKILL.md#L129) still recommends canonical-root `rg` and `qmd search -c pi-sessions`.

**falsification:** the newer signal-driven rule exists at [remember:117–119](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/remember/SKILL.md#L117), but does not reconcile those commands. installed/source equality rules out body installation lag.

**candidate:** reconcile before redesigning memory workflows. preserve [remember:171](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/remember/SKILL.md#L171): accepted skill proposals are drafts, never automatic installed-skill edits.

### 5. native discovery and session catalog disagree

**VERIFIED, bounded.** source [data-visualization/SKILL.md](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/agents/skills/data-visualization/SKILL.md) has uppercase filename casing. installed directory enumeration exposed lowercase `skill.md`, pointing to an uppercase store file. native pi's installed `dist/core/skills.js:136–138` requires an exact `SKILL.md` entry name.

**falsification:** actual native `loadSkills` returned 27 skills, 26 automatically invocable, no diagnostics, and no data-visualization. body bytes matched. meanwhile, this session's injected catalog advertised data-visualization at `~/.agents/skills/data-visualization/skill.md`.

**candidate:** test source/installed/discovered/advertised parity. this is a native discovery defect in the observed installation, NOT proof the session lacks the skill. the separate catalog injection path was not traced.

independent verification reproduced the parent-directory discovery omission and
loaded data-visualization successfully by its explicit lowercase file path.
the content is readable; the mismatch is recursive directory discovery.

### 6. custom skill executor does not consume arguments

**VERIFIED by control-flow inspection.** [skill/index.ts:142–150](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/pi/packages/extensions/skill/index.ts#L142) advertises `arguments`; [execution:169–230](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/pi/packages/extensions/skill/index.ts#L169) uses only `name` and returns body/directory/files.

**falsification:** inspected the complete executor for forwarding; none exists. native `/skill:name arguments` documentation does not establish custom-tool support. no execution test was run.

independent verification also traced tool-call arguments being serialized into
subsequent model requests by the installed pi-ai
`dist/api/openai-responses-shared.js:205–237`, used by
`dist/api/openai-codex-responses.js:379–394`. arguments can therefore remain
available in conversation history. this is an executor omission, not demonstrated
conversation-wide loss or proof of a user-visible failure.

**candidate:** specify and test the intended argument contract before choosing
whether the executor should consume it or the advertised parameter should change.

### 7. useful tests exist, but not a general skill-quality suite

**VERIFIED within searched scope.** [company-money boundary test:11–21](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/company-money/skill-boundary.test.ts#L11) checks manual/bounded/read-only instructions. [projection tests](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/git/project-skills.test.py) cover publication mechanics. [memory evaluation:95–117,773–833](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/pi/packages/core/agent-memory/evaluation.ts#L95) evaluates memory contexts.

**falsification:** searches covered agents, scripts, workflows, pi, and other modules; found these counterexamples, but no general skill-routing dataset or authoring gate. absence is scoped, not repository omniscience.

**candidate:** add skill-specific cases around existing infrastructure; do not call memory scores skill-quality scores.

### 8. preserve constraints; distinguish prose from enforcement

**VERIFIED.** [global instructions:29–58](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/config/global-agents.md#L29) already supply authorization, read-only mode, narrow verification, and evidence standards. [tool-policy.json](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/pi/tool-policy.json) rejects selected staging/force-push/deletion patterns, then allows everything else.

**falsification:** [evaluator:4–13,119–154](https://github.com/bdsqqq/dots/blob/3b02938a3c464ea2acbfa2a4497f3487f284b484/modules/pi/packages/core/tool-policy/index.ts#L4) explicitly disclaims a security boundary and has no confirmation action. unmatched calls allow.

**candidate:** label requirements as instructions, executable guardrails, or tested outcomes; do not reinvent the existing policy.

## probes and limits

actually performed:

- python `Path.iterdir()`, `resolve()`, and `read_bytes()` comparisons across source/installed skills and instruction links; directory counts and filename inspection.
- native loader probe below, first from `modules/pi`, then with workspace-root `cwd`; both reported no diagnostics.
- read/grep inspection and bounded search agents for authoring/evaluation and tool-policy counterexamples; relevant pi skills/settings/packages/configuration docs read.
- preservation: `git rev-parse HEAD`, `git status --short`, and `pi-memory project-proposals --sync --cwd /Users/bdsqqq/commonplace/01_files/nix` (no proposals).

```javascript
// node --input-type=module, executed from modules/pi
import { loadSkills } from "@earendil-works/pi-coding-agent";
const r = loadSkills({
  cwd: "/Users/bdsqqq/commonplace/01_files/nix",
  agentDir: "/Users/bdsqqq/.pi/agent",
  skillPaths: ["/Users/bdsqqq/.config/agents/skills"],
  includeDefaults: true,
});
console.log(r.skills.length, r.diagnostics);
```

no activation, publication, model evaluation, or live behavioral comparison occurred.

## proposed measurement baseline

freeze source hashes, installed casing, discovered/advertised inventories, diagnostics, model, and thinking level. use reviewed cases for trivial conversation, read-only review, investigation, authorized mutation, documentation, overlapping UI skills, explicit arguments, and memory exclusions.

record expected/actual selection, unnecessary loads, instruction bytes, authorization violations, unsupported findings, task-test outcomes, and reviewer corrections. tool calls, elapsed time, and tokens are costs—not quality proxies. compare identical cases with blinded review where practical; preserve current authorization and verification boundaries as acceptance criteria.
