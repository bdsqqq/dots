#!/bin/bash -l

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title download media
# @raycast.mode compact

# Optional parameters:
# @raycast.icon ↴
# @raycast.argument1 { "type": "text", "placeholder": "URL" }
# @raycast.packageName media_utils

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
  -d, --dir DIR      output directory (default: ~/commonplace/00_inbox)
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
INBOX_DIR="$HOME/commonplace/00_inbox"
DRY_RUN=false
VERBOSE=false
URL=""

log() { [[ "$VERBOSE" = true ]] && echo "$@" >&2 || true; }

# sops-nix decrypts cookies to this path on darwin
COOKIES_FILE="/run/user/$(id -u)/secrets/cookies"

# parse args
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
            URL="$1"
            shift
            ;;
    esac
done

if [ -z "$URL" ]; then
    echo "error: no url provided" >&2
    usage >&2
    exit 1
fi

mkdir -p "$INBOX_DIR"

# use array so empty expands to nothing, not empty string arg
cookie_args=()
if [ -f "$COOKIES_FILE" ]; then
    cookie_args=(--cookies "$COOKIES_FILE")
    log "using cookies: $COOKIES_FILE"
fi

dry_run_args=()
if [ "$DRY_RUN" = true ]; then
    dry_run_args=(--simulate --print filename)
    log "dry run mode"
fi

OUTPUT_TEMPLATE="${INBOX_DIR}/${TODAY} %(uploader,channel|unknown)s-%(title).60B-%(id)s.%(ext)s"

log "trying yt-dlp..."
if OUTPUT=$(yt-dlp \
    --format "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best" \
    --write-subs \
    --write-auto-subs \
    --sub-langs "en,en-US,pt-BR" \
    --embed-subs \
    --embed-thumbnail \
    --embed-metadata \
    --add-metadata \
    --merge-output-format "webm" \
    --restrict-filenames \
    --print after_move:filepath \
    "${cookie_args[@]}" \
    "${dry_run_args[@]}" \
    --output "$OUTPUT_TEMPLATE" \
    -- "$URL" 2>/dev/null); then
    echo "$OUTPUT"
    exit 0
fi

log "yt-dlp failed, trying gallery-dl..."

GALLERY_TEMPLATE="${TODAY}_{category}_{subcategory}_{filename}.{extension}"

gallery_dry_run_args=()
if [ "$DRY_RUN" = true ]; then
    gallery_dry_run_args=(--simulate)
fi

if OUTPUT=$(gallery-dl \
    --directory "$INBOX_DIR" \
    --filename "$GALLERY_TEMPLATE" \
    --print "{_path}" \
    --quiet \
    "${cookie_args[@]}" \
    "${gallery_dry_run_args[@]}" \
    -- "$URL" 2>/dev/null); then
    echo "$OUTPUT"
    exit 0
fi

if [ ! -f "$COOKIES_FILE" ]; then
    echo "error: download failed" >&2
    echo "tip: cookies expected at $COOKIES_FILE" >&2
else
    echo "error: download failed (cookies present)" >&2
fi
exit 1
