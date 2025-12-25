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

URL="$1"
TODAY=$(date +%Y-%m-%d)
INBOX_DIR="$HOME/commonplace/02_temp/2025-12-25T16-44"

# sops-nix decrypts cookies to this path on darwin
COOKIES_FILE="/run/user/$(id -u)/secrets/cookies"

if [ -z "$URL" ]; then
    echo "Error: Please provide a URL"
    exit 1
fi

mkdir -p "$INBOX_DIR"

# Check if cookies file exists
COOKIE_ARGS=""
if [ -f "$COOKIES_FILE" ]; then
    COOKIE_ARGS="--cookies $COOKIES_FILE"
    echo "Using cookies from: $COOKIES_FILE"
fi

OUTPUT_TEMPLATE="${INBOX_DIR}/${TODAY} %(uploader,channel|unknown)s-%(title).60B-%(id)s.%(ext)s"

# First try with yt-dlp for video content
echo "Attempting video download with yt-dlp..."
if yt-dlp \
    --format "bestvideo[height<=1080]+bestaudio/best[height<=1080]" \
    --write-subs \
    --write-auto-subs \
    --sub-langs "en,en-US" \
    --embed-subs \
    --embed-thumbnail \
    --embed-metadata \
    --add-metadata \
    --merge-output-format "webm" \
    --restrict-filenames \
    $COOKIE_ARGS \
    --output "$OUTPUT_TEMPLATE" \
    "$URL" 2>/dev/null; then
    echo "Download complete"
    exit 0
fi

echo "Video download failed, trying image download with gallery-dl..."

# gallery-dl output template
GALLERY_TEMPLATE="${TODAY}_{category}_{subcategory}_{filename}.{extension}"

GALLERY_COOKIE_ARGS=""
if [ -f "$COOKIES_FILE" ]; then
    GALLERY_COOKIE_ARGS="--cookies $COOKIES_FILE"
fi

if gallery-dl \
    --directory "$INBOX_DIR" \
    --filename "$GALLERY_TEMPLATE" \
    $GALLERY_COOKIE_ARGS \
    "$URL"; then
    echo "Download complete"
    exit 0
fi

echo "Gallery-dl also failed, trying yt-dlp with different options..."

if yt-dlp \
    --embed-thumbnail \
    --embed-metadata \
    --add-metadata \
    --restrict-filenames \
    $COOKIE_ARGS \
    --output "$OUTPUT_TEMPLATE" \
    "$URL"; then
    echo "Download complete"
    exit 0
fi

if [ ! -f "$COOKIES_FILE" ]; then
    echo "Error: No file was downloaded with any method"
    echo "Tip: Cookies are expected at: $COOKIES_FILE"
else
    echo "Error: No file was downloaded even with cookies"
fi
exit 1
