---
name: coordinate
description: orchestrate multiple amp agents with bidirectional tmux communication
---
# coordinate

orchestrate multiple amp agents working on related tasks. you are the coordinator — agents report to you, you delegate and unblock them.

## auto-naming

amp windows get auto-assigned fairy names like `ted_glimmermoss` or `alice_fluttergold`. agents identify themselves by these names when messaging you.

## architecture

```
coordinator (you)          agents (spawned)
     │                          │
     ├──spawn──────────────────►│ ted_glimmermoss
     ├──spawn──────────────────►│ alice_fluttergold  
     │                          │
     │◄────tmux send-keys───────┤ "AGENT ted_glimmermoss: found issue X"
     ├─────tmux send-keys──────►│ "COORDINATOR: fix X, then do Y"
     │                          │
     └──monitor via capture─────┘
```

## spawn agents

agents get auto-named and include their name in callbacks:

```bash
TASK="<task description>. If you need guidance, run: tmux send-keys -t $TMUX_PANE 'AGENT \$(tmux display-message -p \"#W\"): <message>' C-m" && \
  tmux new-window "amp" && sleep 2 && \
  tmux send-keys "Continuing from https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID. $TASK" C-m
```

**note**: `$TMUX_PANE` is set by tmux automatically (e.g., `%5`). it's stable across window reordering.

## list active agents

```bash
tmux list-windows -F '#W'
```

## agent-to-coordinator messages

agents send messages TO you via the pane id provided in their spawn instructions:

```bash
tmux send-keys -t %5 'AGENT ted_glimmermoss: <status or question>' C-m
```

these appear in YOUR amp session as user messages prefixed with "AGENT <name>:".

## coordinator-to-agent messages

### polite (queued) — preferred
use `/queue` to avoid interrupting agent mid-step:

```bash
tmux send-keys -t ted_glimmermoss "/queue" C-m
sleep 3  # IMPORTANT: /queue opens a UI that takes time to render
tmux send-keys -t ted_glimmermoss "COORDINATOR: <instruction>" C-m
```

agent will receive message after completing current step.

**note**: `/` commands in amp open a UI palette that takes 2-3 seconds to render. if you send keys too quickly, the message gets cut off or the UI blocks input. always sleep 3+ seconds after `/queue`.

### interrupt — use sparingly
only interrupt when agent is deviating from correct approach:

```bash
tmux send-keys -t ted_glimmermoss "COORDINATOR: STOP - <urgent correction>" C-m
```

## monitoring pattern

check agent progress periodically:

```bash
sleep 5 && tmux capture-pane -p -t ted_glimmermoss | tail -30
```

check all agents:

```bash
for w in $(tmux list-windows -F '#W' | grep -v "^$(tmux display-message -p '#W')$"); do
  echo "=== $w ===" && tmux capture-pane -p -t "$w" | tail -20
done
```

## handling permission prompts

permission prompts and other amp UI selections (command palette, etc.) require arrow keys + enter to navigate. capture-pane can't see selection state (no colors), so **ask the user to handle these manually**.

## observe before acting

**ALWAYS capture pane state before ANY disruptive action** — sending messages, interrupting, killing, etc. never act blind.

```bash
tmux capture-pane -p -t ted_glimmermoss | tail -30
```

this prevents:
- killing agents mid-task
- sending messages that get lost in UI palettes
- interrupting agents that are about to finish

## cleanup

observe first, then kill:

```bash
# 1. observe FIRST — never skip this
tmux capture-pane -p -t ted_glimmermoss | tail -30

# 2. only kill after confirming agent is done or stuck
tmux kill-window -t ted_glimmermoss
```

## pitfalls

### agent pane targeting
- `tmux send-keys -t ted_glimmermoss` targets by window name (preferred for agents)
- `tmux send-keys -t %4` targets by pane id (preferred for coordinator callback)
- `tmux send-keys -t 1.1` targets window 1, pane 1 (fragile — avoid)

### sudo/tty issues
agents cannot run sudo commands requiring password. instruct user to run those manually, then have agent verify results.

### agents need sleep before send-keys
after `tmux new-window`, always `sleep 2` before sending keys — amp needs time to initialize.

### context window handoff
when your context exceeds 70%, spawn a successor:

```bash
TASK="HANDOFF: <full context summary>" && \
  tmux new-window "amp" && sleep 2 && \
  tmux send-keys "Continuing from https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID. $TASK" C-m
```

then exit your pane after successor acknowledges.

## communication etiquette

### as coordinator
- use `/queue` for non-urgent messages (polite)
- interrupt only when agent is going wrong direction
- your job: ensure agents complete the overall task

### as worker agent
- message coordinator, NOT peer agents directly
- use callback pattern: `tmux send-keys -t $COORDINATOR_PANE 'AGENT myname: msg' C-m`
- let coordinator relay info between agents if needed

## workflow example

1. user asks to debug issue across 2 hosts
2. spawn two agents (they get names like `ted_glimmermoss`, `alice_fluttergold`)
3. list agents: `tmux list-windows -F '#W'`
4. check on them: `tmux capture-pane -p -t ted_glimmermoss | tail -30`
5. when agent messages arrive ("AGENT ted_glimmermoss: found X"), queue response via `/queue`
6. coordinate between agents — relay findings, don't have them message each other
7. once tasks complete, cleanup windows by name
