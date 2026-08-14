#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title connect iPad display
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 🖥️
# @raycast.packageName displays

# Documentation:
# @raycast.description Connect the selected iPad using Sidecar
# @raycast.author bdsqqq

exec /etc/profiles/per-user/bdsqqq/bin/ipad-display connect
