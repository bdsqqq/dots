#!/usr/bin/env bash
# Overlay dots-owned skill directories on an existing destination tree. Skills
# absent from dots are deliberately retained; this is not a mirror or prune.
set -euo pipefail

root="$1"
source_sha="$2"
remote="$3"
credential_helper="${4:-}"
signing_program="${5:-}"
git() {
  if [[ -n "$credential_helper" ]]; then
    command git -c credential.helper= -c "credential.helper=$credential_helper" "$@"
  else
    command git "$@"
  fi
}

skills_tree="$(git -C "$root" rev-parse --verify "$source_sha:modules/agents/skills")"
[[ "$(git -C "$root" cat-file -t "$skills_tree")" == tree ]]

git -C "$root" fetch --quiet "$remote" main
published_sha="$(git -C "$root" rev-parse FETCH_HEAD)"
published_tree="$(git -C "$root" rev-parse "$published_sha^{tree}")"
index_dir="$(mktemp -d)"
trap 'rm -rf "$index_dir"' EXIT
export GIT_INDEX_FILE="$index_dir/index"
git -C "$root" read-tree "$published_tree"

while IFS= read -r -d '' entry; do
  name="${entry#*$'\t'}"
  metadata="${entry%%$'\t'*}"
  read -r _mode type object <<< "$metadata"
  [[ "$type" == tree ]] || continue
  # Only skill directories are owned by this projection.
  if ! git -C "$root" cat-file -e "$object:SKILL.md" 2>/dev/null &&
    ! git -C "$root" cat-file -e "$object:skill.md" 2>/dev/null; then
    continue
  fi
  git -C "$root" rm --quiet -r -f --cached --ignore-unmatch -- ":(literal)$name"
  git -C "$root" read-tree --prefix="$name/" "$object"
done < <(git -C "$root" ls-tree -z "$skills_tree")

projection_tree="$(git -C "$root" write-tree)"
if [[ "$projection_tree" == "$published_tree" ]]; then
  echo "$remote skills are already up to date." >&2
  exit 0
fi

signing_config=()
signing_args=()
if [[ -n "$signing_program" ]]; then
  signing_config=(-c gpg.format=ssh -c "gpg.ssh.program=$signing_program" -c user.signingkey=amp-managed)
  # commit-tree does not honor commit.gpgsign; request signing explicitly.
  signing_args=(-S)
fi
projection_sha="$(printf 'Project skills from dots\n\nDots-Commit: %s\n' "$source_sha" |
  git -C "$root" "${signing_config[@]}" commit-tree "${signing_args[@]}" "$projection_tree" -p "$published_sha")"
# An ordinary fast-forward push rejects concurrent updates instead of losing them.
git -C "$root" push "$remote" "$projection_sha:refs/heads/main"
