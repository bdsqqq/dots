# media-download

Raycast script commands for grabbing media and transcripts by URL.
`download-media.sh` tries yt-dlp, then gallery-dl; `yt-transcript.sh` writes a
YouTube transcript to markdown with frontmatter. Both read cookies from
`/run/secrets/cookies` (`modules/media-cookies`) when present.

Raycast finds them through the symlinks in `scripts/`.
