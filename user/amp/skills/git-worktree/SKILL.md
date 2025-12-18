---
name: git-worktree
description: create git worktree with new branch
---
# git-worktree

create a worktree as sibling directory with a new branch.

## workflow

```bash
git worktree add ../<name> -b <name>
git worktree list
```

then: `cd ../<name>` or open in editor.

## example

```bash
git worktree add ../feature-auth -b feature-auth
```
