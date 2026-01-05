---
name: spawn
description: spawn parallel amp agents in tmux with thread linkage
---
# spawn

spawn amp agents in tmux windows with automatic thread linkage.

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
