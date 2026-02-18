---
name: nexus-fix
description: "structured investigation-to-PR workflow for linear issues. hypothesis-driven debugging with browser validation and counterfactual proof. use when investigating a linear ticket, fixing a UI bug, or shipping a fix with evidence. triggers on: investigate issue, fix bug, nexus-fix, AXM-, linear issue."
---

# nexus-fix

structured workflow: linear ticket → code investigation → fix → browser proof → PR with evidence.

**prerequisite skills**: load each skill when entering its phase, not all upfront.

**philosophy**: don't trust the code, trust the browser. every fix needs counterfactual proof — show the bug exists without your change, show it's gone with your change. you are proving, not assuming.

## phase 0: bootstrap environment

before starting any investigation, ensure the worktree is ready to run.

### worktree setup

if working in a fresh worktree created by `wt <name>`:

1. **env files** — `wt` auto-symlinks `.env*` files from the default branch worktree. verify:
   ```bash
   ls -la apps/console/.env
   ```
   if missing, run `wt env` from inside the worktree.
   if main worktree has no `.env` either, pull from vercel:
   ```bash
   vercel link  # select Axiom scope, project "nexus"
   vercel env pull
   cp .env.local apps/console/.env
   ```

2. **install deps** — `pnpm install`

3. **planetscale auth** — credentials expire silently. if dev server throws `DatabaseError: Unauthorized`:
   ```bash
   pscale auth login
   cd apps/console && pnpm run db:switch dev
   ```
   for first-time setup: `pnpm run db:init` instead of `db:switch`.

4. **browser auth** — save a session after first manual login:
   ```bash
   # first time: login manually in headed browser
   agent-browser --headed --session-name axiom-console open http://localhost:3000
   # ... complete login flow manually ...
   agent-browser state save axiom-auth.json
   mv axiom-auth.json ~/.agent-browser/sessions/  # state save writes to cwd

   # subsequent runs: load saved state BEFORE opening browser
   agent-browser state load axiom-auth.json
   agent-browser --session-name axiom-console open http://localhost:3000
   ```
   **security**: state files contain ALL browser cookies, not just axiom. never commit them.

### dev server

start in tmux so it doesn't block:
```bash
# load tmux skill first
tmux has-session -t dev 2>/dev/null || tmux new-session -d -s dev
tmux send-keys -t dev 'cd <worktree-path> && pnpm dev' Enter
```

app: `http://localhost:3000`. org URLs: `http://localhost:3000/<orgId>/<path>`.

## phase 1: understand the issue

**load**: `linear`

```bash
lnr issue AXM-XXXXX
```

extract:
- **repro steps** — exact sequence to trigger the bug
- **expected vs actual** — what should happen vs what happens
- **affected area** — which feature, which UI surface
- **attachments** — screenshots, recordings, logs

restate the problem. identify what you don't know.

## phase 2: investigate

**load**: `dig` (loads `review` for epistemic standards)

### map the code path

1. identify seed artifacts — component, route, store, or API endpoint
2. use `finder` to trace bidirectionally:
   - **forward**: component → hook → form state → API call
   - **reverse**: API response → store → component → render
3. `git blame` / `git log` for recent changes that may have introduced the bug

### root cause

for every claim:
- **cite location**: `file:line`
- **label confidence**: `VERIFIED` | `HUNCH` | `QUESTION`
- **falsify**: what would prove this wrong? check that first.

format:
```
ROOT CAUSE [VERIFIED]
file: src/dash/components/query/editor.tsx:142
evidence: useEffect dependency array only includes `placeholder`, not `value`.
falsification: checked for alternative sync mechanisms — none found.
```

## phase 3: fix

- smallest viable change following existing patterns
- check neighboring code for prior art
- validate:
  ```bash
  pnpm agent:typecheck
  pnpm agent:lint
  ```

## phase 4: browser validation

**load**: `agent-browser`

the browser is the feedback loop. prove it works.

```bash
agent-browser state load axiom-auth.json 2>/dev/null
agent-browser --headed --session-name axiom-console open http://localhost:3000/<orgId>/<path>

# follow exact repro steps from the ticket
agent-browser snapshot -i
agent-browser click @e1
agent-browser screenshot  # capture working state
```

screenshots: `~/.agent-browser/tmp/screenshots/`

## phase 5: counterfactual proof

prove causality, not correlation.

```bash
# 1. stash the fix
git stash

# 2. wait for hot reload
sleep 3

# 3. reproduce the bug
agent-browser --session-name axiom-console open http://localhost:3000/<orgId>/<path>
# follow repro steps...
agent-browser screenshot  # BEFORE — bug visible

# 4. restore the fix
git stash pop

# 5. wait for rebuild
sleep 3

# 6. verify fix
agent-browser --session-name axiom-console open http://localhost:3000/<orgId>/<path>
# follow repro steps...
agent-browser screenshot  # AFTER — bug gone
```

## phase 6: ship

**load**: `git`, `write`, `amp-voice`

### commit

```bash
git add <changed-files>   # explicit files only
git diff --staged
git commit -m "fix(scope): description"
git push
```

### PR

use `.github/pull_request_template.md`:

```bash
gh pr create \
  --title "fix(scope): description" \
  --body "## Overview

<root cause with file:line citations>

## Showcase

### Before (bug present)
![before](screenshot-url)

### After (fix applied)
![after](screenshot-url)

## Testing

- browser validation: followed repro steps from ticket
- counterfactual proof: reverted fix → bug reproduced, re-applied → resolved
- typecheck and lint pass"
```

### screenshots in PRs

screenshots from `~/.agent-browser/tmp/screenshots/`:
- drag-drop into github PR body (github hosts them)
- or copy to tracked dir + `git add -f` if gitignored

## gotchas

- **routeTree.gen.ts** — auto-generated, globally gitignored. causes rebase hell. cherry-pick onto fresh branch instead.
- **pscale auth** — expires silently. symptom: `DatabaseError: Unauthorized`.
- **agent-browser refs** — `@e1` etc invalidate on navigation. re-snapshot after page changes.
- **port conflicts** — `PORT=<number> pnpm dev` if 3000 is taken.
- **`git add -A`** — never. concurrent agents/users may have uncommitted work.
- **`.github/` gitignored** — globally. need `git add -f` for files in `.github/pr-assets/`.

## references

- [brian lovin — give your agent a stopwatch](https://brianlovin.com/writing/give-your-agent-a-stopwatch)
- [brian lovin — give your agent a laboratory](https://brianlovin.com/writing/give-your-agent-a-laboratory)
