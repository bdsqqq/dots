---
name: spawn
description: spawn parallel amp agents in tmux with thread linkage
---
# spawn

spawn amp agents in tmux windows. establishes parent/child thread relationship visible in `amp threads map`.

## auto-naming

amp windows get auto-assigned fairy names like `ted_glimmermoss` or `alice_fluttergold`. you don't need to specify names unless you want something specific.

## thread linkage

```bash
$AMP_CURRENT_THREAD_ID  # current thread id (T-xxx...)
```

include thread reference in first message to establish relationship.

## spawn (auto-named)

```bash
TASK="<task>. If you need guidance, run: tmux send-keys -t $TMUX_PANE 'AGENT \$(tmux display-message -p \"#W\"): <message>' C-m" && \
  tmux new-window "amp --dangerously-allow-all" && sleep 3 && \
  tmux send-keys "Continuing from https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID. $TASK" C-m
```

the agent will identify itself by its auto-assigned name when messaging back.

**note**: use `--dangerously-allow-all` to skip permission prompts. without it, agents get stuck on permission dialogs you can't easily approve.

## spawn (named)

use when you need a specific, memorable name:

```bash
TASK="<task>" NAME="<window-name>" && \
  tmux new-window -n "$NAME" "amp --dangerously-allow-all" && sleep 3 && \
  tmux send-keys -t "$NAME" "Continuing from https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID. $TASK. If you need guidance, run: tmux send-keys -t $TMUX_PANE 'AGENT $NAME: <message>' C-m" C-m
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
tmux new-window -n "name" "claude --dangerously-skip-permissions" && sleep 2 && \
  tmux send-keys -t "name" "<task>" C-m
```

## guidelines

- one task per agent — keep threads focused
- sleep 3+ seconds before sending keys (amp needs time to initialize)
- when spawning successors or coordinated agents, explicitly mention relevant skill names in the handoff prompt (e.g., "load the coordinate skill", "use the tmux skill") so the agent knows to load them
- use explicit names only when coordinating many agents and you need memorable identifiers

## handoff example

when your context is filling up (check "╭─##% of ###k" in tmux capture), spawn a successor:

```bash
TASK="HANDOFF: <context summary>. Load the coordinate skill for multi-agent work." && \
  tmux new-window "amp --dangerously-allow-all" && sleep 3 && \
  tmux send-keys "Continuing from https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID. $TASK" C-m
```

## multi-agent coordination

for orchestrating multiple agents with bidirectional communication, use the `coordinate` skill.
