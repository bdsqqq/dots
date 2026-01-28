#!/usr/bin/env zsh
# git worktree helper for bare repo workflow
# naming: pr-{number} for reviews, axm-{number}/ai-{number} for own work (Linear issue ID)

local git_dir="."
if [[ -d "./bare-repo.git" ]]; then
  git_dir="./bare-repo.git"
else
  echo "⚠ No bare-repo.git found, using current dir"
fi

# handle 'wt pr-6857' as alias for 'wt pr 6857'
if [[ "$1" =~ ^pr-([0-9]+)$ ]]; then
  set -- "pr" "${match[1]}"
fi

if [[ "$1" == "pr" ]]; then
  local pr_num="$2"
  if [[ -z "$pr_num" ]]; then
    echo "usage: wt pr <number>"
    exit 1
  fi
  local branch=$(GIT_DIR="$git_dir" @gh@ pr view "$pr_num" --json headRefName -q .headRefName)
  if [[ -z "$branch" ]]; then
    echo "failed to get branch for PR #$pr_num"
    exit 1
  fi
  git -C "$git_dir" fetch origin "$branch"
  if git -C "$git_dir" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$git_dir" worktree add "../pr-$pr_num" "$branch"
  else
    git -C "$git_dir" worktree add --track -b "$branch" "../pr-$pr_num" "origin/$branch"
  fi
  echo "created worktree for PR #$pr_num at ../pr-$pr_num (branch: $branch)"
elif [[ -z "$1" ]]; then
  echo "usage: wt <branch-name> | wt pr <number>"
  exit 1
else
  local name="${(L)1}"
  git -C "$git_dir" worktree add "../$name" -b "$name" origin/main
fi
