---
name: git-worktree
description: "create git worktree with new branch. use when working on features in parallel, isolating experimental work, or avoiding stash/switch overhead. creates sibling directory."
---
# git-worktree

create a worktree as sibling directory with a new branch.

```bash
git worktree add ../<name> -b <name>
```

then `cd ../<name>` or open in editor. `git worktree list` to see all.
