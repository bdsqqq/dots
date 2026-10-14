---
name: linear
description: interact with Linear via lnr CLI
---
# lnr

CLI for Linear. query and mutate issues, projects, cycles, docs, labels, views, and more.

## grammar

commands follow a consistent pattern:

- `lnr <entities>` — list (plural). filter with `--team`, `--state`, `--assignee`, etc.
- `lnr <entity> <id>` — show one. add mutation flags to update: `--state "Done"`, `--assignee @me`
- `lnr <entity> new` — create. required flags vary by entity (usually `--team`, `--title`).
- `--archive` or `--delete` — remove. flag name varies by entity.
- `--json` — structured output. `--quiet` — ids only. both work on all commands.

operation is inferred from context: no flags → read, mutation flags → update, `new` → create.

## issues

```bash
lnr issues --team ENG --assignee @me --state "In Progress"
lnr issue ENG-123                           # show
lnr issue ENG-123 --state "Done"            # update
lnr issue ENG-123 --comment "fixed in abc"  # comment
lnr issue ENG-123 --label +bug              # add label (- to remove)
lnr issue ENG-123 --branch                  # git branch name
lnr issue ENG-123 --blocks ENG-456          # relation
lnr issue new --team ENG --title "title"    # create
lnr issue batch ENG-1,ENG-2 --state "Done"  # batch update
lnr search "query" --team ENG               # full-text search
```

## projects

```bash
lnr projects --team ENG --status started
lnr project "Name" --issues                          # list project issues
lnr project milestone new --project "Name" --name "v1"  # create milestone
```

## entities

**crud:** cycles (c) · views (v) · docs · issues (i) — subcommands: batch · projects (p) — subcommands: milestone · labels · notifications (n) · initiatives (init) · git-automations (ga) · git-branches (gb)
**read-only:** templates · teams (t) · users (u) · roadmaps (rm) · agent-sessions (as)

`me` — current user info (`--issues`, `--created`, `--activity`). `search` (s) — full-text issue search. `auth` — authenticate (`--whoami`, `--logout`). `config get|set|list` — manage settings.

## rules

- `--team` required for team-scoped entities (cycles, git-automations). inferred from config default when set.
- issue IDs: `TEAM-####` (e.g., ENG-123). state names are case-sensitive Linear strings ("In Progress", "Done").
- `@me` resolves to the authenticated user for `--assignee` and `--lead`.
- `--label +name` adds, `--label -name` removes.
- `--subscribe` / `--unsubscribe` for notification control on issues, projects, initiatives.
