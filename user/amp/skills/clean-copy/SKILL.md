---
name: clean-copy
description: reimplement current branch with clean, narrative-quality git commit history
---
# clean-copy

reimplement the current branch on a new branch with clean, narrative-quality commit history.

**branch name**: use `$ARGUMENTS` if provided, else `{source}-clean`

## steps

1. **validate**: current branch has no uncommitted changes, no conflicts, up to date with `main`

2. **analyze**: study the diff against `main`. understand the final state.

3. **branch**: `git checkout -b <new-branch> main`

4. **plan**: break changes into logical commits — like writing a tutorial.

5. **reimplement**: recreate changes commit by commit. each commit:
   - one coherent idea
   - clear message (conventional commits)
   - `--no-verify` only if necessary

6. **verify**: final state must match source branch exactly.

7. **pr**: create PR to `main`, link to original branch.

## rules

- never add yourself as author/contributor
- never include ai attribution in commits
- individual commits don't need to pass tests, but final state must
