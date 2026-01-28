#!/usr/bin/env zsh
# initialize bare repo workflow from a remote

local repo="$1"
if [[ -z "$repo" ]]; then
  echo "usage: wt-init <repo-url>"
  exit 1
fi

git clone --bare "$repo" bare-repo.git
git -C bare-repo.git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C bare-repo.git fetch origin
git -C bare-repo.git worktree add ../main main

echo "done. bare repo at ./bare-repo.git, main worktree at ./main"
