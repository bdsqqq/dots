#!/usr/bin/env python3

from __future__ import annotations

import argparse
import html
import re
import subprocess
from datetime import datetime
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

MAX_ARTIFACT_BYTES = 512 * 1024
DEFAULT_DIRECTORY = Path.home() / "commonplace/01_files/html_stuff"
VOID_ELEMENTS = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}


class ArtifactParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tags: set[str] = set()
        self.title_parts: list[str] = []
        self.description = ""
        self.external_resources: list[str] = []
        self.structural_errors: list[str] = []
        self.element_stack: list[str] = []
        self.counts = {tag: 0 for tag in ("html", "head", "title", "body")}
        self.css_parts: list[str] = []
        self.script_parts: list[str] = []
        self.doctype_count = 0
        self.phase = "start"
        self._in_title = False
        self._in_style = False
        self._in_script = False

    def handle_decl(self, decl: str) -> None:
        if decl.lower() == "doctype html":
            self.tags.add("!doctype")
            self.doctype_count += 1
            if self.phase != "start":
                self.structural_errors.append(
                    "html doctype must be the first document declaration"
                )
            self.phase = "doctype"

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.tags.add(tag)
        values = dict(attrs)
        parent = self.element_stack[-1] if self.element_stack else None
        if tag == "html":
            self.counts[tag] += 1
            if parent is not None or self.phase != "doctype":
                self.structural_errors.append(
                    "<html> must follow the doctype as the document root"
                )
            self.phase = "html"
        elif tag == "head":
            self.counts[tag] += 1
            if parent != "html" or self.phase != "html":
                self.structural_errors.append(
                    "<head> must be the first element directly inside <html>"
                )
            self.phase = "head"
        elif tag == "body":
            self.counts[tag] += 1
            if (
                parent != "html"
                or self.counts["head"] != 1
                or "head" in self.element_stack
                or self.phase != "after-head"
            ):
                self.structural_errors.append(
                    "<body> must follow </head> directly inside <html>"
                )
            self.phase = "body"
        elif tag == "title" and parent == "head":
            self.counts[tag] += 1
            self._in_title = True
        elif self.phase not in {"head", "body"}:
            self.structural_errors.append(
                f"<{tag}> is not allowed during document phase {self.phase}"
            )
        if tag not in VOID_ELEMENTS:
            self.element_stack.append(tag)
        if tag == "style":
            self._in_style = True
        if tag == "script":
            self._in_script = True
        if (
            tag == "meta"
            and (values.get("name") or "").lower() == "description"
            and values.get("content")
        ):
            self.description = values["content"].strip()

        resources: list[str] = []
        if tag == "script":
            resources.extend(
                value
                for value in (
                    values.get("src"),
                    values.get("href"),
                    values.get("xlink:href"),
                )
                if value
            )
        elif tag == "link" and {
            "stylesheet",
            "icon",
            "preload",
            "modulepreload",
        }.intersection((values.get("rel") or "").lower().split()):
            resources.append(values.get("href") or "")
        elif tag in {
            "img",
            "audio",
            "video",
            "source",
            "iframe",
            "track",
            "embed",
            "input",
        }:
            resources.append(values.get("src") or "")
        elif tag == "object":
            resources.append(values.get("data") or "")
        if tag == "video":
            resources.append(values.get("poster") or "")
        if tag in {"img", "source"} and values.get("srcset"):
            resources.extend(
                candidate.strip().split()[0]
                for candidate in values["srcset"].split(",")
                if candidate.strip()
            )
        if tag in {"image", "use", "feimage"}:
            resources.extend(
                value
                for value in (values.get("href"), values.get("xlink:href"))
                if value
            )
        if (
            tag == "meta"
            and (values.get("http-equiv") or "").lower() == "refresh"
        ):
            self.external_resources.append("meta refresh")
        if values.get("style"):
            self.css_parts.append(values["style"])
        self.external_resources.extend(
            resource
            for resource in resources
            if resource and not resource.startswith(("data:", "#"))
        )

    def handle_startendtag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.handle_starttag(tag, attrs)
        if tag in VOID_ELEMENTS:
            return
        if tag in {"svg", "math"} or any(
            parent in {"svg", "math"} for parent in self.element_stack[:-1]
        ):
            self.handle_endtag(tag)
            return
        self.structural_errors.append(
            f"self-closing syntax is not valid for html element <{tag}>"
        )

    def handle_endtag(self, tag: str) -> None:
        if tag == "title" and self._in_title:
            self._in_title = False
        if tag == "style":
            self._in_style = False
        if tag == "script":
            self._in_script = False
        if tag in VOID_ELEMENTS:
            self.structural_errors.append(f"void element <{tag}> must not be closed")
        elif not self.element_stack or self.element_stack[-1] != tag:
            self.structural_errors.append(f"unexpected closing </{tag}>")
        else:
            self.element_stack.pop()
            if tag == "head":
                self.phase = "after-head"
            elif tag == "body":
                self.phase = "after-body"
            elif tag == "html":
                if self.phase != "after-body":
                    self.structural_errors.append(
                        "</html> must follow a complete <body>"
                    )
                self.phase = "closed"

    def handle_data(self, data: str) -> None:
        if data.strip() and self.phase not in {"head", "body"}:
            self.structural_errors.append(
                f"text is not allowed during document phase {self.phase}"
            )
        if self._in_title:
            self.title_parts.append(data)
        if self._in_style:
            self.css_parts.append(data)
        if self._in_script:
            self.script_parts.append(data)

    def close(self) -> None:
        super().close()
        if self.element_stack:
            self.structural_errors.append(
                "unclosed structure: "
                + ", ".join(f"<{tag}>" for tag in self.element_stack)
            )
        if self.doctype_count != 1:
            self.structural_errors.append(
                f"expected one html doctype, found {self.doctype_count}"
            )
        for tag, count in self.counts.items():
            if count != 1:
                self.structural_errors.append(
                    f"expected one <{tag}> element, found {count}"
                )
        css = "\n".join(self.css_parts)
        css_resources = re.findall(
            r"""url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(?:url\(\s*)?['"]([^'"]+)""",
            css,
            flags=re.IGNORECASE,
        )
        for _, url_resource, import_resource in css_resources:
            resource = (url_resource or import_resource).strip()
            if resource and not resource.startswith(("data:", "#")):
                self.external_resources.append(resource)
        script = "\n".join(self.script_parts)
        network_api = re.search(
            r"\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\("
            r"|\bnavigator\s*\.\s*sendBeacon\s*\(",
            script,
        )
        if network_api:
            self.external_resources.append(
                f"network api: {network_api.group(0).strip()}"
            )

    @property
    def title(self) -> str:
        return " ".join("".join(self.title_parts).split())


def parse_artifact(path: Path) -> ArtifactParser:
    parser = ArtifactParser()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    return parser


def validate_artifact(path: Path) -> list[str]:
    errors: list[str] = []
    if not path.is_file():
        return [f"file not found: {path}"]
    if path.suffix.lower() != ".html":
        errors.append("artifact must use the .html extension")
    if path.stat().st_size > MAX_ARTIFACT_BYTES:
        errors.append(
            f"artifact is {path.stat().st_size} bytes; limit is {MAX_ARTIFACT_BYTES}"
        )

    try:
        parser = parse_artifact(path)
    except UnicodeDecodeError:
        return errors + ["artifact is not valid utf-8"]
    except Exception as error:
        return errors + [f"html parsing failed: {error}"]

    if not parser.title:
        errors.append("title must not be empty")
    errors.extend(parser.structural_errors)
    if parser.external_resources:
        errors.append(
            "external resources violate self-containment: "
            + ", ".join(parser.external_resources)
        )
    return errors


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
    return next((line.strip() for line in result.stdout.splitlines() if line.strip()), None)


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
            artifact = parse_artifact(path)
        except Exception:
            artifact = ArtifactParser()
        title = artifact.title or path.stem.replace("-", " ")
        description = artifact.description
        updated = datetime.fromtimestamp(path.stat().st_mtime).astimezone()
        href = quote(path.name)
        detail = (
            f'<p>{html.escape(description)}</p>' if description else ""
        )
        rows.append(
            f"""
            <li>
              <a href="{href}">
                <span class="title">{html.escape(title)}</span>
                <span class="meta">
                  <time datetime="{updated.isoformat()}">{updated:%Y-%m-%d %H:%M}</time>
                  <span>{path.stat().st_size / 1024:.1f} kb</span>
                </span>
                {detail}
              </a>
            </li>
            """
        )
    return "\n".join(rows)


def render_index(directory: Path) -> bytes:
    items = artifact_rows(directory)
    document = f"""<!doctype html>
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
    <header><h1>html stuff</h1><p>updated on request</p></header>
    <ol>{items}</ol>
  </main>
</body>
</html>
"""
    return document.encode("utf-8")


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


def main() -> int:
    parser = argparse.ArgumentParser(description="serve and validate local html artifacts")
    parser.add_argument("--directory", type=Path, default=DEFAULT_DIRECTORY)
    parser.add_argument("--bind", help="address to bind; defaults to tailscale or localhost")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--validate", type=Path, metavar="FILE")
    args = parser.parse_args()

    if args.validate:
        errors = validate_artifact(args.validate.expanduser())
        if errors:
            for error in errors:
                print(f"error: {error}")
            return 1
        print(f"valid: {args.validate.expanduser()}")
        return 0

    directory = args.directory.expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    bind = args.bind or tailscale_ipv4() or "127.0.0.1"
    def handler(*handler_args: object, **handler_kwargs: object) -> ArtifactHandler:
        return ArtifactHandler(
            *handler_args,
            directory=directory,
            **handler_kwargs,
        )

    server = ThreadingHTTPServer((bind, args.port), handler)
    print(f"serving {directory} at http://{bind}:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
