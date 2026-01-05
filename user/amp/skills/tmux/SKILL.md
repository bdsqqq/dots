---
name: tmux
description: manage background processes in tmux windows
---
# tmux

manage concurrent processes (servers, builds, watchers) in tmux windows.

## spawn

```bash
tmux new-window -n "name" -d "command"
```

## inspect

```bash
tmux capture-pane -p -t "name"         # visible screen
tmux capture-pane -p -S - -t "name"    # full scrollback
```

## control

```bash
tmux send-keys -t "name" C-c           # interrupt
tmux kill-window -t "name"             # terminate
tmux select-window -t "name"           # switch to
tmux list-windows                      # list all
```

for spawning amp agents with thread linkage, use the `spawn` skill.
