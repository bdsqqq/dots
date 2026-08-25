import { constants } from "node:fs";
import { mkdir, open, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "media-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
};

function argument(name: string, fallback?: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : fallback;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const root = resolve(argument("--directory"));
const port = Number.parseInt(argument("--port", "8766"), 10);
await mkdir(root, { recursive: true });

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

function decodeEntities(value: string): string {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  } as const;
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|quot));/gi,
    (entity, decimal: string, hexadecimal: string, name: keyof typeof named) => {
      const codePoint = decimal
        ? Number.parseInt(decimal, 10)
        : Number.parseInt(hexadecimal, 16);
      if (
        Number.isInteger(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return String.fromCodePoint(codePoint);
      }
      if (!name) return entity;
      return named[name.toLowerCase() as keyof typeof named];
    },
  );
}

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let cursor = 1;
  while (
    cursor < tag.length &&
    !isSpace(tag[cursor]) &&
    tag[cursor] !== ">" &&
    tag[cursor] !== "/"
  ) {
    cursor++;
  }

  while (cursor < tag.length) {
    while (isSpace(tag[cursor])) cursor++;
    if (tag[cursor] === ">" || tag[cursor] === "/") break;
    const nameStart = cursor;
    while (
      cursor < tag.length &&
      !isSpace(tag[cursor]) &&
      !["=", ">", "/"].includes(tag[cursor])
    ) {
      cursor++;
    }
    const name = tag.slice(nameStart, cursor).toLowerCase();
    while (isSpace(tag[cursor])) cursor++;
    if (tag[cursor] !== "=") {
      if (name) attributes.set(name, "");
      continue;
    }
    cursor++;
    while (isSpace(tag[cursor])) cursor++;

    const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor++] : null;
    const valueStart = cursor;
    if (quote) {
      while (cursor < tag.length && tag[cursor] !== quote) cursor++;
    } else {
      while (cursor < tag.length && !isSpace(tag[cursor]) && tag[cursor] !== ">") {
        cursor++;
      }
    }
    if (name) attributes.set(name, tag.slice(valueStart, cursor));
    if (quote && tag[cursor] === quote) cursor++;
  }
  return attributes;
}

function findTag(source: string, name: string, from = 0): number {
  const needle = `<${name}`;
  let cursor = from;
  while ((cursor = source.indexOf(needle, cursor)) >= 0) {
    const boundary = source[cursor + needle.length];
    if (boundary === ">" || boundary === "/" || isSpace(boundary)) return cursor;
    cursor += needle.length;
  }
  return -1;
}

function metadata(document: string): { description: string; title: string } {
  const prefix = document.slice(0, 64 * 1024);
  const lower = prefix.toLowerCase();
  const headEnd = lower.indexOf("</head");
  const source = headEnd >= 0 ? prefix.slice(0, headEnd) : prefix;
  const sourceLower = headEnd >= 0 ? lower.slice(0, headEnd) : lower;

  let title = "";
  const titleStart = findTag(sourceLower, "title");
  if (titleStart >= 0) {
    const contentStart = sourceLower.indexOf(">", titleStart);
    const contentEnd =
      contentStart >= 0 ? sourceLower.indexOf("</title", contentStart + 1) : -1;
    if (contentStart >= 0 && contentEnd >= 0) {
      title = decodeEntities(source.slice(contentStart + 1, contentEnd).trim());
    }
  }

  let cursor = 0;
  while ((cursor = findTag(sourceLower, "meta", cursor)) >= 0) {
    const end = sourceLower.indexOf(">", cursor);
    if (end < 0) break;
    const attributes = parseAttributes(source.slice(cursor, end + 1));
    if (attributes.get("name")?.toLowerCase() === "description") {
      return {
        description: decodeEntities(attributes.get("content") ?? ""),
        title,
      };
    }
    cursor = end + 1;
  }
  return { description: "", title };
}

interface Artifact {
  description: string;
  href: string;
  size: number;
  title: string;
  updated: Date;
}

async function readArtifact(name: string): Promise<{
  contents: Buffer;
  size: number;
  updated: Date;
}> {
  const handle = await open(
    join(root, name),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error("artifact is not a regular file");
    return {
      contents: await handle.readFile(),
      size: fileStat.size,
      updated: fileStat.mtime,
    };
  } finally {
    await handle.close();
  }
}

async function artifacts(): Promise<Artifact[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const rows = await Promise.all(
    entries.map(async (entry): Promise<Artifact | null> => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        extname(entry.name).toLowerCase() !== ".html" ||
        entry.name.toLowerCase() === "index.html"
      ) {
        return null;
      }
      try {
        const file = await readArtifact(entry.name);
        const parsed = metadata(file.contents.toString("utf8"));
        return {
          description: parsed.description,
          href: encodeURIComponent(entry.name),
          size: file.size,
          title: parsed.title || entry.name.replace(/\.html$/i, "").replaceAll("-", " "),
          updated: file.updated,
        };
      } catch {
        return null;
      }
    }),
  );
  return rows
    .filter((artifact): artifact is Artifact => artifact !== null)
    .sort((left, right) => right.updated.getTime() - left.updated.getTime());
}

async function renderIndex(): Promise<string> {
  const items = await artifacts();
  const rows = items.length
    ? items
        .map(
          (artifact) => `
            <li>
              <a href="${artifact.href}">
                <span class="title">${escapeHtml(artifact.title)}</span>
                <span class="meta">
                  <time datetime="${artifact.updated.toISOString()}">${artifact.updated.toLocaleString()}</time>
                  <span>${(artifact.size / 1024).toFixed(1)} kb</span>
                </span>
                ${artifact.description ? `<p>${escapeHtml(artifact.description)}</p>` : ""}
              </a>
            </li>`,
        )
        .join("")
    : '<p class="empty">no html artifacts yet.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>html stuff</title>
  <style>
    :root { color-scheme: dark; --bg: #000; --fg: #fff; --muted: #a1a1aa; --line: #27272a; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
    main { width: min(100% - 32px, 880px); margin: 0 auto; padding: 64px 0 96px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: clamp(32px, 8vw, 72px); letter-spacing: -.06em; line-height: .9; }
    header p, .meta, li p, .empty { color: var(--muted); }
    header p { margin: 0; font: 12px ui-monospace, monospace; }
    ol { margin: 0; padding: 0; list-style: none; }
    li { border-bottom: 1px solid var(--line); }
    a { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 24px; padding: 24px 0; color: inherit; text-decoration: none; }
    .title { font-size: 20px; font-weight: 650; letter-spacing: -.025em; }
    .meta { display: flex; gap: 16px; font: 11px ui-monospace, monospace; white-space: nowrap; }
    li p { grid-column: 1 / -1; max-width: 70ch; margin: 0; }
    a:focus-visible { outline: 2px solid var(--fg); outline-offset: 6px; }
    @media (hover: hover) and (pointer: fine) { a:hover .title { text-decoration: underline; text-underline-offset: 4px; } }
    @media (max-width: 560px) { header, a { display: block; } .meta { margin-top: 8px; } li p { margin-top: 8px; } }
  </style>
</head>
<body>
  <main>
    <header><h1>html stuff</h1><p>sorted by updated date</p></header>
    <ol>${rows}</ol>
  </main>
</body>
</html>`;
}

function response(
  body: BodyInit | null,
  status = 200,
  contentType = "text/html; charset=utf-8",
): Response {
  return new Response(body, {
    status,
    headers: { ...COMMON_HEADERS, "Content-Type": contentType },
  });
}

function artifactName(pathname: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
  if (
    !name ||
    basename(name) !== name ||
    extname(name).toLowerCase() !== ".html" ||
    name.toLowerCase() === "index.html"
  ) {
    return null;
  }
  return name;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/" || pathname === "/index.html") {
      return response(request.method === "HEAD" ? null : await renderIndex());
    }
    const name = artifactName(pathname);
    if (!name) return response("not found\n", 404, "text/plain; charset=utf-8");
    try {
      const artifact = await readArtifact(name);
      return response(request.method === "HEAD" ? null : artifact.contents);
    } catch {
      return response("not found\n", 404, "text/plain; charset=utf-8");
    }
  },
});

console.log(`serving ${root} at ${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop(true);
    process.exit(0);
  });
}
