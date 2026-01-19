---
name: git-ship
description: "stage, commit (conventional), push. use when shipping changes, committing work, or pushing to remote. never force push, never git add -A."
---
# git-ship

stage YOUR changes only, commit with conventional commits, push.

## workflow

```bash
git status                          # check what's changed
git add <files-you-modified>        # stage only YOUR changes
git diff --staged                   # verify staged changes
git commit -m "type(scope): description"
git push
```

## rules

- stage files explicitly, never `git add -A` (other unstaged changes may exist)
- if unsure which changes are yours, ask the user
- NEVER force push (`--force`, `-f`, `--force-with-lease`)
- if push fails due to divergence, rebase and retry:
  ```bash
  git fetch origin && git rebase origin/main && git push
  ```

## commit format

`type(scope): description`

types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore`

lowercase, imperative mood. bullet points in body for multiple changes.
