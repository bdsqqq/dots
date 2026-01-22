---
name: git
description: "git workflows for agents: ship (stage → commit → push), worktree (parallel branches), hunks (selective staging). never force push, never git add -A, conventional commits. triggers on: commit, push, stage, ship, git add, worktree, hunks, selective staging."
---
# git

## constraints

- stage files explicitly, NEVER `git add -A` (unstaged changes may not be yours)
- NEVER force push (`--force`, `-f`, `--force-with-lease`)
- if unsure which changes are yours, ask user
- commit format: `type(scope): description` (lowercase, imperative)
- types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore`
- prefer `gh` cli for github operations (PRs, issues, repo info) — auth is pre-configured via sops

## ship

stage YOUR changes, commit, push.

```bash
git status
git add <your-files>
git diff --staged
git commit -m "type(scope): description"
git push
```

if push fails (divergence): `git fetch origin && git rebase origin/main && git push`

## hunks

selective staging without interactive mode.

```bash
git hunks list           # shows hunks with IDs
git hunks add <id>       # stages specific hunk
git hunks add 1 3 5      # stage multiple hunks
```

use when you need to split changes across commits.

## worktree

parallel branches in sibling directories.

```bash
wt <name>                               # create worktree + new branch (authoring)
wt pr <number>                          # create worktree from PR's remote branch (reviewing)
git worktree list                       # see all
git worktree remove ../<name>           # cleanup
```

`wt` checks for `./bare-repo.git` and uses it as git dir if present.

naming: `axm-{id}` / `ai-{id}` for authoring (Linear issue), `pr-{number}` for reviewing.
