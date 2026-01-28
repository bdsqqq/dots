#!/usr/bin/env zsh
# lazygit with bare-repo detection

if [[ -d "./bare-repo.git" ]]; then
  if [[ -d "./main" ]]; then
    exec @lazygit@ -g ./bare-repo.git -w ./main "$@"
  else
    local first_wt=$(find . -maxdepth 1 -type d ! -name '.' ! -name 'bare-repo.git' | head -1)
    if [[ -n "$first_wt" ]]; then
      exec @lazygit@ -g ./bare-repo.git -w "$first_wt" "$@"
    else
      echo "no worktree found. create one with: wt <name>"
      exit 1
    fi
  fi
else
  exec @lazygit@ "$@"
fi
