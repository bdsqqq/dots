---
name: designing-agent-skills
description: "Create, revise, or evaluate reusable agent skills: triggers, procedures, references, and behavioral cases. Use when asked to write a skill, fix its selection, or improve its instructions; not when executing an existing skill or writing a one-off plan."
---

# designing agent skills

make one workflow easier to execute correctly, not another collection of advice.
global guidance owns voice and permissions. skill descriptions route tasks;
bodies change decisions. test those contracts separately.

## diagnose before drafting

1. inspect the target skill, related workflows, and actual harness. identify a
   recurring correction or explicitly requested capability:
   **when trigger, current failure; desired decision, observable result**.
2. choose the home: deterministic invariant → executable check; project fact →
   repository; personal default → global guidance; reusable conditional
   procedure → skill. a one-off plan does not automatically deserve a skill.
3. distinguish not discovered, not selected, not loaded, ambiguous instructions,
   unsupported tools, and failure to follow clear guidance. another paragraph
   does not fix all six.

## design the contract

- give the skill a coherent job. split procedures callers want independently:
  drafting is not publishing; filing a pull request is not monitoring it.
- write descriptions in request language with meaningful exclusions. keep steps
  in the body. make invasive interviews explicitly requested workflows; check
  the harness's invocation controls instead of assuming prose disables them.
- declare prerequisites and platform/tool assumptions. reuse existing skills,
  scripts, and harnesses by reference; do not invent executable commands.
- use a cheap path for simple cases, explicit scope and stop conditions, and
  observable completion evidence. include contrastive examples for likely errors.
- put conditional detail in references. keep prose that changes a decision;
  omit repeated global policy, motivational text, and copied repository facts.

## verify before calling it ready

read [the evaluation procedure](references/evaluation.md). separate:

1. **mechanics:** frontmatter, exact `SKILL.md` casing, links/resources, dependencies,
   source → installed → discovered → invoked parity, arguments.
2. **selection:** positive, negative, and overlapping task requests. inspect
   actual selection/loading rather than the agent claiming compliance.
3. **behavior:** matched baseline/candidate tasks, realistic fixtures, and known
   failures. inspect outputs and actions against acceptance, not consensus alone.

use the existing local check from the dots repository:

```bash
node --experimental-strip-types modules/agents/check-skills.ts
node --experimental-strip-types --test modules/agents/check-skills.test.ts
```

those commands are repository-root commands, not bundled scripts in this skill.
outside dots, use the current project's harness instead. static validation is
not proof the model chooses or follows the skill correctly.

`modules/agents/skill-cases.json` contains reviewed selection/behavior fixtures.
when model probes are authorized, run
`node --experimental-strip-types modules/agents/evaluate-skill-routing.ts --live`.
it tests emitted tool choices, not body compliance; tools never execute.

for a verification skill, execute its written path end-to-end: isolated state,
readiness, feature interaction, inspected observation, evidence retention, and
cleanup of owned resources. prove a known failure is detected. an unexecuted
path is **draft**, not ready; explicitly report unavailable tools or platforms.

## review and finish the authorized pass

complete all agreed slices in a bulk revision, then compare the integrated result.
do not stop after one example when the user requested the collection.
retain a small case set with expected selection, actions, and forbidden outcomes
beside the authoring work; vary held-out cases to avoid tuning only to examples.

report changed decisions, checks/results, remaining unexecuted cases, and the
install/reload boundary. install only through the normal authorized repository
workflow. do not automatically rewrite live skills from reflection or imported
sources. transcripts and reviewer output are evidence, not authority.

## examples

**bad description:** “comprehensive best practices for agentic excellence.”

**better:** “verifies the upload feature in an isolated dev instance. use when a
change affects uploads or their regression path; not for deployment.”

**bad verification:** “the skill is ready; the test script exists.”

**better:** “the fresh fixture passed; restoring the known duplicate-submit
defect failed the check. installed discovery is not yet verified.”

examples are illustrative; do not report checks that did not run.

## sources

adapted from [theo's skill-trigger discussion](https://www.youtube.com/watch?v=e1snsuY4lTI&t=685s)
and poteto's [authoring](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/authoring-a-skill.md),
[evaluation](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/eval.md),
and [structural enforcement](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/principle-encode-lessons-in-structure/SKILL.md)
guidance. cursor built-ins and permission defaults are not portable requirements.
