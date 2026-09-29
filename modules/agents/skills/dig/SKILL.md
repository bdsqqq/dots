---
name: dig
description: "Investigate uncertain incidents, root causes, or architecture questions requiring multi-step tracing across evidence. Use when competing explanations or dependency boundaries matter, not for a known file/symbol lookup or a single factual query."
---

# dig

resolve a bounded question, not an entire codebase. investigation is read-only
unless the user authorizes changes. a request for a path to a solution is not
permission to implement it. no mandatory companion skill or delegation.

## start small

1. name the symptom/question, affected users or boundary, and what answer would
   let the user act. record material uncertainty and a stopping condition.
2. pick the nearest evidence: an entry point, failing check, log event, or caller.
   state one or two plausible explanations and what would disprove each.
3. trace directly until the question is answered or a concrete gap requires
   expansion. follow dependencies forward for mechanism, callers backward for
   reach; do both only when needed.
4. use safe existing probes or in-memory extraction where useful. writing a
   script, changing a fixture, restarting a service, or running a stateful probe
   requires the corresponding authorization. read-only intent alone does not
   make a command read-only.

check history when a behavior's origin or rationale matters, not on every lookup:
`git blame`, `git log -p --follow -- <path>`, and targeted commit searches can
explain changes, but historical intent does not prove current behavior.

## expand only for independent breadth

delegate when distinct surfaces can be investigated independently or adversarial
checking materially reduces risk. partition non-overlapping scopes; do not assign
every agent the same broad question or create an agent for each claim.

a useful brief is small but evidence-bearing:

```text
goal: determine whether retry scheduling can duplicate an accepted job
scope: scheduler and its tests; read-only; exclude worker execution (owned elsewhere)
starting evidence: scheduler.ts:80-110 and the supplied duplicate-job log
acceptance: trace enqueue/ack ordering; return citations and conditions, not guesses
verification: seek a guard or ordering guarantee that refutes duplication
stop: answer found, scope/permission boundary, missing evidence, or budget reached
budget: 10 minutes; at most two failed follow-up attempts before reporting
return: conclusion, counterevidence, checks actually run, uncertainty, next decision
```

adapt the budget to the task before dispatch. delegates may request missing
context, not silently widen scope. the primary investigator integrates results,
resolves disagreement against source, and owns the final answer.

## verify selectively and stop

verify consequential or disputed claims against code, logs, or safe observations.
independent rechecking is useful when a wrong conclusion changes the next action;
it is not a mandatory second pass over every statement.

- distinguish traced facts, hypotheses, and questions; retain source locations.
- actively look for a guard, alternate path, or observation that contradicts the
  explanation. agreement among agents does not replace that check.
- when evidence conflicts, inspect the shared boundary rather than vote.
- default to at most two failed follow-ups using the same approach, then change
  the approach within scope or report the blocker. stop earlier on a permission
  boundary, worsening evidence, or exhausted budget. do not reset the budget by
  delegating; agree on a larger budget before exceeding it.

stop when the bounded question is answered; do not turn diagnosis into an
unauthorized repair, commit, publication, or external backlog update.

## return what enables a decision

lead with the answer and confidence, then the evidence chain and counterevidence.
include unresolved questions, checks run/not run, and the next decision if blocked.
size the output to the investigation; no required report skeleton or appendix.

an optional relationship sketch can make a boundary clearer than prose:

```text
request → enqueue → ack
             └── retry timer → enqueue again?
```

label uncertain edges; use a table or mermaid diagram only when it helps explain
the evidence, not to make a small lookup look like an investigation.

## sources and worked investigations

the bounded brief draws on [poteto's orchestration playbook](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/orchestrate.md#L38-L56).
the distinction between investigation and implementation is illustrated by
[theo's investigation prompt](https://www.youtube.com/watch?v=q1D90-uGvBg&t=394s).
the two-attempt default is a local stopping rule, not a measured optimum from
those sources.

- [multi-dataset assumption mapping](references/AXM-10608-investigation-report.md)
- [rc-menu dependency discovery](references/2025-10-22T21-50-process-summary.md)

these are examples, not prerequisites or mandatory output formats.
