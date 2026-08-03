#!/usr/bin/env bash
set -euo pipefail

if (( $# != 4 )); then
  echo "usage: $0 FLEXGET CONFIG VARIABLES KINDLE_DIRECTORY" >&2
  exit 64
fi

flexget_bin=$1
config_path=$2
variables_path=$3
kindle_directory=$4
baseline=1171
next_chapter=$baseline

if [[ -f $variables_path ]]; then
  # a missing or deleted sidecar must not move the watermark backward.
  previous=$(
    sed -nE 's/^[[:space:]]*one_piece_begin:[[:space:]]*([0-9]+)[[:space:]]*$/\1/p' \
      "$variables_path" |
      tail -n 1
  )
  if [[ $previous =~ ^[0-9]+$ ]] && (( previous > next_chapter )); then
    next_chapter=$previous
  fi
fi

shopt -s nullglob
for metadata in "$kindle_directory"/One\ Piece\ *.sdr/metadata.cbz.lua; do
  # sidecars are data from another device. match the scalar instead of executing lua.
  if ! grep -Eq \
    '^[[:space:]]*\["status"\][[:space:]]*=[[:space:]]*"complete"[[:space:]]*,?[[:space:]]*$' \
    "$metadata" &&
    # KOReader can leave status at "reading" after reaching 100%.
    ! grep -Eq \
      '^[[:space:]]*\["percent_finished"\][[:space:]]*=[[:space:]]*1(\.0+)?[[:space:]]*,?[[:space:]]*$' \
      "$metadata"; then
    continue
  fi

  sidecar_directory=${metadata%/metadata.cbz.lua}
  sidecar_name=${sidecar_directory##*/}
  if [[ $sidecar_name =~ ^One\ Piece\ ([0-9]{4})\.sdr$ ]]; then
    # intentionally use the highest completed chapter, even if earlier chapters are unread.
    candidate=$((10#${BASH_REMATCH[1]} + 1))
    if (( candidate > next_chapter )); then
      next_chapter=$candidate
    fi
  fi
done

temporary_variables=$(mktemp "${variables_path}.tmp.XXXXXX")
trap 'rm -f "$temporary_variables"' EXIT
printf 'one_piece_begin: %d\n' "$next_chapter" >"$temporary_variables"
mv "$temporary_variables" "$variables_path"
trap - EXIT

echo "one piece minimum chapter: $next_chapter"
exec "$flexget_bin" --cron -c "$config_path" execute
