---
name: git-ship
description: stage all changes, commit with conventional commits format, and push to remote
---
# git-ship

execute this deterministically without extensive analysis.

## workflow

1. run `git add -A && git status` to stage and review changes
2. analyze the diff with `git diff --staged` to understand what changed
3. generate a commit message following conventional commits:
   - format: `type(scope): description`
   - types: feat, fix, docs, style, refactor, perf, test, chore
   - lowercase, imperative mood
   - if multiple logical changes, use bullet points in body
4. run `git commit -m "..."` with the generated message
5. run `git push`

## commit message examples

simple:
```
feat(auth): add jwt token refresh endpoint
```

with body:
```
feat(console): add UI source viewer for components

- import source files at build time via import.meta.glob
- parse source into JSDoc and code blocks
- add 'UI Source' section to design sidebar
```
