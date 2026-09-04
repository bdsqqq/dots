#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
definitions="${1:-$script_dir/papertrail-virtual-fields.json}"
axiom_api="${AXIOM_API_URL:-https://api.axiom.co}"
axiom_token="${AXIOM_TOKEN:-}"
axiom_org_id="${AXIOM_ORG_ID:-}"

if [[ -z "$axiom_token" && -r /run/secrets/axiom/personal_token ]]; then
  axiom_token="$(</run/secrets/axiom/personal_token)"
fi
if [[ -z "$axiom_org_id" && -r /run/secrets/axiom/personal_org_id ]]; then
  axiom_org_id="$(</run/secrets/axiom/personal_org_id)"
fi
if [[ -z "$axiom_token" || -z "$axiom_org_id" ]]; then
  echo "set AXIOM_TOKEN and AXIOM_ORG_ID, or provide readable Axiom secrets" >&2
  exit 1
fi

jq -e '
  type == "array" and length > 0 and
  all(.[]; (.dataset | type == "string" and length > 0) and
           (.name | type == "string" and length > 0) and
           (.description | type == "string") and
           (.expression | type == "string" and length > 0)) and
  ([.[] | [.dataset, .name]] | length == (unique | length))
' "$definitions" >/dev/null

curl_config="$(mktemp)"
trap 'rm -f "$curl_config"' EXIT
chmod 600 "$curl_config"
printf 'header = "Authorization: Bearer %s"\nheader = "X-Axiom-Org-Id: %s"\n' \
  "$axiom_token" "$axiom_org_id" >"$curl_config"
unset axiom_token axiom_org_id

request() {
  local body response status
  if ! response="$(curl --silent --show-error --write-out $'\n%{http_code}' \
      --config "$curl_config" \
      -H "Content-Type: application/json" \
      "$@")"; then
    return 1
  fi
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if ((status < 200 || status >= 300)); then
    printf 'Axiom API returned HTTP %s: %s\n' "$status" "$body" >&2
    return 1
  fi
  printf '%s' "$body"
}

declare -A dataset_cache=()
while IFS= read -r desired; do
  dataset="$(jq -r '.dataset' <<<"$desired")"
  name="$(jq -r '.name' <<<"$desired")"
  if [[ -z "${dataset_cache[$dataset]+set}" ]]; then
    dataset_cache[$dataset]="$(request --get --data-urlencode "dataset=$dataset" "$axiom_api/v2/vfields")"
  fi

  matches="$(jq --arg name "$name" '[.[] | select(.name == $name)]' <<<"${dataset_cache[$dataset]}")"
  match_count="$(jq 'length' <<<"$matches")"
  if ((match_count > 1)); then
    echo "$dataset/$name: multiple existing virtual fields" >&2
    exit 1
  fi

  if ((match_count == 0)); then
    created="$(request -X POST --data "$desired" "$axiom_api/v2/vfields")"
    dataset_cache[$dataset]="$(jq --argjson created "$created" '. + [$created]' <<<"${dataset_cache[$dataset]}")"
    echo "$dataset/$name: created"
    continue
  fi

  existing="$(jq '.[0]' <<<"$matches")"
  current="$(jq -c '{dataset, name, description, expression}' <<<"$existing")"
  target="$(jq -c '{dataset, name, description, expression}' <<<"$desired")"
  if [[ "$current" == "$target" ]]; then
    echo "$dataset/$name: unchanged"
    continue
  fi

  id="$(jq -r '.id' <<<"$existing")"
  updated="$(request -X PUT --data "$desired" "$axiom_api/v2/vfields/$id")"
  dataset_cache[$dataset]="$(jq --arg id "$id" --argjson updated "$updated" 'map(if .id == $id then $updated else . end)' <<<"${dataset_cache[$dataset]}")"
  echo "$dataset/$name: updated"
done < <(jq -c '.[]' "$definitions")
