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

always include the callback pattern in spawn message. use `$TMUX_PANE` to capture your pane id dynamically:

```bash
TASK="<task description>. If you need guidance, run: tmux send-keys -t $TMUX_PANE 'AGENT <name>: <message>' C-m" \
NAME="<agent-name>" && \
  tmux new-window -n "$NAME" "amp" && sleep 2 && \
  tmux send-keys -t "$NAME" "Continuing from https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID. $TASK" C-m
```

**note**: `$TMUX_PANE` is set by tmux automatically (e.g., `%5`). it's stable across window reordering.

## agent-to-coordinator messages

agents send messages TO you via the pane id provided in their spawn instructions:

```bash
tmux send-keys -t %5 'AGENT debug-foo: <status or question>' C-m
```

these appear in YOUR amp session as user messages prefixed with "AGENT <name>:".

## coordinator-to-agent messages

### polite (queued) — preferred
use `/queue` to avoid interrupting agent mid-step:

```bash
tmux send-keys -t debug-foo "/queue" C-m
sleep 3  # IMPORTANT: /queue opens a UI that takes time to render
tmux send-keys -t debug-foo "COORDINATOR: <instruction>" C-m
```

agent will receive message after completing current step.

**note**: `/` commands in amp open a UI palette that takes 2-3 seconds to render. if you send keys too quickly, the message gets cut off or the UI blocks input. always sleep 3+ seconds after `/queue`.

### interrupt — use sparingly
only interrupt when agent is deviating from correct approach:

```bash
tmux send-keys -t debug-foo "COORDINATOR: STOP - <urgent correction>" C-m
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

permission prompts and other amp UI selections (command palette, etc.) require arrow keys + enter to navigate. capture-pane can't see selection state (no colors), so **ask the user to handle these manually**.

## observe before acting

**ALWAYS capture pane state before ANY disruptive action** — sending messages, interrupting, killing, etc. never act blind.

```bash
tmux capture-pane -p -t agent-name | tail -30
```

this prevents:
- killing agents mid-task
- sending messages that get lost in UI palettes
- interrupting agents that are about to finish

## cleanup

observe first, then kill:

```bash
# 1. observe FIRST — never skip this
tmux capture-pane -p -t debug-foo | tail -30

# 2. only kill after confirming agent is done or stuck
tmux kill-window -t debug-foo
```

for multiple agents:

```bash
# observe all before any cleanup
for w in debug-foo debug-bar; do
  echo "=== $w ===" && tmux capture-pane -p -t "$w" | tail -20
done

# then kill after review
tmux kill-window -t debug-foo
tmux kill-window -t debug-bar
```

## pitfalls

### naming windows
always name tmux windows descriptively — easier than indexes:

```bash
tmux new-window -n "debug-auth"    # good: descriptive
tmux new-window -n "agent-2"       # bad: meaningless
```

use `tmux rename-window -t 2 "debug-auth"` to fix existing windows.

### agent pane targeting
- `tmux send-keys -t debug-foo` targets by window name (preferred for agents)
- `tmux send-keys -t %4` targets by pane id (preferred for coordinator callback)
- `tmux send-keys -t 1.1` targets window 1, pane 1 (fragile — avoid)

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

## communication etiquette

### as coordinator
- use `/queue` for non-urgent messages (polite)
- interrupt only when agent is going wrong direction
- your job: ensure agents complete the overall task

### as worker agent
- message coordinator, NOT peer agents directly
- use callback pattern: `tmux send-keys -t coordinator-window 'AGENT name: msg' C-m`
- let coordinator relay info between agents if needed

## workflow example

1. user asks to debug issue across 2 hosts
2. spawn debug-host-a and debug-host-b with callback instructions
3. set timer to check on them: `sleep 30 && tmux capture-pane ...`
4. when agent messages arrive ("AGENT debug-host-a: found X"), queue response via `/queue`
5. coordinate between agents — relay findings, don't have them message each other
6. once tasks complete, cleanup windows
