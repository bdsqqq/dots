---
name: spawn
description: spawn parallel amp agents in tmux with thread linkage
---
# spawn

spawn amp agents in tmux windows. establishes parent/child thread relationship visible in `amp threads map`.

## auto-naming

amp windows get auto-assigned fairy names like `ted_glimmermoss` or `alice_fluttergold`. the `scripts/spawn-amp` script handles this automatically.

## spawn

```bash
scripts/spawn-amp "<task description>"
```

the script:
- generates a fairy name from `assets/`
- creates a detached tmux window (doesn't steal focus)
- links to parent thread via `$AMP_CURRENT_THREAD_ID`
- includes callback instructions with `$TMUX_PANE`
- echoes the agent's name so you can reference it

## spawn multiple

```bash
AGENT1=$(scripts/spawn-amp "task 1") && AGENT2=$(scripts/spawn-amp "task 2")
```

## control

```bash
tmux select-window -t "ted_glimmermoss"         # switch to
tmux capture-pane -p -t "ted_glimmermoss"       # check output
tmux kill-window -t "ted_glimmermoss"           # stop
```

## list agents

```bash
tmux list-windows -F '#W'
```

## claude (no thread linkage)

```bash
tmux new-window -d -n "name" "echo '<task>' | claude --dangerously-skip-permissions"
```

## guidelines

- one task per agent — keep threads focused
- when spawning successors or coordinated agents, explicitly mention relevant skill names in the handoff prompt (e.g., "load the coordinate skill", "use the tmux skill") so the agent knows to load them

## handoff example

when your context is filling up (check "╭─##% of ###k" in tmux capture), spawn a successor:

```bash
scripts/spawn-amp "HANDOFF: <context summary>. Load the coordinate skill for multi-agent work."
```

## multi-agent coordination

for orchestrating multiple agents with bidirectional communication, use the `coordinate` skill.
