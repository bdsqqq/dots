---
name: git-worktree
description: create a new git worktree with a branch and switch to it
---
# git-worktree

execute this deterministically without extensive analysis.

## workflow

1. ask for the worktree/branch name if not provided
2. determine the worktree path: `../<name>` (sibling to current repo)
3. run `git worktree add ../<name> -b <name>`
4. confirm the worktree was created with `git worktree list`
5. tell the user to `cd ../<name>` to switch (or open in their editor)

## example

user says: "create a worktree for feature-auth"

```bash
git worktree add ../feature-auth -b feature-auth
git worktree list
```

then tell user: `cd ../feature-auth` or open that directory in their editor.
