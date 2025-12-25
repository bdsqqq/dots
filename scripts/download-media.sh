#!/bin/bash -l

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title download media
# @raycast.mode compact

# Optional parameters:
# @raycast.icon ↴
# @raycast.packageName media_utils
# @raycast.argument1 { "type": "text", "placeholder": "URL" }
# @raycast.argument2 { "type": "text", "placeholder": "output dir", "optional": true }
# @raycast.argument3 { "type": "dropdown", "placeholder": "options", "optional": true, "data": [{"title": "normal", "value": ""}, {"title": "dry run", "value": "-n"}, {"title": "verbose", "value": "-v"}] }

# Documentation:
# @raycast.description Download media from most sites with just a URL
# @raycast.author bdsqqq
# @raycast.authorURL https://raycast.com/bdsqqq

set -euo pipefail

usage() {
    cat <<EOF
download-media — grab video/images from most sites

usage: download-media [options] <url>

options:
  -d, --dir DIR      output directory (default: ~/commonplace/00_inputs)
  -n, --dry-run      show what would be downloaded without downloading
  -v, --verbose      show progress and fallback attempts
  -h, --help         show this help

examples:
  download-media https://youtube.com/watch?v=dQw4w9WgXcQ
  download-media -d ~/Downloads https://twitter.com/user/status/123
  download-media --dry-run https://instagram.com/p/abc123

cookies are read from sops-nix at /run/user/\$UID/secrets/cookies if available.
falls back to yt-dlp → gallery-dl in sequence.
EOF
}

# defaults
TODAY=$(date +%Y-%m-%d)
INBOX_DIR="$HOME/commonplace/00_inputs"
DRY_RUN=false
VERBOSE=false
URL=""

log() { [[ "$VERBOSE" = true ]] && echo "$@" >&2 || true; }

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

# sops-nix decrypts secrets to /run/secrets on darwin
COOKIES_FILE="/run/secrets/cookies"

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

if [ -z "$URL" ]; then
    echo "error: no url provided" >&2
    usage >&2
    exit 1
fi

mkdir -p "$INBOX_DIR"

# yt-dlp tries to write to cookies file, so copy to temp
cookie_args=()
if [ -f "$COOKIES_FILE" ]; then
    TEMP_COOKIES=$(mktemp)
    cp "$COOKIES_FILE" "$TEMP_COOKIES"
    trap 'rm -f "$TEMP_COOKIES"' EXIT
    cookie_args=(--cookies "$TEMP_COOKIES")
    log "using cookies: $COOKIES_FILE (copied to temp)"
fi

dry_run_args=()
if [ "$DRY_RUN" = true ]; then
    dry_run_args=(--simulate --print filename)
    log "dry run mode"
fi

OUTPUT_TEMPLATE="${INBOX_DIR}/${TODAY} at %(upload_date>%Y-%m-%d|unknown)s from %(uploader,channel|unknown)s - %(title).280s %(id)s.%(ext)s"

log "trying yt-dlp..."
# get filename first, then sanitize before download
if RAW_NAME=$(yt-dlp --print filename --output "$OUTPUT_TEMPLATE" ${cookie_args[@]+"${cookie_args[@]}"} -- "$URL" 2>/dev/null) && [[ -n "$RAW_NAME" ]]; then
    CLEAN_NAME=$(sanitize_filename "$RAW_NAME")
    if OUTPUT=$(yt-dlp \
        --format "bestvideo+bestaudio/best" \
        --write-subs \
        --sub-langs "en,pt" \
        --embed-subs \
        --sleep-requests 1 \
        --embed-thumbnail \
        --embed-metadata \
        --add-metadata \
        --remux-video "mkv" \
        --ignore-errors \
        --print after_move:filepath \
        ${cookie_args[@]+"${cookie_args[@]}"} \
        ${dry_run_args[@]+"${dry_run_args[@]}"} \
        --output "$CLEAN_NAME" \
        -- "$URL") && [[ -n "$OUTPUT" ]]; then
        echo "$OUTPUT"
        exit 0
    fi
fi

log "yt-dlp failed, trying gallery-dl..."

GALLERY_TEMPLATE="${TODAY} at {date:%Y-%m-%d} from {author[name]} - {content:.280} {filename}.{extension}"

gallery_dry_run_args=()
if [ "$DRY_RUN" = true ]; then
    gallery_dry_run_args=(--simulate)
fi

if OUTPUT=$(gallery-dl \
    --directory "$INBOX_DIR" \
    --filename "$GALLERY_TEMPLATE" \
    --print "{_path}" \
    ${cookie_args[@]+"${cookie_args[@]}"} \
    ${gallery_dry_run_args[@]+"${gallery_dry_run_args[@]}"} \
    -- "$URL" 2>/dev/null) && [[ -n "$OUTPUT" ]]; then
    # sanitize each output file (gallery-dl can return multiple)
    while IFS= read -r file; do
        [[ -z "$file" || "$file" == "None" ]] && continue
        if [[ -f "$file" ]]; then
            clean=$(sanitize_filename "$file")
            if [[ "$file" != "$clean" ]]; then
                mv "$file" "$clean" 2>/dev/null && file="$clean"
            fi
        fi
        echo "$file"
    done <<< "$OUTPUT"
    exit 0
fi

if [ ! -f "$COOKIES_FILE" ]; then
    echo "error: download failed" >&2
    echo "tip: cookies expected at $COOKIES_FILE" >&2
else
    echo "error: download failed (cookies present)" >&2
fi
exit 1
