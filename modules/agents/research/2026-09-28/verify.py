"""Offline artifact checks; these do not establish source truth or efficacy."""

import hashlib
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, unquote, urlsplit

from acquire import CHANNEL, ROOT, SELECTION, normalize, stamp


def verify(root=ROOT):
    manifest = json.loads((root / "sources/manifest.json").read_text())
    assert {item["id"] for item in manifest} == set(SELECTION)
    assert len(manifest) == len(SELECTION)
    inventory = json.loads((root / "sources/channel-inventory.json").read_text())
    assert len(inventory["entries"]) == 150
    assert set(SELECTION) <= {item["id"] for item in inventory["entries"]}
    by_id = {item["id"]: item for item in manifest}
    words = 0
    for item in manifest:
        assert item["status"] == "downloaded"
        assert item["channel_id"] == CHANNEL
        raw = (root / "sources" / item["raw_file"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == item["raw_sha256"]
        rows = normalize(json.loads(raw)["events"])
        assert rows
        times = [time for time, _ in rows]
        assert times == sorted(times)
        assert 0 <= times[0] < 10
        assert item["duration"] - 15 <= times[-1] <= item["duration"] + 2
        assert item["last_event_start_seconds"] == times[-1]
        assert item["event_count"] == len(rows)
        assert item["within_preferred_window"] == (
            "20260628" <= item["upload_date"] <= "20260928"
        )
        count = sum(len(text.split()) for _, text in rows)
        assert count == item["word_count"]
        words += count
        text = (root / "sources" / f"{item['id']}.md").read_text()
        expected = [
            f"[{stamp(time)}]({item['url']}&t={int(time)}s) {body}"
            for time, body in rows
        ]
        assert text.splitlines()[9:] == expected, item["id"]

    # Check authored markdown, not caption prose that may contain literal brackets.
    docs = [*root.glob("*.md"), *root.glob("summaries/*.md")]
    links = 0
    for path in docs:
        content = path.read_text()
        assert content.count("```") % 2 == 0, f"unclosed fence: {path}"
        targets = re.findall(r"\]\(([^)\s]+)\)", content)
        targets += re.findall(r"^\[[^]]+\]:\s+(\S+)", content, re.M)
        for target in targets:
            parsed = urlsplit(target)
            if parsed.scheme:
                if parsed.netloc in ("www.youtube.com", "youtube.com"):
                    query = parse_qs(parsed.query)
                    video_id = query.get("v", [""])[0]
                    if video_id in by_id and "t" in query:
                        time = int(query["t"][0].rstrip("s"))
                        assert 0 <= time <= by_id[video_id]["duration"], target
                continue
            destination = path.parent / unquote(parsed.path) if parsed.path else path
            assert destination.exists(), (path, target)
            if re.fullmatch(r"L\d+(-L\d+)?", parsed.fragment):
                bounds = [int(n) for n in re.findall(r"\d+", parsed.fragment)]
                assert all(
                    1 <= n <= len(destination.read_text().splitlines())
                    for n in bounds
                ), (path, target)
            links += 1
    summaries = "\n".join(
        path.read_text() for path in root.glob("summaries/*.md")
    )
    assert all(video_id in summaries for video_id in SELECTION)
    print(
        f"verified {len(manifest)} caption hashes/reading copies, "
        f"{words} words, {len(docs)} authored markdown files, "
        f"{links} local links; all videos represented in summaries"
    )
    print("not checked: audio accuracy, semantic attribution, external URLs, efficacy")


if __name__ == "__main__":
    verify()
