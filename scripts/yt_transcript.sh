#!/bin/bash -l

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title youtube transcript
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 📝
# @raycast.packageName media_utils
# @raycast.argument1 { "type": "text", "placeholder": "URL" }
# @raycast.argument2 { "type": "text", "placeholder": "output dir", "optional": true }
# @raycast.argument3 { "type": "dropdown", "placeholder": "options", "optional": true, "data": [{"title": "normal", "value": ""}, {"title": "dry run", "value": "-n"}, {"title": "verbose", "value": "-v"}] }

# Documentation:
# @raycast.description Extract YouTube transcript to markdown with frontmatter
# @raycast.author bdsqqq
# @raycast.authorURL https://raycast.com/bdsqqq

set -euo pipefail

usage() {
    cat <<EOF
yt_transcript — extract youtube transcript to markdown

usage: yt_transcript [options] <url>

options:
  -d, --dir DIR      output directory (default: ~/commonplace/00_inputs)
  -n, --dry-run      show what would be created without creating
  -v, --verbose      show debug output
  -h, --help         show this help

examples:
  yt_transcript https://youtube.com/watch?v=dQw4w9WgXcQ
  yt_transcript -d ~/Downloads https://youtube.com/watch?v=dQw4w9WgXcQ
  yt_transcript --dry-run https://youtube.com/watch?v=dQw4w9WgXcQ

cookies are read from sops-nix at /run/secrets/cookies if available.
EOF
}

# defaults
TODAY=$(date +%Y-%m-%d)
INBOX_DIR="$HOME/commonplace/00_inputs"
DRY_RUN=false
VERBOSE=false
URL=""

# sops-nix decrypts secrets to /run/secrets on darwin
COOKIES_FILE="/run/secrets/cookies"

# global for cleanup
TEMP_VTT_FILE=""
TEMP_COOKIES=""

log() { [[ "$VERBOSE" = true ]] && echo "$@" >&2 || true; }

cleanup() {
    [[ -n "$TEMP_VTT_FILE" && -f "$TEMP_VTT_FILE" ]] && rm -f "$TEMP_VTT_FILE"
    [[ -n "$TEMP_COOKIES" && -f "$TEMP_COOKIES" ]] && rm -f "$TEMP_COOKIES"
}
trap cleanup EXIT

sanitize_filename() {
    local input="$1"
    local dir ext base clean
    dir=$(dirname "$input")
    ext="${input##*.}"
    base=$(basename "$input" ".$ext")
    # transliterate diacritics
    if ! clean=$(printf '%s' "$base" | iconv -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null); then
        clean="$base"
    fi
    # lowercase, keep only [a-z0-9 ._-], collapse spaces, trim
    clean=$(printf '%s' "$clean" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 ._-]//g' | sed 's/  */ /g' | sed 's/^ *//;s/ *$//')
    printf '%s/%s.%s\n' "$dir" "$clean" "$ext"
}

# collect positional args separately
positional=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -d|--dir)
            INBOX_DIR="$2"
            shift 2
            ;;
        -n|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -*)
            echo "unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
        *)
            positional+=("$1")
            shift
            ;;
    esac
done

# positional args: URL required, output dir optional (for raycast arg2)
[[ ${#positional[@]} -ge 1 ]] && URL="${positional[0]}"
[[ ${#positional[@]} -ge 2 ]] && INBOX_DIR="${positional[1]}"

if [[ -z "$URL" ]]; then
    echo "error: no url provided" >&2
    usage >&2
    exit 1
fi

# check for yt-dlp
if ! command -v yt-dlp &>/dev/null; then
    echo "error: yt-dlp not installed" >&2
    exit 1
fi

mkdir -p "$INBOX_DIR"

# setup cookies
cookie_args=()
if [[ -f "$COOKIES_FILE" ]]; then
    TEMP_COOKIES=$(mktemp)
    cp "$COOKIES_FILE" "$TEMP_COOKIES"
    cookie_args=(--cookies "$TEMP_COOKIES")
    log "using cookies: $COOKIES_FILE (copied to temp)"
fi

log "fetching video info..."
log "yt-dlp path: $(command -v yt-dlp)"

VIDEO_INFO=$(yt-dlp --print "%(title)s\n%(channel)s\n%(id)s\n%(upload_date>%Y-%m-%d|unknown)s" --skip-download ${cookie_args[@]+"${cookie_args[@]}"} "$URL" 2>&1)
YT_EXIT=$?

log "yt-dlp info exit code: $YT_EXIT"
log "raw output:\n$VIDEO_INFO"

if [[ $YT_EXIT -ne 0 ]]; then
    echo "error: yt-dlp failed to get video info" >&2
    echo "$VIDEO_INFO" >&2
    exit 1
fi

# parse into array
lines=()
while IFS= read -r line || [[ -n "$line" ]]; do
    lines+=("$line")
done <<< "$VIDEO_INFO"

if [[ ${#lines[@]} -lt 4 ]]; then
    echo "error: expected 4 lines (title, channel, id, upload_date), got ${#lines[@]}" >&2
    exit 1
fi

VIDEO_TITLE="${lines[0]}"
VIDEO_CHANNEL="${lines[1]}"
VIDEO_ID="${lines[2]}"
UPLOAD_DATE="${lines[3]}"

log "title: $VIDEO_TITLE"
log "channel: $VIDEO_CHANNEL"
log "id: $VIDEO_ID"
log "upload_date: $UPLOAD_DATE"

if [[ -z "$VIDEO_TITLE" || -z "$VIDEO_CHANNEL" || -z "$VIDEO_ID" ]]; then
    echo "error: failed to parse video info" >&2
    exit 1
fi

# prepare output filename - matches download-media.sh pattern with "transcript" prefix
# pattern: ${TODAY} transcript at ${UPLOAD_DATE} from ${CHANNEL} - ${TITLE} ${ID}.md
RAW_FILENAME="${INBOX_DIR}/${TODAY} transcript at ${UPLOAD_DATE} from ${VIDEO_CHANNEL} - ${VIDEO_TITLE:0:280} ${VIDEO_ID}.md"
FINAL_OUTPUT_PATH=$(sanitize_filename "$RAW_FILENAME")

log "output path: $FINAL_OUTPUT_PATH"

if [[ "$DRY_RUN" = true ]]; then
    echo "$FINAL_OUTPUT_PATH"
    exit 0
fi

# download subtitles to temp location
TEMP_SUB_PATTERN="temp_yt_sub_${VIDEO_ID}"
find . -maxdepth 1 -type f -name "${TEMP_SUB_PATTERN}.*.vtt" -delete 2>/dev/null || true

log "downloading subtitles..."

yt_sub_args=(yt-dlp --skip-download --write-auto-subs --sub-langs "en,en-US,en-GB" --sub-format vtt -o "${TEMP_SUB_PATTERN}.%(ext)s")
[[ "$VERBOSE" = false ]] && yt_sub_args+=(--quiet)
yt_sub_args+=(${cookie_args[@]+"${cookie_args[@]}"} "$URL")

if ! "${yt_sub_args[@]}"; then
    echo "error: failed to download subtitles" >&2
    exit 1
fi

TEMP_VTT_FILE=$(find . -maxdepth 1 -type f -name "${TEMP_SUB_PATTERN}.*.vtt" -print -quit)

if [[ -z "$TEMP_VTT_FILE" || ! -f "$TEMP_VTT_FILE" ]]; then
    echo "error: no subtitles found for ${TEMP_SUB_PATTERN}.*.vtt" >&2
    exit 1
fi

log "subtitles: $TEMP_VTT_FILE"

# prepare frontmatter
LOWERCASE_CHANNEL=$(echo "$VIDEO_CHANNEL" | tr '[:upper:]' '[:lower:]')

{
    printf -- '---\n'
    printf 'type:\n'
    printf '  - "type/clipping"\n'
    printf 'area:\n'
    printf 'keywords:\n'
    printf 'status:\n'
    printf '  - "status/unprocessed"\n'
    printf 'created: %s\n' "$TODAY"
    printf 'published: %s\n' "$TODAY"
    printf 'source: %s\n' "$URL"
    printf 'author:\n'
    printf '  - "%s"\n' "$LOWERCASE_CHANNEL"
    printf -- '---\n\n'
} > "$FINAL_OUTPUT_PATH"

# clean VTT and append
awk '
    BEGIN { in_header = 1; prev_line = "" }
    /^$/ { if (in_header) { in_header = 0 } next }
    in_header && (/^WEBVTT/ || /^Kind:/ || /^Language:/ || /^NOTE/ || /^STYLE/ || /^[0-9]+$/ || /-->/) { next }
    in_header { next }
    /^[0-9]+$/ { next }
    /-->/ { next }
    {
        gsub(/<[^>]*>/, "", $0)
        gsub(/^[ \t]+|[ \t]+$/, "", $0)
        if ($0 != "" && $0 != prev_line) {
            print $0
            prev_line = $0
        }
    }
' "$TEMP_VTT_FILE" >> "$FINAL_OUTPUT_PATH"

if [[ ! -s "$FINAL_OUTPUT_PATH" ]]; then
    echo "error: output file empty" >&2
    trap - EXIT  # keep temp files for debugging
    exit 1
fi

echo "$FINAL_OUTPUT_PATH"
exit 0
