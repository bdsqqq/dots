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

# raycast reads this directory; the script lives in modules/media-download.
exec "$(dirname "$0")/../modules/media-download/yt-transcript.sh" "$@"
