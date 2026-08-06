set -euo pipefail

config=${CMUX_FLEET_CONFIG:?CMUX_FLEET_CONFIG must point to cmux.json}
command=${1:-up}

if [[ $command != up && $command != status ]]; then
  echo "usage: cmux-fleet [up|status]" >&2
  exit 2
fi

if ! cmux ping >/dev/null 2>&1; then
  echo "cmux-fleet: run this from a terminal inside cmux" >&2
  exit 1
fi

workspaces=$(cmux workspace list --json)
created=0
present=0
missing=0

while IFS= read -r workspace; do
  name=$(jq -r '.name' <<<"$workspace")

  if jq -e --arg name "$name" '.workspaces[]? | select(.title == $name)' \
    <<<"$workspaces" >/dev/null; then
    printf 'present  %s\n' "$name"
    present=$((present + 1))
    continue
  fi

  if [[ $command == status ]]; then
    printf 'missing  %s\n' "$name"
    missing=$((missing + 1))
    continue
  fi

  layout=$(jq -c '.layout' <<<"$workspace")
  args=(workspace create --name "$name" --layout "$layout" --focus false)

  cwd=$(jq -r '.cwd // empty' <<<"$workspace")
  if [[ -n $cwd ]]; then
    args+=(--cwd "$cwd")
  fi

  cmux "${args[@]}" >/dev/null
  printf 'created  %s\n' "$name"
  created=$((created + 1))
done < <(
  jq -c '
    .commands[]
    | select((.keywords // []) | index("cmux-fleet"))
    | .workspace
  ' "$config"
)

if [[ $command == status ]]; then
  printf '\n%d present, %d missing\n' "$present" "$missing"
  ((missing == 0))
else
  printf '\n%d present, %d created\n' "$present" "$created"
fi
