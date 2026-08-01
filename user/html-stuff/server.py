#!/usr/bin/env python3

from __future__ import annotations

import argparse
import html
import subprocess
import threading
import time
from datetime import datetime
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


class ArtifactMetadata(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title_parts: list[str] = []
        self.description = ""
        self._in_document_title = False
        self._in_head = False

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        values = dict(attrs)
        if tag == "head":
            self._in_head = True
        elif tag == "title" and self._in_head:
            self._in_document_title = True
        elif (
            tag == "meta"
            and self._in_head
            and (values.get("name") or "").lower() == "description"
            and values.get("content")
        ):
            self.description = values["content"].strip()

    def handle_endtag(self, tag: str) -> None:
        if tag == "title" and self._in_document_title:
            self._in_document_title = False
        elif tag == "head":
            self._in_head = False

    def handle_data(self, data: str) -> None:
        if self._in_document_title:
            self.title_parts.append(data)

    @property
    def title(self) -> str:
        return " ".join("".join(self.title_parts).split())


def parse_metadata(path: Path) -> ArtifactMetadata:
    metadata = ArtifactMetadata()
    metadata.feed(path.read_text(encoding="utf-8"))
    metadata.close()
    return metadata


def tailscale_ipv4() -> str | None:
    try:
        result = subprocess.run(
            ["tailscale", "ip", "-4"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    return next(
        (line.strip() for line in result.stdout.splitlines() if line.strip()),
        None,
    )


def wait_for_tailscale_ipv4() -> str:
    while True:
        address = tailscale_ipv4()
        if address:
            return address
        time.sleep(5)


def artifact_rows(directory: Path) -> str:
    paths = sorted(
        (
            path
            for path in directory.iterdir()
            if path.is_file()
            and not path.is_symlink()
            and path.suffix.lower() == ".html"
            and path.name.lower() != "index.html"
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not paths:
        return '<p class="empty">no html artifacts yet.</p>'

    rows = []
    for path in paths:
        try:
            metadata = parse_metadata(path)
        except Exception:
            metadata = ArtifactMetadata()
        title = metadata.title or path.stem.replace("-", " ")
        updated = datetime.fromtimestamp(path.stat().st_mtime).astimezone()
        description = (
            f"<p>{html.escape(metadata.description)}</p>"
            if metadata.description
            else ""
        )
        rows.append(
            f"""
            <li>
              <a href="{quote(path.name)}">
                <span class="title">{html.escape(title)}</span>
                <span class="meta">
                  <time datetime="{updated.isoformat()}">{updated:%Y-%m-%d %H:%M}</time>
                  <span>{path.stat().st_size / 1024:.1f} kb</span>
                </span>
                {description}
              </a>
            </li>
            """
        )
    return "\n".join(rows)


def render_index(directory: Path) -> bytes:
    items = artifact_rows(directory)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>html stuff</title>
  <style>
    :root {{ color-scheme: dark; --bg: #000; --fg: #fff; --muted: #a1a1aa; --line: #27272a; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }}
    main {{ width: min(100% - 32px, 880px); margin: 0 auto; padding: 64px 0 96px; }}
    header {{ display: flex; align-items: baseline; justify-content: space-between; gap: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--line); }}
    h1 {{ margin: 0; font-size: clamp(32px, 8vw, 72px); letter-spacing: -.06em; line-height: .9; }}
    header p, .meta, li p, .empty {{ color: var(--muted); }}
    header p {{ margin: 0; font: 12px ui-monospace, monospace; }}
    ol {{ margin: 0; padding: 0; list-style: none; }}
    li {{ border-bottom: 1px solid var(--line); }}
    a {{ display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 24px; padding: 24px 0; color: inherit; text-decoration: none; }}
    .title {{ font-size: 20px; font-weight: 650; letter-spacing: -.025em; }}
    .meta {{ display: flex; gap: 16px; font: 11px ui-monospace, monospace; white-space: nowrap; }}
    li p {{ grid-column: 1 / -1; max-width: 70ch; margin: 0; }}
    a:focus-visible {{ outline: 2px solid var(--fg); outline-offset: 6px; }}
    @media (hover: hover) and (pointer: fine) {{ a:hover .title {{ text-decoration: underline; text-underline-offset: 4px; }} }}
    @media (max-width: 560px) {{ header, a {{ display: block; }} .meta {{ margin-top: 8px; }} li p {{ margin-top: 8px; }} }}
  </style>
</head>
<body>
  <main>
    <header><h1>html stuff</h1><p>sorted by updated date</p></header>
    <ol>{items}</ol>
  </main>
</body>
</html>
""".encode("utf-8")


class ArtifactHandler(BaseHTTPRequestHandler):
    directory: Path

    def __init__(self, *args: object, directory: Path, **kwargs: object) -> None:
        self.directory = directory
        super().__init__(*args, **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; "
            "script-src 'unsafe-inline'; "
            "style-src 'unsafe-inline'; "
            "img-src data:; "
            "font-src data:; "
            "media-src data:; "
            "connect-src 'none'; "
            "frame-src 'none'; "
            "object-src 'none'; "
            "base-uri 'none'; "
            "form-action 'none'",
        )
        super().end_headers()

    def send_html(self, content: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def artifact_path(self) -> Path | None:
        request_path = unquote(urlsplit(self.path).path).lstrip("/")
        if (
            not request_path
            or Path(request_path).name != request_path
            or Path(request_path).suffix.lower() != ".html"
            or request_path.lower() == "index.html"
        ):
            return None
        candidate = self.directory / request_path
        if not candidate.is_file() or candidate.is_symlink():
            return None
        try:
            candidate.resolve().relative_to(self.directory.resolve())
        except ValueError:
            return None
        return candidate

    def do_GET(self) -> None:
        if urlsplit(self.path).path in {"/", "/index.html"}:
            self.send_html(render_index(self.directory))
            return
        artifact = self.artifact_path()
        if artifact:
            self.send_html(artifact.read_bytes())
            return
        self.send_error(404)

    def do_HEAD(self) -> None:
        self.do_GET()

    def log_message(self, format: str, *args: object) -> None:
        return


def stop_when_address_changes(
    server: ThreadingHTTPServer,
    bound_address: str,
) -> None:
    while True:
        time.sleep(30)
        if tailscale_ipv4() != bound_address:
            server.shutdown()
            return


def main() -> int:
    parser = argparse.ArgumentParser(description="serve local html artifacts")
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    directory = args.directory.expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    bind = wait_for_tailscale_ipv4()

    def handler(*handler_args: object, **handler_kwargs: object) -> ArtifactHandler:
        return ArtifactHandler(
            *handler_args,
            directory=directory,
            **handler_kwargs,
        )

    server = ThreadingHTTPServer((bind, args.port), handler)
    print(f"serving {directory} at http://{bind}:{args.port}/", flush=True)
    threading.Thread(
        target=stop_when_address_changes,
        args=(server, bind),
        daemon=True,
    ).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
