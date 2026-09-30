"""Bounded caption acquisition; no cookies, media, or edits to prior evidence."""

import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
PREVIOUS = ROOT.parent.parent / "2026-09-28"
spec = importlib.util.spec_from_file_location("previous_acquire", PREVIOUS / "acquire.py")
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def inventory_path(video_id):
    old = PREVIOUS / "sources/channel-inventory.json"
    if video_id in {entry["id"] for entry in json.loads(old.read_bytes())["entries"]}:
        return "../../2026-09-28/sources/channel-inventory.json"
    return "channel-inventory-latest8.json"


def acquire(video_id):
    url = f"https://www.youtube.com/watch?v={video_id}"
    metadata_run = previous.run(["--skip-download", "--dump-single-json", url])
    metadata_run.check_returncode()
    metadata_file = ROOT / f"{video_id}.metadata.json"
    metadata_file.write_bytes(metadata_run.stdout.encode())
    metadata = json.loads(metadata_run.stdout)
    assert metadata["channel_id"] == previous.CHANNEL
    language = "en-orig" if "en-orig" in metadata["automatic_captions"] else "en"
    args = [
        "yt-dlp", "--ignore-config", "--no-update", "--socket-timeout", "20",
        "--retries", "0", "--skip-download", "--write-auto-subs",
        "--sub-langs", language, "--sub-format", "json3", "--no-progress",
        "-o", str(ROOT / f"{video_id}.%(ext)s"), url,
    ]
    result = subprocess.run(args, capture_output=True, timeout=100)
    (ROOT / f"{video_id}.download.log").write_bytes(result.stdout + result.stderr)
    result.check_returncode()
    raw = ROOT / f"{video_id}.{language}.json3"
    rows = previous.normalize(json.loads(raw.read_bytes())["events"])
    manifest = {
        "id": video_id, "url": url, "title": metadata["title"],
        "upload_date": metadata["upload_date"], "duration": metadata["duration"],
        "channel_id": metadata["channel_id"], "caption_kind": "youtube automatic",
        "language": language, "raw_file": raw.name,
        "raw_sha256": sha(raw.read_bytes()), "metadata_file": metadata_file.name,
        "metadata_sha256": sha(metadata_file.read_bytes()),
        "inventory_file": inventory_path(video_id),
        "inventory_sha256": sha((ROOT / inventory_path(video_id)).read_bytes()),
        "retrieved_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "command": args, "event_count": len(rows),
        "word_count": sum(len(text.split()) for _, text in rows),
        "first_event_start_seconds": rows[0][0],
        "last_event_start_seconds": rows[-1][0],
    }
    (ROOT / f"{video_id}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    header = [
        f"# {metadata['title']}", "", f"source: {url}",
        f"youtube upload_date (UTC): {metadata['upload_date']}",
        f"duration: {previous.stamp(metadata['duration'])}",
        f"captions: youtube automatic, {language}; not human-verified.",
        "speaker changes, proper names, and punctuation may be wrong.",
        "timestamps are caption start times; no editorial summarization.", "",
    ]
    (ROOT / f"{video_id}.md").write_text("\n".join(header + [
        f"[{previous.stamp(time)}]({url}&t={int(time)}s) {text}" for time, text in rows
    ]) + "\n")
    verify(video_id)


def verify(video_id, root=ROOT):
    item = json.loads((root / f"{video_id}.manifest.json").read_bytes())
    for kind in ("raw", "metadata"):
        assert sha((root / item[f"{kind}_file"]).read_bytes()) == item[f"{kind}_sha256"]
    assert sha((ROOT / item["inventory_file"]).read_bytes()) == item["inventory_sha256"]
    inventory = json.loads((ROOT / item["inventory_file"]).read_bytes())
    assert video_id in {entry["id"] for entry in inventory["entries"]}
    metadata = json.loads((root / item["metadata_file"]).read_bytes())
    assert metadata["id"] == video_id
    assert metadata["channel_id"] == item["channel_id"] == previous.CHANNEL
    assert metadata["duration"] == item["duration"]
    rows = previous.normalize(json.loads((root / item["raw_file"]).read_bytes())["events"])
    times = [time for time, _ in rows]
    assert times == sorted(times)
    assert 0 <= times[0] < 10
    assert item["duration"] - 15 <= times[-1] <= item["duration"] + 2
    assert len(rows) == item["event_count"]
    assert sum(len(text.split()) for _, text in rows) == item["word_count"]
    assert times[0] == item["first_event_start_seconds"]
    assert times[-1] == item["last_event_start_seconds"]
    assert (root / f"{video_id}.md").read_text().splitlines()[9:] == [
        f"[{previous.stamp(time)}]({item['url']}&t={int(time)}s) {text}"
        for time, text in rows
    ]
    print(json.dumps(item, indent=2))


if __name__ == "__main__":
    (verify if sys.argv[1] == "verify" else acquire)(sys.argv[2])
