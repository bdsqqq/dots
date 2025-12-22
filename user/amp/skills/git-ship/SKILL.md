---
name: git-ship
description: stage, commit (conventional), push
---
# git-ship

stage YOUR changes only, commit with conventional commits, push.

## workflow

```bash
git status                          # check what's changed
git add <files-you-modified>        # stage only YOUR changes
git diff --staged                   # verify staged changes are correct
git commit -m "type(scope): description"
git push
```

## only commit your changes

there may be other unstaged changes from the user or other agents. do NOT blindly `git add -A`.

- stage files explicitly: `git add path/to/file.ts path/to/other.ts`
- use `git status` to identify which files YOU modified
- if unsure which changes are yours, ask the user

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
