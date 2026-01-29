#!/usr/bin/env zsh
# unified worktree management command
# outputs __WT_CD__:/path when caller should cd

set -euo pipefail

# --- nix substitutions ---
GH="@gh@"
JQ="@jq@"
TRASH="@trash@"

# --- context detection ---

in_worktree() {
  local git_dir
  git_dir=$(git rev-parse --git-dir 2>/dev/null) || return 1
  [[ "$git_dir" == */bare-repo.git/worktrees/* ]]
}

has_bare_repo() {
  if [[ -d "./bare-repo.git" ]]; then
    return 0
  elif in_worktree && [[ -d "../bare-repo.git" ]]; then
    return 0
  fi
  return 1
}

get_bare_root() {
  if in_worktree; then
    local git_dir
    git_dir=$(git rev-parse --git-dir 2>/dev/null)
    # git_dir is like /path/to/bare-repo.git/worktrees/branch-name
    # bare-repo.git is at /path/to/bare-repo.git
    # parent of worktree dir is /path/to
    dirname "$(dirname "$(dirname "$git_dir")")"
  else
    pwd
  fi
}

get_git_dir() {
  local bare_root="$1"
  echo "$bare_root/bare-repo.git"
}

get_default_branch() {
  local git_dir="$1"
  git -C "$git_dir" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'
}

get_current_branch() {
  git rev-parse --abbrev-ref HEAD 2>/dev/null
}

get_current_worktree_name() {
  basename "$(pwd)"
}

# --- predicates ---

is_url() {
  [[ "$1" == *"://"* || "$1" == git@* ]]
}

is_pr_url() {
  [[ "$1" =~ github\.com/.*/pull/[0-9]+ ]]
}

is_repo_url() {
  is_url "$1" && ! is_pr_url "$1"
}

extract_pr_num() {
  echo "$1" | grep -oE 'pull/[0-9]+' | cut -d'/' -f2
}

extract_org_repo() {
  # handles https://github.com/org/repo/... and git@github.com:org/repo.git
  echo "$1" | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+).*|\1|' | sed 's/\.git$//'
}

origin_matches() {
  local url="$1"
  local git_dir="$2"
  local url_org_repo target_org_repo
  url_org_repo=$(extract_org_repo "$url")
  target_org_repo=$(git -C "$git_dir" remote get-url origin 2>/dev/null | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+).*|\1|' | sed 's/\.git$//')
  [[ "$url_org_repo" == "$target_org_repo" ]]
}

worktree_exists() {
  local bare_root="$1"
  local name="$2"
  [[ -d "$bare_root/$name" ]]
}

get_worktree_branch() {
  local wt_path="$1"
  git -C "$wt_path" rev-parse --abbrev-ref HEAD 2>/dev/null
}

# --- output helpers ---

signal_cd() {
  echo "__WT_CD__:$1"
}

err() {
  echo "error: $1" >&2
  exit 1
}

# --- actions ---

print_setup_hint() {
  cat <<'EOF'
no bare-repo.git found.

to set up a new worktree-based repo:
  wt <repo-url>              # clone and set up bare repo
  wt <repo-url> <dir>        # clone into specific directory

example:
  wt https://github.com/org/repo
  wt git@github.com:org/repo.git myproject
EOF
  exit 1
}

print_usage() {
  cat <<'EOF'
usage: wt [command] [args]

commands:
  (no args)          list worktrees / show status
  <branch>           create or switch to worktree
  pr <num>           create worktree for PR
  pr-<num>           alias for 'pr <num>'
  rm                 remove current worktree
  rm <name>          remove named worktree
  <repo-url>         clone bare repo
  <repo-url> <dir>   clone into directory
  <pr-url>           clone or add worktree for PR
EOF
  exit 1
}

list_worktrees() {
  local git_dir="$1"
  local bare_root="$2"
  
  git -C "$git_dir" fetch origin --quiet 2>/dev/null || true
  local default_branch
  default_branch=$(get_default_branch "$git_dir")
  local repo
  repo=$(git -C "$git_dir" remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/')

  git -C "$git_dir" worktree list --porcelain | grep "^worktree " | cut -d' ' -f2 | while read wt; do
    [[ "$wt" == *"bare-repo.git" ]] && continue
    local name
    name=$(basename "$wt")
    local head
    head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
    
    local merged="○"
    if [[ -n "$head" ]] && git -C "$git_dir" merge-base --is-ancestor "$head" "origin/$default_branch" 2>/dev/null; then
      merged="✓"
    fi
    
    local pr_num
    pr_num=$(echo "$name" | grep -oE '^pr-[0-9]+$' | cut -d'-' -f2)
    if [[ -n "$pr_num" ]]; then
      local url="https://github.com/$repo/pull/$pr_num"
      printf '%s \e]8;;%s\e\\%s\e]8;;\e\\\n' "$merged" "$url" "$name"
      continue
    fi
    
    local issue_id
    issue_id=$(echo "$name" | grep -oE '^[a-zA-Z]+-[0-9]+' | tr '[:lower:]' '[:upper:]')
    if [[ -n "$issue_id" ]]; then
      local json
      json=$(lnr issue "$issue_id" --json 2>/dev/null | tr -d '\000-\037')
      if [[ -n "$json" ]]; then
        local state url
        state=$(echo "$json" | $JQ -r '.state // empty')
        url=$(echo "$json" | $JQ -r '.url // empty')
        printf '%s \e]8;;%s\e\\%s\e]8;;\e\\ (%s)\n' "$merged" "$url" "$name" "$state"
        continue
      fi
    fi
    
    echo "$merged $name"
  done
}

show_current_status() {
  local git_dir="$1"
  local wt_path
  wt_path=$(pwd)
  local name
  name=$(basename "$wt_path")
  local branch
  branch=$(get_current_branch)
  local default_branch
  default_branch=$(get_default_branch "$git_dir")
  
  echo "worktree: $name"
  echo "branch:   $branch"
  
  # check if merged
  git -C "$git_dir" fetch origin --quiet 2>/dev/null || true
  local head
  head=$(git rev-parse HEAD 2>/dev/null)
  if [[ -n "$head" ]] && git -C "$git_dir" merge-base --is-ancestor "$head" "origin/$default_branch" 2>/dev/null; then
    echo "status:   ✓ merged into $default_branch"
  else
    echo "status:   ○ not merged"
  fi
  
  # show git status summary
  local changes
  changes=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$changes" -gt 0 ]]; then
    echo "changes:  $changes file(s) modified"
  fi
}

remove_worktree() {
  local git_dir="$1"
  local bare_root="$2"
  local name="$3"
  local wt_path="$bare_root/$name"
  
  local branch
  branch=$(git -C "$wt_path" rev-parse --abbrev-ref HEAD 2>/dev/null)
  local default_branch
  default_branch=$(get_default_branch "$git_dir")
  
  echo "removing worktree: $name"
  git -C "$git_dir" worktree remove "$wt_path" --force
  
  # delete local branch if it exists and isn't default
  if [[ -n "$branch" && "$branch" != "$default_branch" && "$branch" != "HEAD" ]]; then
    if git -C "$git_dir" show-ref --verify --quiet "refs/heads/$branch"; then
      echo "deleting local branch: $branch"
      git -C "$git_dir" branch -D "$branch"
    fi
  fi
  
  # trash folder if still exists
  if [[ -d "$wt_path" ]]; then
    if command -v "$TRASH" &>/dev/null; then
      echo "trashing folder: $wt_path"
      "$TRASH" "$wt_path"
    else
      echo "folder still exists at $wt_path"
    fi
  fi
  
  echo "done: removed $name"
}

add_pr_worktree() {
  local git_dir="$1"
  local bare_root="$2"
  local pr_num="$3"
  
  local branch
  branch=$(GIT_DIR="$git_dir" $GH pr view "$pr_num" --json headRefName -q .headRefName)
  if [[ -z "$branch" ]]; then
    err "failed to get branch for PR #$pr_num"
  fi
  
  git -C "$git_dir" fetch origin "$branch"
  local wt_path="$bare_root/pr-$pr_num"
  
  if git -C "$git_dir" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$git_dir" worktree add "$wt_path" "$branch"
  else
    git -C "$git_dir" worktree add --track -b "$branch" "$wt_path" "origin/$branch"
  fi
  
  echo "created worktree for PR #$pr_num at $wt_path (branch: $branch)"
  signal_cd "$wt_path"
}

add_branch_worktree() {
  local git_dir="$1"
  local bare_root="$2"
  local name="$3"
  local default_branch
  default_branch=$(get_default_branch "$git_dir")
  
  local wt_path="$bare_root/$name"
  git -C "$git_dir" worktree add "$wt_path" -b "$name" "origin/$default_branch"
  echo "created worktree: $name"
  signal_cd "$wt_path"
}

clone_bare_repo() {
  local url="$1"
  local target_dir="$2"
  
  mkdir -p "$target_dir"
  local git_dir="$target_dir/bare-repo.git"
  
  git clone --bare "$url" "$git_dir"
  git -C "$git_dir" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
  git -C "$git_dir" fetch origin
  
  local default_branch
  default_branch=$(get_default_branch "$git_dir")
  if [[ -z "$default_branch" ]]; then
    default_branch="main"
  fi
  
  local main_wt="$target_dir/$default_branch"
  git -C "$git_dir" worktree add "$main_wt" "$default_branch"
  
  echo "done. bare repo at $git_dir, $default_branch worktree at $main_wt"
  signal_cd "$main_wt"
}

# --- main dispatch ---

main() {
  local argc=$#
  local arg1="${1:-}"
  local arg2="${2:-}"
  
  # reparse pr-NUM as pr NUM
  if [[ "$arg1" =~ ^pr-([0-9]+)$ ]]; then
    arg1="pr"
    arg2="${match[1]}"
    argc=2
  fi
  
  # case 1-3: no args
  if [[ $argc -eq 0 ]]; then
    if ! has_bare_repo; then
      print_setup_hint
    elif in_worktree; then
      local bare_root git_dir
      bare_root=$(get_bare_root)
      git_dir=$(get_git_dir "$bare_root")
      show_current_status "$git_dir"
    else
      local git_dir="./bare-repo.git"
      list_worktrees "$git_dir" "."
    fi
    return
  fi
  
  # case 4-10: rm command
  if [[ "$arg1" == "rm" ]]; then
    if [[ -z "$arg2" ]]; then
      # rm with no name: remove current worktree
      if ! in_worktree; then
        err "not in a worktree"
      fi
      
      local bare_root git_dir name default_branch
      bare_root=$(get_bare_root)
      git_dir=$(get_git_dir "$bare_root")
      name=$(get_current_worktree_name)
      default_branch=$(get_default_branch "$git_dir")
      
      if [[ "$name" == "$default_branch" ]]; then
        err "refusing to remove default branch worktree ($default_branch)"
      fi
      
      # cd out before removing
      cd "$bare_root" || err "failed to cd to $bare_root"
      remove_worktree "$git_dir" "$bare_root" "$name"
      signal_cd "$bare_root"
    else
      # rm with name
      if ! has_bare_repo; then
        err "no bare-repo.git found"
      fi
      
      local bare_root git_dir default_branch
      if in_worktree; then
        bare_root=$(get_bare_root)
      else
        bare_root="."
      fi
      git_dir=$(get_git_dir "$bare_root")
      default_branch=$(get_default_branch "$git_dir")
      
      if [[ "$arg2" == "$default_branch" ]]; then
        err "refusing to remove default branch worktree ($default_branch)"
      fi
      
      if ! worktree_exists "$bare_root" "$arg2"; then
        err "worktree not found: $arg2"
      fi
      
      local was_in_deleted=false
      if in_worktree && [[ "$(get_current_worktree_name)" == "$arg2" ]]; then
        was_in_deleted=true
        cd "$bare_root" || err "failed to cd to $bare_root"
      fi
      
      remove_worktree "$git_dir" "$bare_root" "$arg2"
      
      if $was_in_deleted; then
        signal_cd "$bare_root"
      fi
    fi
    return
  fi
  
  # case 11-14: pr command
  if [[ "$arg1" == "pr" ]]; then
    if [[ -z "$arg2" ]]; then
      err "usage: wt pr <number>"
    fi
    
    if ! has_bare_repo; then
      err "no bare-repo.git found"
    fi
    
    local bare_root git_dir
    if in_worktree; then
      bare_root=$(get_bare_root)
    else
      bare_root="."
    fi
    git_dir=$(get_git_dir "$bare_root")
    
    local wt_name="pr-$arg2"
    if worktree_exists "$bare_root" "$wt_name"; then
      local existing_branch expected_branch
      existing_branch=$(get_worktree_branch "$bare_root/$wt_name")
      expected_branch=$(GIT_DIR="$git_dir" $GH pr view "$arg2" --json headRefName -q .headRefName 2>/dev/null)
      
      if [[ "$existing_branch" == "$expected_branch" ]]; then
        echo "worktree already exists for PR #$arg2"
        signal_cd "$bare_root/$wt_name"
      else
        err "worktree $wt_name exists but has branch '$existing_branch', PR #$arg2 is on '$expected_branch'"
      fi
    else
      add_pr_worktree "$git_dir" "$bare_root" "$arg2"
    fi
    return
  fi
  
  # case 15-18: url handling
  if is_url "$arg1"; then
    if is_pr_url "$arg1"; then
      local pr_num org_repo
      pr_num=$(extract_pr_num "$arg1")
      org_repo=$(extract_org_repo "$arg1")
      
      if has_bare_repo; then
        local bare_root git_dir
        if in_worktree; then
          bare_root=$(get_bare_root)
        else
          bare_root="."
        fi
        git_dir=$(get_git_dir "$bare_root")
        
        if origin_matches "$arg1" "$git_dir"; then
          # dispatch to pr case
          main "pr" "$pr_num"
          return
        fi
      fi
      
      # clone and add pr worktree
      local repo_name="${org_repo#*/}"
      local target_dir="./$repo_name"
      
      echo "cloning $org_repo..."
      clone_bare_repo "https://github.com/$org_repo.git" "$target_dir" | grep -v "__WT_CD__"
      
      local git_dir="$target_dir/bare-repo.git"
      add_pr_worktree "$git_dir" "$target_dir" "$pr_num"
    else
      # repo url
      local target_dir
      if [[ -n "$arg2" ]]; then
        target_dir="$arg2"
      else
        local repo_name
        repo_name=$(extract_org_repo "$arg1")
        repo_name="${repo_name#*/}"
        target_dir="./$repo_name"
      fi
      
      clone_bare_repo "$arg1" "$target_dir"
    fi
    return
  fi
  
  # case 20-23: branch name
  if ! has_bare_repo; then
    err "no bare-repo.git found. use 'wt <repo-url>' to set up."
  fi
  
  local bare_root git_dir name
  name="${(L)arg1}"  # lowercase
  
  if in_worktree; then
    bare_root=$(get_bare_root)
  else
    bare_root="."
  fi
  git_dir=$(get_git_dir "$bare_root")
  
  if worktree_exists "$bare_root" "$name"; then
    local existing_branch
    existing_branch=$(get_worktree_branch "$bare_root/$name")
    
    if [[ "$existing_branch" == "$name" ]]; then
      echo "worktree already exists: $name"
      signal_cd "$bare_root/$name"
    else
      err "worktree $name exists but has branch '$existing_branch', not '$name'"
    fi
  else
    add_branch_worktree "$git_dir" "$bare_root" "$name"
  fi
}

main "$@"
