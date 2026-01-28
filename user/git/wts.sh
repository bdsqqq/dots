#!/usr/bin/env zsh
# worktree status with merge detection and clickable links

local git_dir="./bare-repo.git"
if [[ ! -d "$git_dir" ]]; then
  echo "no bare-repo.git"
  exit 1
fi

git -C "$git_dir" fetch origin main --quiet 2>/dev/null || true
local repo=$(git -C "$git_dir" remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/')

git -C "$git_dir" worktree list --porcelain | grep "^worktree " | cut -d' ' -f2 | while read wt; do
  [[ "$wt" == *"bare-repo.git" ]] && continue
  local name=$(basename "$wt")
  local head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
  
  local merged="○"
  if [[ -n "$head" ]] && git -C "$git_dir" merge-base --is-ancestor "$head" origin/main 2>/dev/null; then
    merged="✓"
  fi
  
  local pr_num=$(echo "$name" | grep -oE '^pr-[0-9]+$' | cut -d'-' -f2)
  if [[ -n "$pr_num" ]]; then
    local url="https://github.com/$repo/pull/$pr_num"
    printf '%s \e]8;;%s\e\\%s\e]8;;\e\\\n' "$merged" "$url" "$name"
    continue
  fi
  
  local issue_id=$(echo "$name" | grep -oE '^[a-zA-Z]+-[0-9]+' | tr '[:lower:]' '[:upper:]')
  if [[ -n "$issue_id" ]]; then
    local json=$(lnr issue "$issue_id" --json 2>/dev/null | tr -d '\000-\037')
    if [[ -n "$json" ]]; then
      local state=$(echo "$json" | @jq@ -r '.state // empty')
      local url=$(echo "$json" | @jq@ -r '.url // empty')
      printf '%s \e]8;;%s\e\\%s\e]8;;\e\\ (%s)\n' "$merged" "$url" "$name" "$state"
      continue
    fi
  fi
  
  echo "$merged $name"
done
