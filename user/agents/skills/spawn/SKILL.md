---
name: spawn
description: "spawn parallel amp agents in tmux with thread linkage. use for INDEPENDENT side-quests discovered during main work. NOT for spawning multiple agents to review/evaluate the same thing."
---
# spawn

spawn amp agents in tmux windows with automatic thread linkage.

## when NOT to use

before spawning, ask:

1. **is this an independent task?** spawn for side-quests (different scope). don't spawn multiple agents for the SAME task.
2. **is there a single source of truth?** if verifiable against one file/spec/query, do it yourself.
3. **will this produce conflicting findings?** spawn for parallel work on DIFFERENT sources, not opinions to reconcile.

spawn parallelizes INDEPENDENT work. don't spawn agents to produce conflicting findings you'll need to reconcile.

## why spawn?

short threads outperform long threads. see bundled references:
- [references/200k_tokens_is_plenty.md](references/200k_tokens_is_plenty.md) — why agents degrade with context bloat
- [references/amp_owners_manual.md](references/amp_owners_manual.md) — official amp prompting guidance

key insight: agents get drunk on too many tokens. spawning keeps each thread focused on ONE task with minimal context, then links via `read_thread`.

## usage

```bash
scripts/spawn-amp "<task description>"
```

creates a detached tmux window, pipes the task to amp, links to parent thread via `$AMP_CURRENT_THREAD_ID`, includes callback instructions with `$TMUX_PANE`. echoes the agent's name.

agents get auto-assigned fairy names from `assets/` (e.g., `ted_glimmermoss`).

## multiple agents

```bash
AGENT1=$(scripts/spawn-amp "task 1") && AGENT2=$(scripts/spawn-amp "task 2")
```

## control

```bash
tmux select-window -t "$AGENT1"           # switch to
tmux capture-pane -p -t "$AGENT1"         # check output
tmux kill-window -t "$AGENT1"             # stop
tmux list-windows -F '#W'                 # list all
```

## handoff

when context fills up, spawn a successor with full context:

```bash
scripts/spawn-amp "HANDOFF: <context summary>. load the coordinate skill for multi-agent work."
```

## coordination

for orchestrating multiple agents with bidirectional communication, load the `coordinate` skill.
