#!/usr/bin/env zsh
# wt: unified worktree management

set -euo pipefail

GH="@gh@"
JQ="@jq@"
TRASH="@trash@"

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
    # git stores worktree metadata at bare-repo.git/worktrees/<name>
    # we need the parent of bare-repo.git, not of the metadata dir
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

find_worktree_for_branch() {
  local git_dir="$1"
  local branch="$2"
  git -C "$git_dir" worktree list --porcelain | awk -v branch="$branch" '
    /^worktree / { wt = substr($0, 10) }
    /^branch refs\/heads\// { 
      b = substr($0, 19)
      if (b == branch) { print wt; exit }
    }
  '
}

err() {
  echo "error: $1" >&2
  exit 1
}

symlink_env_files() {
  local bare_root="$1"
  local git_dir="$2"
  local target_wt="$3"
  
  local default_branch
  default_branch=$(get_default_branch "$git_dir")
  
  # find the worktree that's on the default branch (name may differ)
  local source_wt
  source_wt=$(find_worktree_for_branch "$git_dir" "$default_branch")
  
  if [[ -z "$source_wt" || ! -d "$source_wt" ]]; then
    return 0
  fi
  
  # resolve to absolute for reliable comparison
  source_wt=$(cd "$source_wt" && pwd)
  target_wt=$(cd "$target_wt" && pwd)
  
  local count=0
  while IFS= read -r -d '' env_file; do
    local rel_path="${env_file#$source_wt/}"
    local target_path="$target_wt/$rel_path"
    local target_dir
    target_dir=$(dirname "$target_path")
    
    if [[ -e "$target_path" ]]; then
      continue
    fi
    
    mkdir -p "$target_dir"
    
    # compute relative path from target_dir to env_file
    local rel_link
    rel_link=$(python3 -c "import os.path; print(os.path.relpath('$env_file', '$target_dir'))")
    ln -s "$rel_link" "$target_path"
    ((count++))
  done < <(find "$source_wt" -name '.env*' -type f -print0 2>/dev/null)
  
  if [[ $count -gt 0 ]]; then
    echo "symlinked $count .env file(s) from $default_branch"
  fi
}

print_setup_hint() {
  cat <<'EOF'
no bare-repo.git. clone one:
  wt <repo-url>
  wt <repo-url> <dir>
EOF
  exit 1
}

print_help() {
  cat <<'EOF'
wt - worktree management

usage: wt [cmd] [args]

commands:
  (none)              list worktrees (or status if in worktree)
  <branch>            add worktree, cd into it
  pr <num>            add worktree for PR
  pr-<num>            alias for pr <num>
  <pr-url>            add worktree from github PR url
  rm [name]           remove worktree (current if no name)
  env                 (re)symlink .env files from default branch
  <repo-url>          clone bare repo, add default branch worktree
  <repo-url> <dir>    clone into specific directory
  help, --help, -h    show this help

subcommand help:
  wt pr --help
  wt rm --help
  wt env --help
EOF
}

print_help_env() {
  cat <<'EOF'
wt env - symlink .env files from default branch worktree

usage: wt env

finds the worktree on the default branch (main/master) and
symlinks all .env* files to the current worktree.
skips files that already exist. uses relative symlinks.

run from within a worktree.
EOF
}

print_help_pr() {
  cat <<'EOF'
wt pr - add worktree for PR

usage: wt pr <num>
       wt pr-<num>
       wt <github-pr-url>

fetches PR branch from origin, creates worktree at ../pr-<num>.
if worktree exists and branch matches, cd into it.
if worktree exists but branch differs, error.

examples:
  wt pr 231
  wt pr-231
  wt https://github.com/org/repo/pull/231
EOF
}

print_help_rm() {
  cat <<'EOF'
wt rm - remove a worktree

usage: wt rm [name]

if no name: removes current worktree (must be in one).
if name: removes named worktree.

also deletes local branch (unless default) and trashes folder.
refuses to remove default branch worktree.

examples:
  wt rm           # remove current
  wt rm pr-231    # remove pr-231
EOF
}

list_worktrees() {
  local git_dir="$1"
  local bare_root="$2"
  local default_branch wt name branch head merged
  
  git -C "$git_dir" fetch origin --quiet 2>/dev/null || true
  default_branch=$(get_default_branch "$git_dir")

  git -C "$git_dir" worktree list --porcelain | while read -r line; do
    case "$line" in
      worktree\ *)
        wt="${line#worktree }"
        [[ "$wt" == *"bare-repo.git" ]] && wt="" && continue
        ;;
      branch\ *)
        [[ -z "$wt" ]] && continue
        merged="○"
        name=$(basename "$wt")
        branch="${line#branch refs/heads/}"
        
        head=$(git -C "$wt" rev-parse HEAD 2>/dev/null) || true
        if [[ -n "$head" ]] && git -C "$git_dir" merge-base --is-ancestor "$head" "origin/$default_branch" 2>/dev/null; then
          merged="✓"
        fi
        
        if [[ "$name" == "$branch" ]]; then
          echo "$merged $name"
        else
          echo "$merged $name ($branch)"
        fi
        wt=""
        ;;
    esac
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
  
  git -C "$git_dir" fetch origin --quiet 2>/dev/null || true
  local head
  head=$(git rev-parse HEAD 2>/dev/null)
  if [[ -n "$head" ]] && git -C "$git_dir" merge-base --is-ancestor "$head" "origin/$default_branch" 2>/dev/null; then
    echo "status:   ✓ merged into $default_branch"
  else
    echo "status:   ○ not merged"
  fi
  
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
  # git worktree remove needs absolute path when using -C
  local wt_path_abs
  wt_path_abs=$(cd "$wt_path" 2>/dev/null && pwd) || wt_path_abs="$(pwd)/$wt_path"
  
  local branch
  branch=$(git -C "$wt_path" rev-parse --abbrev-ref HEAD 2>/dev/null)
  local default_branch
  default_branch=$(get_default_branch "$git_dir")
  
  echo "removing: $name"
  git -C "$git_dir" worktree remove "$wt_path_abs" --force
  
  if [[ -n "$branch" && "$branch" != "$default_branch" && "$branch" != "HEAD" ]]; then
    if git -C "$git_dir" show-ref --verify --quiet "refs/heads/$branch"; then
      echo "deleting branch: $branch"
      git -C "$git_dir" branch -D "$branch"
    fi
  fi
  
  if [[ -d "$wt_path" ]]; then
    if command -v "$TRASH" &>/dev/null; then
      "$TRASH" "$wt_path"
    fi
  fi
  
  echo "done"
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
  
  local existing_wt
  existing_wt=$(find_worktree_for_branch "$git_dir" "$branch")
  if [[ -n "$existing_wt" ]]; then
    local existing_name
    existing_name=$(basename "$existing_wt")
    echo "branch '$branch' already has a worktree at: $existing_name"
    return
  fi
  
  git -C "$git_dir" fetch origin "$branch"
  local wt_path
  wt_path="$(cd "$bare_root" && pwd)/pr-$pr_num"
  
  if git -C "$git_dir" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$git_dir" worktree add "$wt_path" "$branch"
  else
    git -C "$git_dir" worktree add --track -b "$branch" "$wt_path" "origin/$branch"
  fi
  
  symlink_env_files "$bare_root" "$git_dir" "$wt_path"
  echo "done. pr-$pr_num ($branch)"
}

add_branch_worktree() {
  local git_dir="$1"
  local bare_root="$2"
  local name="$3"
  local default_branch
  default_branch=$(get_default_branch "$git_dir")
  
  local wt_path
  wt_path="$(cd "$bare_root" && pwd)/$name"
  git -C "$git_dir" worktree add --no-track "$wt_path" -b "$name" "origin/$default_branch"
  symlink_env_files "$bare_root" "$git_dir" "$wt_path"
  echo "done. $name"
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
  # origin/HEAD may not be set yet after bare clone; fall back to main
  [[ -z "$default_branch" ]] && default_branch="main"
  
  local main_wt="$target_dir/$default_branch"
  git -C "$git_dir" worktree add "$main_wt" "$default_branch"
  
  echo "done. $default_branch"
}

main() {
  local argc=$#
  local arg1="${1:-}"
  local arg2="${2:-}"
  
  if [[ "$arg1" == "help" || "$arg1" == "--help" || "$arg1" == "-h" ]]; then
    print_help
    return
  fi
  
  if [[ "$arg1" =~ ^pr-([0-9]+)$ ]]; then
    arg1="pr"
    arg2="${match[1]}"
    argc=2
  fi
  
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
  
  if [[ "$arg1" == "env" ]]; then
    if [[ "$arg2" == "--help" || "$arg2" == "-h" ]]; then
      print_help_env
      return
    fi
    if ! in_worktree; then
      err "not in a worktree"
    fi
    
    local bare_root git_dir
    bare_root=$(get_bare_root)
    git_dir=$(get_git_dir "$bare_root")
    local wt_path
    wt_path=$(pwd)
    
    symlink_env_files "$bare_root" "$git_dir" "$wt_path"
    return
  fi
  
  if [[ "$arg1" == "rm" ]]; then
    if [[ "$arg2" == "--help" || "$arg2" == "-h" ]]; then
      print_help_rm
      return
    fi
    if [[ -z "$arg2" ]]; then
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
      
      cd "$bare_root" || err "failed to cd to $bare_root"
      remove_worktree "$git_dir" "$bare_root" "$name"
    else
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
      
      remove_worktree "$git_dir" "$bare_root" "$arg2"
    fi
    return
  fi
  
  if [[ "$arg1" == "pr" ]]; then
    if [[ "$arg2" == "--help" || "$arg2" == "-h" ]]; then
      print_help_pr
      return
    fi
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
      else
        err "worktree $wt_name exists but has branch '$existing_branch', PR #$arg2 is on '$expected_branch'"
      fi
    else
      add_pr_worktree "$git_dir" "$bare_root" "$arg2"
    fi
    return
  fi
  
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
                  main "pr" "$pr_num"
                  return
                fi
      fi
      
      local repo_name="${org_repo#*/}"
      local target_dir="./$repo_name"
      
      echo "cloning $org_repo..."
      clone_bare_repo "https://github.com/$org_repo.git" "$target_dir" | grep -v "__WT_CD__"
      
      local git_dir="$target_dir/bare-repo.git"
      add_pr_worktree "$git_dir" "$target_dir" "$pr_num"
    else
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
    else
      err "worktree $name exists but has branch '$existing_branch', not '$name'"
    fi
  else
    add_branch_worktree "$git_dir" "$bare_root" "$name"
  fi
}

main "$@"
