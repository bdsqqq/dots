---
name: coordinate
description: orchestrate multiple amp agents with bidirectional tmux communication
---
# coordinate

orchestrate multiple amp agents working on related tasks. you are the coordinator — agents report to you, you delegate and unblock them.

## architecture

```
coordinator (you)          agents (spawned)
     │                          │
     ├──spawn──────────────────►│ debug-foo
     ├──spawn──────────────────►│ debug-bar  
     │                          │
     │◄────tmux send-keys───────┤ "AGENT debug-foo: found issue X"
     ├─────tmux send-keys──────►│ "COORDINATOR: fix X, then do Y"
     │                          │
     └──monitor via capture─────┘
```

## spawn agents with callback instructions

always include the callback pattern in spawn message:

```bash
TASK="<task description>. If you need guidance, run: tmux send-keys -t 1.1 'AGENT <name>: <message>' C-m" \
NAME="<agent-name>" && \
  tmux new-window -n "$NAME" "amp" && sleep 2 && \
  tmux send-keys -t "$NAME" "Continuing from https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID. $TASK" C-m
```

## agent-to-coordinator messages

agents send messages TO you via:

```bash
tmux send-keys -t 1.1 'AGENT debug-foo: <status or question>' C-m
```

these appear in YOUR amp session as user messages prefixed with "AGENT <name>:".

## coordinator-to-agent messages

send instructions TO agents via:

```bash
tmux send-keys -t debug-foo "COORDINATOR: <instruction>" C-m
```

## monitoring pattern

check agent progress periodically:

```bash
sleep 5 && tmux capture-pane -p -t debug-foo | tail -30
```

check all agents:

```bash
for w in debug-foo debug-bar; do
  echo "=== $w ===" && tmux capture-pane -p -t "$w" | tail -20
done
```

## handling permission prompts

if agent is stuck on permission prompt, send approval:

```bash
tmux send-keys -t debug-foo "y" C-m
# or for session-wide:
tmux send-keys -t debug-foo "Allow All for This Session" C-m
```

## cleanup

```bash
tmux kill-window -t debug-foo
tmux kill-window -t debug-bar
```

## pitfalls

### agent pane targeting
- `tmux send-keys -t 1.1` targets window 1, pane 1 (coordinator)
- `tmux send-keys -t debug-foo` targets by window name
- `tmux send-keys -t %4` targets by pane id (use `tmux list-panes` to find)

### sudo/tty issues
agents cannot run sudo commands requiring password. instruct user to run those manually, then have agent verify results.

### agents need sleep before send-keys
after `tmux new-window`, always `sleep 2` before sending keys — amp needs time to initialize.

### context window handoff
when your context exceeds 70%, spawn a successor in a split:

```bash
tmux split-window -h "amp" && sleep 2 && \
  tmux send-keys -t :.1 "HANDOFF: <full context summary>" C-m
```

then exit your pane after successor acknowledges.

## workflow example

1. user asks to debug issue across 2 hosts
2. spawn debug-host-a and debug-host-b with callback instructions
3. set timer to check on them: `sleep 30 && tmux capture-pane ...`
4. when agent messages arrive ("AGENT debug-host-a: found X"), respond with guidance
5. coordinate between agents if they need to share findings
6. once tasks complete, cleanup windows
