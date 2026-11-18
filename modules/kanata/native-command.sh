#!/bin/bash
# Native installation and launchd registration must finish before cancellation
# cleanup reconciles their result. The parent still handles Ctrl-C/SIGTERM.
trap '' INT TERM
exec "$@"
