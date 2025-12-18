---
name: tmux
description: manage background processes in tmux windows
allowed-tools:
  - Bash
---
# tmux

manage concurrent processes (servers, builds, watchers) in tmux windows.

## verify

```bash
echo $TMUX        # non-empty if inside tmux
tmux list-windows # show current windows
```

## spawn a process

```bash
tmux new-window -n "name" -d
tmux send-keys -t "name" "command" C-m
```

or combined:

```bash
tmux new-window -n "name" -d ';' send-keys -t "name" "command" C-m
```

## inspect output

```bash
tmux capture-pane -p -t "name"         # visible screen
tmux capture-pane -p -S - -t "name"    # full scrollback
```

## control

```bash
tmux send-keys -t "name" C-c           # interrupt (ctrl+c)
tmux kill-window -t "name"             # terminate
tmux select-window -t "name"           # switch to
```

## agent spawning

for spawning amp/claude agents with thread linkage, use the `spawn` skill.
