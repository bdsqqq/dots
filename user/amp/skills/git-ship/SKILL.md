---
name: git-ship
description: stage, commit (conventional), push
---
# git-ship

stage all changes, commit with conventional commits, push.

## workflow

```bash
git add -A && git status
git diff --staged
git commit -m "type(scope): description"
git push
```

## NEVER force push

do NOT use `--force`, `--force-with-lease`, or `-f`.

if you need to fix a commit after pushing:
- pull --rebase first
- create a fixup commit instead
- ask the user before any history rewrite

if push fails due to divergence, rebase on origin/main and retry.

## commit format

`type(scope): description`

types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore`

lowercase, imperative mood. bullet points in body for multiple changes.

## examples

```
feat(auth): add jwt refresh endpoint
```

```
feat(console): add source viewer

- import source via import.meta.glob
- parse into jsdoc and code blocks
- add source section to sidebar
```
