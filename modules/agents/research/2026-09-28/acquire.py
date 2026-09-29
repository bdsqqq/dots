"""Acquire a bounded research corpus, not an installed agent workflow.

Keep caption events and extraction metadata beside timestamped reading copies:
automatic captions are evidence of wording, not verified speaker attribution.
Never download video/audio or use browser cookies implicitly.
"""

import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
CHANNEL = "UCbRP3c757lWg9M-U7TyEkXA"
SELECTION = {
    "e1snsuY4lTI": "global/project instructions and skill authoring",
    "0oXOOlqVu5M": "hands-on evaluation of another author's skill workflow",
    "Jf54k7tFeEc": "memory and context failure modes",
    "q1D90-uGvBg": "agent usage and delegation",
    "5KvY8CnBB3w": "codebase understanding and investigation",
    "NvVbCqDgfCs": "personal workflow and voice input",
    "ejjBbaq9RmY": "recent model-specific operating advice",
    "iBrAWpjXNxs": "model selection and quality/cost tradeoffs",
    "0wemf5SZkW4": "workflow advice, distinguish Theo from discussed sources",
    "xmGY276gEFY": "agent creator's workflow advice, distinguish attribution",
    "434cG4g5KLE": "durable code and agent verification",
    "dLhcLqoff6k": "human supervision and agent interface",
    "iJVJwmCKW9o": "loops and autonomous workflow boundaries",
    "xJaMTo2YgO8": "older workflow baseline, explicit recency exception",
    "S9EGx6ik-18": "older artifact-format baseline, explicit recency exception",
}


def run(args):
    return subprocess.run(
        ["yt-dlp", "--ignore-config", "--no-update", "--socket-timeout", "20",
         "--retries", "1", *args],
        capture_output=True, text=True, timeout=100,
    )


def stamp(seconds):
    seconds = int(seconds)
    return f"{seconds // 3600:02}:{seconds // 60 % 60:02}:{seconds % 60:02}"


def normalize(events):
    """JSON3 word events avoid the rolling overlapping windows in VTT output."""
    rows = []
    for event in events:
        if "segs" not in event:
            continue
        text = " ".join(
            "".join(segment.get("utf8", "") for segment in event["segs"]).split()
        )
        if text:
            rows.append((event["tStartMs"] / 1000, text))
    return rows


def acquire():
    source = ROOT / "sources"
    source.mkdir(exist_ok=True)
    inventory = run([
        "--flat-playlist", "--playlist-end", "150", "--dump-single-json",
        "https://www.youtube.com/@t3dotgg/videos",
    ])
    inventory.check_returncode()
    entries = json.loads(inventory.stdout)["entries"]
    (source / "channel-inventory.json").write_text(json.dumps({
        "retrieved_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "url": "https://www.youtube.com/@t3dotgg/videos",
        "scope": "latest 150 uploads, excludes separate streams and shorts tabs",
        "entries": [
            {key: item.get(key) for key in ("id", "title", "url", "duration")}
            for item in entries
        ],
    }, indent=2) + "\n")
    results = []
    for video_id, rationale in SELECTION.items():
        url = f"https://www.youtube.com/watch?v={video_id}"
        result = {"id": video_id, "url": url, "selection_reason": rationale}
        try:
            meta_run = run(["--skip-download", "--dump-single-json", url])
            meta_run.check_returncode()
            metadata = json.loads(meta_run.stdout)
            assert metadata["channel_id"] == CHANNEL, "unexpected channel"
            result.update({
                key: metadata.get(key)
                for key in ("title", "upload_date", "duration", "channel_id",
                            "channel", "description", "chapters", "timestamp")
            })
            result["within_preferred_window"] = (
                "20260628" <= result["upload_date"] <= "20260928"
            )
            language = (
                "en-orig" if "en-orig" in metadata.get("automatic_captions", {})
                else "en"
            )
            captions = run([
                "--skip-download", "--write-auto-subs", "--sub-langs", language,
                "--sub-format", "json3", "--no-progress",
                "-o", str(source / f"{video_id}.%(ext)s"), url,
            ])
            result["download_log"] = captions.stdout + captions.stderr
            captions.check_returncode()
            raw = source / f"{video_id}.{language}.json3"
            body = raw.read_bytes()
            parsed = json.loads(body)
            rows = normalize(parsed["events"])
            assert rows, "empty captions"
            result.update({
                "status": "downloaded",
                "caption_kind": "youtube automatic",
                "language": language,
                "raw_file": raw.name,
                "raw_sha256": hashlib.sha256(body).hexdigest(),
                "event_count": len(rows),
                "last_event_start_seconds": rows[-1][0],
                "word_count": sum(len(text.split()) for _, text in rows),
            })
            lines = [
                f"# {result['title']}", "",
                f"source: {url}",
                f"youtube upload_date (UTC): {result['upload_date']}",
                f"duration: {stamp(result['duration'])}",
                f"captions: youtube automatic, {language}; not human-verified.",
                "speaker changes, proper names, and punctuation may be wrong.",
                "timestamps are caption start times; no editorial summarization.",
                "",
            ]
            lines.extend(
                f"[{stamp(time)}]({url}&t={int(time)}s) {text}"
                for time, text in rows
            )
            (source / f"{video_id}.md").write_text("\n".join(lines) + "\n")
        except Exception as exc:
            result.update({"status": "failed", "error": str(exc)})
        result["retrieved_at"] = datetime.datetime.now(
            datetime.timezone.utc
        ).isoformat()
        results.append(result)
        (source / "manifest.json").write_text(
            json.dumps(results, indent=2, ensure_ascii=False) + "\n"
        )
        print(json.dumps({
            key: result.get(key)
            for key in ("id", "title", "upload_date", "status", "word_count", "error")
        }), flush=True)
    return 0 if all(row["status"] == "downloaded" for row in results) else 1


if __name__ == "__main__":
    sys.exit(acquire())
