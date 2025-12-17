---
name: spawn-servant
description: Spawn a serving coding agent in a tmux window when the user says "Run an agent", "Spawn an agent", or similar
---
# Spawn Servant Skill

> source: https://gist.github.com/dhamidi/55155637c6b6e2c93d427c291a7ba49b

Use this skill to spawn a parallel subagent in a new tmux window.

## Valid Subagents

- **Amp**: `amp`
- **Claude**: `claude --dangerously-skip-permissions`

## Workflow

Chain tmux commands in a single invocation using tmux's `;` command separator:

```bash
tmux new-window -n "task-title" "<subagent-command>" \; \
  send-keys -t "task-title" "Your task instructions here" C-m
```

Or on a single line:

```bash
tmux new-window -n "task-title" "<subagent-command>" \; send-keys -t "task-title" "Your task instructions here" C-m
```

**How it works:**

1. `new-window -n "task-title" "<subagent-command>"` - Creates a new tmux window and starts the subagent
2. `\;` - tmux command separator (escaped semicolon) for chaining in the same invocation
3. `send-keys -t "task-title" "text" C-m` - Immediately sends the task message followed by Enter (C-m)

**Important:** A `sleep 3` is necessary between starting the new window and sending keys to allow the subagent to initialize. This can be done in one Bash tool invocation:

```bash
tmux new-window -n "task-title" "<subagent-command>" && sleep 3 && tmux send-keys -t "task-title" "Your task instructions here" C-m
```

The subagent runs independently in the background and will return a summary when complete.

## Example

To spawn an Amp subagent that fixes lint errors:

```bash
tmux new-window -n "fix-lint" "amp" \; send-keys -t "fix-lint" "Fix all ESLint errors in src/" C-m
```

## Guidelines

- Sanitize window titles: replace spaces with dashes, remove special characters
- Keep window titles short and descriptive (max 30 characters)
- Chain tmux commands with `\;` (escaped semicolon) to send commands in a single invocation
- Use `tmux kill-window -t "window-name"` to stop a subagent if needed
- The spawned subagent runs independently in the background
