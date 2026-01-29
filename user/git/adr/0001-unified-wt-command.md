# 1. unified wt command

date: 2025-01-29

## status

accepted

## context

worktree workflow had 4 separate commands: `wt`, `wts`, `wt-init`, `wt-rm`. inconsistent naming (`wts` vs `wt-init`). `wt rm` needs to cd parent shell—scripts can't do this.

## decision

unify into single `wt` with subcommands. shell function wrapper for cd.

- `wt` (no args, no bare-repo) → print setup hint
- `wt` (no args, has bare-repo) → list worktrees + status
- `wt` (no args, in worktree) → detailed status for current
- `wt rm` (in worktree) → remove current, cd to bare root
- `wt rm <name>` → remove named, cd only if was in deleted
- `wt pr <num>` / `wt <branch>` → existing add behavior
- `wt <url>` → clone bare repo (replaces wt-init)
- `wt <url> <dir>` → clone into specific dir

implementation: `_wt` script (nix mkScript), `wt()` function in shell.nix calls it + handles cd.

url vs branch disambiguation: check for `://` or `git@`.

pr url magic: `wt https://github.com/org/repo/pull/231` extracts org/repo + pr num.
- if in matching bare repo → treat as `wt pr 231`
- if not in bare repo → clone org/repo, then add pr-231 worktree

default branch protection: `wt rm` refuses to remove the default branch worktree.
- detected via `git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||'`
- no hardcoded main/master; respects whatever origin defines

## consequences

- single command to remember
- cd works via shell function (canonical unix pattern, see z/autojump/nvm)
- `wts`, `wt-init`, `wt-rm` deprecated
