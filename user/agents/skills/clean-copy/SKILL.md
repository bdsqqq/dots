---
name: clean-copy
description: "reimplement current branch with clean, narrative-quality git commit history. use when commit history is messy, after exploratory work, or before PR review. creates new branch with logical, atomic commits."
---
# clean-copy

reimplement the current branch on a new branch with clean, narrative-quality commit history.

**branch name**: `$ARGUMENTS` if provided, else `{source}-clean`

## workflow

1. validate: no uncommitted changes, no conflicts, up to date with `main`
2. analyze: study diff against `main`, understand final state
3. branch: `git checkout -b <new-branch> main`
4. plan: break changes into logical commits — like writing a tutorial
5. reimplement: recreate changes commit by commit (one coherent idea per commit, conventional commits, `--no-verify` only if necessary)
6. verify: final state must match source branch exactly
7. pr: create PR to `main`, link to original branch

## example commit sequence

source branch has 47 messy commits adding auth. clean-copy might produce:

```
feat(auth): add user model and migration
feat(auth): implement JWT token generation
feat(auth): add login/logout endpoints
feat(auth): protect routes with auth middleware
test(auth): add auth flow integration tests
docs(auth): update API documentation
```

6 commits that tell a story vs 47 that document confusion.

## rules

- never add yourself as author/contributor
- never include ai attribution in commits
- individual commits don't need to pass tests, but final state must
