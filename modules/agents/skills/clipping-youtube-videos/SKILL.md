---
name: clipping-youtube-videos
description: "Use when saving a YouTube video as a Markdown note or backfilling a saved video's metadata, description, or pinned comments. Includes transcripts and inline explanatory screenshots; not chat-only summaries, generic web clipping, or editing video files."
---

# clipping youtube videos

requires `yt-dlp`; screenshots also require `ffmpeg`. follow the destination's
naming conventions and inspect the reference clip when asked to match one.
metadata-only updates leave the body and assets unchanged.

## capture the source

fetch metadata and up to 30 top-sorted comments without replies:

```bash
yt-dlp --skip-download --write-comments \
  --extractor-args 'youtube:max_comments=30,all,0,0;comment_sort=top' \
  --dump-json 'YOUTUBE_URL' > 'TEMP_INFO.json'
```

use a fresh temporary path. reuse supplied capture data instead of fetching it
again. inspect stderr and returned fields; on failure, keep retrieved metadata
and comments, record the error, and stop retrying.

## frontmatter

put source metadata in the Markdown file, not just a sidecar or body paragraph.
use null for unavailable fields. preserve existing capture/transcript fields.

| fields | source and representation |
| --- | --- |
| `source`, `submitted_source`, `video_id` | canonical URL, original supplied URL, video ID |
| `title`, `channel`, `channel_id`, `channel_url`, `uploader_id`, `uploader_url` | source title and channel identity; `uploader_id` is the handle |
| `description` | full source text, preserving links and line breaks |
| `published`, `captured`, `duration_seconds` | upload/capture dates as quoted YYYY-MM-DD strings; duration in seconds |
| `thumbnail`, `chapters`, `tags`, `categories` | thumbnail URL; source chapter titles and start/end seconds; source lists |
| `pinned_comments` | list of `{id, author, author_url, text, url}`; exact comment text |
| `pinned_comments_capture` | `{comments_inspected, limit, sort, replies_included, captured, error}`; null error on success |

comment permalinks use `https://www.youtube.com/watch?v=VIDEO_ID&lc=COMMENT_ID`.
select only comments marked `is_pinned: true`; popularity, creator authorship,
and creator hearts are not pin evidence. use an empty list when none were
retrieved and set `pinned_comments_status` from the evidence:

- `found`: at least one explicit pin, even if fetching later failed.
- `unavailable`: no pin retrieved and comments are missing or fetching failed.
- `none_confirmed`: fetch completed and the complete relevant set has no pins.
- `not_found_in_bounded_sample`: successful bounded sample has no pins.

record actual inspected counts and retrieval errors even when a pin was found.
for example, two comments followed by HTTP 429 aren't thirty inspected comments
or proof of absence. keep any pin already retrieved; retain the error either way.

quote/escape YAML strings correctly; JSON-encoded values also work. persist only
source metadata, not the entire player response with signed media URLs.

## narration and graphics

keep the requested form: notes are not a substitute for a requested transcript.
for caption-based transcripts, use the original-language track when available,
preserve every word in order, and join fragments into paragraphs. break sections
between sentences. identify automatic captions, translations, and whether the
audio was independently checked; verbatim captions aren't verified audio.

when screenshots are requested, sample and inspect contact sheets across the
runtime. select legible, developed states of explanatory graphics/code—not an
arbitrary frame every few seconds. save frames locally beside the clip and inline
them at the relevant passages, with alt text and linked frame timestamps. retain
a video embed/source link for audio demonstrations.

## check the saved artifact

parse frontmatter and compare source fields, especially the unabridged description,
against fetched metadata. check pinned-comment status against retrieval evidence.
for preserved-caption transcripts, compare caption tokens in order, excluding
editorial headings and image captions. resolve every local image link and inspect
the chosen frames. report the saved path and any missing metadata or unverified
audio.
