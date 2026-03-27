---
name: coordinate
description: "spawn, monitor, and coordinate multiple amp agents via tmux for parallel work. use to run multiple tasks concurrently, track agent progress, and aggregate results across independent workstreams. NOT for review courts or generating opinions to reconcile."
---
# coordinate

orchestrate multiple amp agents. you are the coordinator — agents report to you, you delegate and unblock.

## when NOT to use

before coordinating multiple agents, ask:

1. **is there a single source of truth?** if verifiable against one file/spec/query, do it yourself.
2. **will agents produce conflicting findings?** if task is evaluative (judging claims), a single careful pass is cleaner than reconciling disagreements.
3. **do i have explicit exit criteria?** multi-agent work without convergence criteria produces unbounded reconciliation work.

coordinate is for parallelizing INDEPENDENT work. don't spawn review courts when you can read the code yourself.

## workflow

1. **spawn** agents for each independent task
2. **monitor** progress with capture-pane (always before any action)
3. **message** agents to unblock or redirect
4. **collect** results and verify completion
5. **cleanup** finished agent windows

## spawn

use the `spawn` skill:

```bash
AGENT=$(../spawn/scripts/spawn-amp "<task>")
```

## messaging

agent → coordinator (via pane id from spawn instructions):
```bash
tmux send-keys -t %5 'AGENT $NAME: <message>' C-m
```

coordinator → agent:
```bash
tmux send-keys -t $AGENT "COORDINATOR: <instruction>" C-m
```

direct send-keys is preferred. slash commands (like /queue) are unreliable over tmux — timing issues cause messages to be cut off or missed.

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

- slash commands unreliable over tmux — use direct messages instead
- permission prompts require arrow keys + enter. ask user to handle manually
- agents can't run sudo with password. have user run, then verify
- `send-keys -t name` targets window name (agents), `-t %4` targets pane id (coordinator callback)
