import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "media-src data:",
    "connect-src 'self'",
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
const stateFileArgument = Bun.argv.includes("--state-file")
  ? argument("--state-file")
  : undefined;
if (stateFileArgument && (!isAbsolute(stateFileArgument) || extname(stateFileArgument).toLowerCase() === ".html")) {
  throw new Error("--state-file must be an absolute non-HTML path");
}
const stateFile = stateFileArgument ? resolve(stateFileArgument) : undefined;
const stateOrigin = Bun.argv.includes("--state-origin")
  ? new URL(argument("--state-origin")).origin
  : undefined;
const STATE_ROUTE = "/api/pi-setup-dossier/state";
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_STATE_BYTES + 64;
await mkdir(root, { recursive: true });

interface DossierState {
  version: 1;
  revision: number;
  fields: Record<string, boolean | string>;
}

const EMPTY_STATE: DossierState = { version: 1, revision: 0, fields: {} };
const MISSING_ETAG = '"missing-v1"';
let stateQueue: Promise<void> = Promise.resolve();

function validState(value: unknown): value is DossierState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0 ||
    !candidate.fields ||
    typeof candidate.fields !== "object" ||
    Array.isArray(candidate.fields)
  ) return false;
  const fields = candidate.fields as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length > 4096) return false;
  return keys.every((key) =>
    /^(decision|requirement|test|note|source):[a-z0-9:._-]{1,120}$/.test(key) &&
    (typeof fields[key] === "boolean" ||
      (typeof fields[key] === "string" && fields[key].length <= 10_000))
  );
}

function stateETag(bytes: Uint8Array): string {
  return `"${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}"`;
}

async function readState(): Promise<{ bytes: Uint8Array; etag: string; state: DossierState }> {
  if (!stateFile) throw new Error("state disabled");
  let handle;
  try {
    handle = await open(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const bytes = Buffer.from(JSON.stringify(EMPTY_STATE));
      return { bytes, etag: MISSING_ETAG, state: EMPTY_STATE };
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error("invalid state file");
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_STATE_BYTES) throw new Error("invalid state file");
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("invalid state file"); }
    if (!validState(parsed)) throw new Error("invalid state file");
    return { bytes, etag: stateETag(bytes), state: parsed };
  } finally {
    await handle.close();
  }
}

function stateResponse(body: string, status: number, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { ...COMMON_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

async function boundedBody(request: Request): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function putState(request: Request): Promise<Response> {
  if (!stateFile) return stateResponse('{"error":"not found"}', 404);
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) return stateResponse('{"error":"content type required"}', 415);
  const origin = request.headers.get("origin");
  const allowedOrigin = stateOrigin ?? new URL(request.url).origin;
  if (origin !== allowedOrigin) return stateResponse('{"error":"origin rejected"}', 403);
  if (request.headers.get("x-dossier-client") !== "1") return stateResponse('{"error":"client header required"}', 400);
  const ifMatch = request.headers.get("if-match");
  if (!ifMatch) return stateResponse('{"error":"if-match required"}', 428);
  const bytes = await boundedBody(request);
  if (!bytes) return stateResponse('{"error":"request too large"}', 413);
  if (bytes.byteLength > MAX_STATE_BYTES) return stateResponse('{"error":"state too large"}', 413);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return stateResponse('{"error":"invalid json"}', 400); }
  if (!validState(parsed)) return stateResponse('{"error":"invalid state"}', 400);

  let release!: () => void;
  const previous = stateQueue;
  stateQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    let current: Awaited<ReturnType<typeof readState>>;
    try { current = await readState(); }
    catch { return stateResponse('{"error":"state unavailable"}', 500); }
    if (ifMatch !== current.etag) return stateResponse('{"error":"state changed"}', 412, { ETag: current.etag });
    if (parsed.revision !== current.state.revision + 1) return stateResponse('{"error":"revision mismatch"}', 409, { ETag: current.etag });
    const output = Buffer.from(JSON.stringify(parsed));
    if (output.byteLength > MAX_STATE_BYTES) return stateResponse('{"error":"state too large"}', 413);
    // Recheck just before replace; external writers can still race this check.
    let latest: Awaited<ReturnType<typeof readState>>;
    try { latest = await readState(); }
    catch { return stateResponse('{"error":"state unavailable"}', 500); }
    if (latest.etag !== current.etag) return stateResponse('{"error":"state changed"}', 412, { ETag: latest.etag });
    const temporary = join(resolve(stateFile, ".."), `.${basename(stateFile)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let tempHandle;
    try {
      tempHandle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await tempHandle.writeFile(output);
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = undefined;
      await rename(temporary, stateFile);
    } catch {
      if (tempHandle) await tempHandle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      return stateResponse('{"error":"state write failed"}', 500);
    }
    const etag = stateETag(output);
    return stateResponse(JSON.stringify(parsed), 200, { ETag: etag });
  } finally {
    release();
  }
}

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
  maxRequestBodySize: MAX_REQUEST_BYTES,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === STATE_ROUTE) {
      if (!stateFile) return stateResponse('{"error":"not found"}', 404);
      if (request.method === "GET" || request.method === "HEAD") {
        try {
          const current = await readState();
          return stateResponse(request.method === "HEAD" ? "" : JSON.stringify(current.state), 200, { ETag: current.etag });
        } catch {
          return stateResponse('{"error":"state unavailable"}', 500);
        }
      }
      if (request.method === "PUT") return putState(request);
      return stateResponse('{"error":"method not allowed"}', 405, { Allow: "GET, HEAD, PUT" });
    }
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
