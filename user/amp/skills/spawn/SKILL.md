---
name: spawn
description: spawn parallel amp agents in tmux with thread linkage
---
# spawn

spawn amp agents in tmux windows. establishes parent/child thread relationship visible in `amp threads map`.

## thread linkage

```bash
$AMP_CURRENT_THREAD_ID  # current thread id (T-xxx...)
```

include thread reference in first message to establish relationship.

## one-liner (scriptable)

```bash
TASK="<task>" NAME="<window-name>" && \
  tmux new-window -n "$NAME" "amp --dangerously-allow-all" && sleep 3 && \
  tmux send-keys -t "$NAME" "Continuing from https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID. $TASK" C-m
```

**note**: use `--dangerously-allow-all` to skip permission prompts. without it, agents get stuck on permission dialogs you can't easily approve.

## hotkey binding

add to shell rc or bind to key:

```bash
amp-spawn() {
  local name="${1:-agent}" task="${2:-}"
  tmux new-window -n "$name" "amp --dangerously-allow-all" && sleep 3 && \
    tmux send-keys -t "$name" "Continuing from https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID. $task" C-m
}
```

usage: `amp-spawn fix-lint "fix all eslint errors in src/"`

## control

```bash
tmux select-window -t "name"         # switch to
tmux capture-pane -p -t "name"       # check output
tmux kill-window -t "name"           # stop
```

## claude (no thread linkage)

```bash
tmux new-window -n "name" "claude --dangerously-skip-permissions" && sleep 2 && \
  tmux send-keys -t "name" "<task>" C-m
```

## guidelines

- sanitize window names: lowercase, dashes, no spaces/special chars
- keep names short (max 30 chars)
- one task per agent — keep threads focused
- sleep 3+ seconds before sending keys (amp needs time to initialize)
- when spawning successors or coordinated agents, explicitly mention relevant skill names in the handoff prompt (e.g., "load the coordinate skill", "use the tmux skill") so the agent knows to load them

### naming successors
NEVER use "-finish", "-final", "-complete", "-done" — you don't know how many iterations it will take. use incremental numbering:
- `rustdesk-2`, `rustdesk-3`, etc.
- or task-phase names: `rustdesk-verify`, `rustdesk-cleanup`

## handoff example

when your context is filling up (check "╭─##% of ###k" in tmux capture), spawn a successor with explicit skill references:

```bash
TASK="HANDOFF: <context summary>. Load the coordinate skill for multi-agent work. Load the tmux skill for background processes." \
NAME="successor" && \
  tmux new-window -n "$NAME" "amp --dangerously-allow-all" && sleep 3 && \
  tmux send-keys -t "$NAME" "Continuing from https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID. $TASK" C-m
```

## multi-agent coordination

for orchestrating multiple agents with bidirectional communication, use the `coordinate` skill.
