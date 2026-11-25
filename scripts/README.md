# scripts

Raycast's script-command directory on mbp-m2 points here. Raycast reads the
`@raycast` header of each file in this directory, so each command is a small
stub carrying that header and exec'ing the real script in the module that
owns it. Change the script there; change the header here.

| command | owner |
|---|---|
| `download-media.sh` | `modules/media-download/download-media.sh` |
| `yt_transcript.sh` | `modules/media-download/yt-transcript.sh` |
