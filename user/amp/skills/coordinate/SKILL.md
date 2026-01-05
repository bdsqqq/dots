---
name: coordinate
description: orchestrate multiple amp agents with bidirectional tmux communication
---
# coordinate

orchestrate multiple amp agents. you are the coordinator — agents report to you, you delegate and unblock.

## spawn

use the `spawn` skill:

```bash
AGENT=$(~/.config/amp/skills/spawn/scripts/spawn-amp "<task>")
```

## messaging

agent → coordinator (via pane id from spawn instructions):
```bash
tmux send-keys -t %5 'AGENT $NAME: <message>' C-m
```

coordinator → agent (queued, non-interruptive):
```bash
tmux send-keys -t $AGENT "/queue" C-m
sleep 3  # /queue UI takes time to render
tmux send-keys -t $AGENT "COORDINATOR: <instruction>" C-m
```

coordinator → agent (interrupt, use sparingly):
```bash
tmux send-keys -t $AGENT "COORDINATOR: STOP - <urgent correction>" C-m
```

## monitoring

```bash
tmux capture-pane -p -t $AGENT | tail -30
```

ALWAYS capture before any disruptive action (messaging, killing). never act blind.

## control

```bash
tmux list-windows -F '#W'    # list agents
tmux kill-window -t $AGENT   # cleanup (observe first)
```

## pitfalls

- `/queue` opens a UI that takes 2-3s to render. sleep before sending keys or message gets cut off
- permission prompts require arrow keys + enter. ask user to handle manually
- agents can't run sudo with password. have user run, then verify
- `send-keys -t name` targets window name (agents), `-t %4` targets pane id (coordinator callback)
