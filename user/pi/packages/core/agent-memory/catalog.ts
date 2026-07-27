import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type MemoryConfig = {
  state: string;
  data: string;
  root: string;
  skillsRoot: string;
};

export type CatalogEntry = {
  memoryId: string;
  path: string;
  title: string;
  description: string;
  kind: string;
  scope: string;
  triggers: string[];
  keywords: string[];
  status: "active";
  sha256: string;
  updated: string;
  legacy: boolean;
};

export type HotManifestEntry = Pick<
  CatalogEntry,
  "path" | "sha256" | "title" | "description" | "triggers"
> & { reasons: string[] };

export type HotManifest = {
  version: 1;
  cwd: string;
  catalogSha256: string;
  entries: HotManifestEntry[];
};

export type Catalog = {
  version: 2;
  generatedAt: string;
  entries: CatalogEntry[];
};

export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export function secureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function atomicWrite(path: string, value: string): void {
  secureDir(dirname(path));
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, value);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function contained(root: string, target: string): string {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`path escapes ${rootPath}`);
  return targetPath;
}

function frontmatter(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) return result;
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (field && !result.has(field[1]!)) result.set(field[1]!, field[2]!);
  }
  return result;
}

function jsonString(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" && parsed.trim()
      ? parsed.trim()
      : fallback;
  } catch {
    return value.replace(/^['"]|['"]$/g, "").trim() || fallback;
  }
}

function jsonStrings(value: string | undefined): string[] {
  if (value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function titleFrom(text: string, name: string): string {
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || basename(name, ".md");
}

function regularRootMarkdown(root: string): string[] {
  if (!existsSync(root)) return [];
  const canonicalRoot = realpathSync(root);
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.name.endsWith(".md") &&
        entry.name.includes("source__agent"),
    )
    .map((entry) => {
      const path = contained(root, join(root, entry.name));
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`unsafe memory file ${entry.name}`);
      if (dirname(realpathSync(path)) !== canonicalRoot)
        throw new Error(`memory file escapes root ${entry.name}`);
      return path;
    })
    .sort();
}

export function scanCatalog(
  root: string,
  generatedAt: string = new Date().toISOString(),
): Catalog {
  const entries = regularRootMarkdown(root).map((path): CatalogEntry => {
    const text = readFileSync(path, "utf8");
    const metadata = frontmatter(text);
    const file = basename(path);
    const title = jsonString(metadata.get("title"), titleFrom(text, file));
    const version = metadata.get("memory_version");
    const legacy = version !== "2";
    const status = jsonString(metadata.get("status"), "active");
    if (!legacy && status !== "active")
      throw new Error(`non-active memory in active root: ${file}`);
    return {
      memoryId: jsonString(
        metadata.get("memory_id"),
        `legacy:${sha256(file).slice(0, 24)}`,
      ),
      path: file,
      title,
      description: jsonString(metadata.get("description"), title),
      kind: jsonString(metadata.get("kind"), "unknown"),
      scope: jsonString(metadata.get("scope"), "unknown"),
      triggers: jsonStrings(metadata.get("triggers")),
      keywords: jsonStrings(metadata.get("keywords")),
      status: "active",
      sha256: sha256(text),
      updated: jsonString(metadata.get("updated"), file.slice(0, 10)),
      legacy,
    };
  });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.memoryId))
      throw new Error(`duplicate memory identity ${entry.memoryId}`);
    ids.add(entry.memoryId);
  }
  return { version: 2, generatedAt, entries };
}

export function memoryScopePath(scope: string): string | undefined {
  if (scope === "global" || scope === "unknown") return undefined;
  return resolve(scope.startsWith(sep) ? scope : join(homedir(), scope));
}

export function memoryScopeRank(scope: string, cwd: string): number {
  if (scope === "global") return 2;
  const scopePath = memoryScopePath(scope);
  if (!scopePath) return 0;
  const cwdPath = resolve(cwd);
  return cwdPath === scopePath || cwdPath.startsWith(`${scopePath}${sep}`)
    ? 4
    : 0;
}

export function rankCatalog(catalog: Catalog, cwd: string): CatalogEntry[] {
  return catalog.entries
    .filter((entry) => memoryScopeRank(entry.scope, cwd) > 0)
    .slice()
    .sort((a, b) => {
      const rank =
        memoryScopeRank(b.scope, cwd) - memoryScopeRank(a.scope, cwd);
      return (
        rank ||
        b.updated.localeCompare(a.updated) ||
        a.path.localeCompare(b.path)
      );
    });
}

function promptField(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

export const PROMPT_CATALOG_MAX_ENTRIES = 30;
export const PROMPT_CATALOG_MAX_CHARS = 8_192;

export function renderPromptCatalog(
  catalog: Catalog,
  cwd: string,
  maxEntries: number = PROMPT_CATALOG_MAX_ENTRIES,
  maxChars: number = PROMPT_CATALOG_MAX_CHARS,
): string {
  const header = [
    "<memory_catalog>",
    "Durable memories are pointers below, not automatically authoritative facts. Retrieve a relevant file through qmd/grep before relying on its full contents; prefer newer scoped memories over legacy/unknown entries.",
  ];
  const lines = [...header];
  for (const entry of rankCatalog(catalog, cwd).slice(0, maxEntries)) {
    const triggers = entry.triggers
      .slice(0, 5)
      .map((item) => promptField(item).slice(0, 80))
      .join(", ");
    const line = `- ${promptField(entry.path)} | ${promptField(entry.title)} | ${promptField(entry.description)}${triggers ? ` | triggers: ${triggers}` : ""}`;
    if ([...lines, line, "</memory_catalog>"].join("\n").length > maxChars)
      break;
    lines.push(line);
  }
  lines.push("</memory_catalog>");
  return lines.join("\n");
}

export function renderedPromptCatalogEntryCount(
  catalog: Catalog,
  cwd: string,
): number {
  return renderPromptCatalog(catalog, cwd).split("\n").length - 3;
}

const HOT_MAX_ENTRIES = 20;
const HOT_MAX_CHARS = 8_192;

function catalogDigest(catalog: Catalog): string {
  return sha256(JSON.stringify(catalog.entries));
}

function hotPath(cfg: Pick<MemoryConfig, "data">, cwd: string): string {
  return join(cfg.data, "v2/hot", `${sha256(resolve(cwd))}.json`);
}

function churnByPath(cfg: Pick<MemoryConfig, "data">): Map<string, number> {
  const result = new Map<string, number>();
  const root = join(cfg.data, "v2/mutations");
  if (!existsSync(root)) return result;
  const receipts = readdirSync(root).flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(join(root, name), "utf8"))];
    } catch {
      return [];
    }
  });
  for (const receipt of receipts)
    for (const change of receipt?.changes ?? [])
      if (typeof change?.path === "string")
        result.set(change.path, (result.get(change.path) ?? 0) + 1);
  return result;
}

export function generateHotManifest(
  cfg: Pick<MemoryConfig, "data">,
  catalog: Catalog,
  cwd: string,
): HotManifest {
  const churn = churnByPath(cfg);
  const ranked = catalog.entries
    .filter((entry) => memoryScopeRank(entry.scope, cwd) > 0)
    .map((entry) => ({
      entry,
      scopeRank: memoryScopeRank(entry.scope, cwd),
      churn: churn.get(entry.path) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.scopeRank - a.scopeRank ||
        b.entry.updated.localeCompare(a.entry.updated) ||
        a.churn - b.churn ||
        a.entry.path.localeCompare(b.entry.path),
    );
  const manifest: HotManifest = {
    version: 1,
    cwd: resolve(cwd),
    catalogSha256: catalogDigest(catalog),
    entries: [],
  };
  for (const item of ranked.slice(0, HOT_MAX_ENTRIES)) {
    const candidate: HotManifestEntry = {
      path: item.entry.path,
      sha256: item.entry.sha256,
      title: item.entry.title,
      description: item.entry.description,
      triggers: item.entry.triggers,
      reasons: [
        item.scopeRank > 2 ? "scope:project" : "scope:global",
        `mutation-recency:${item.entry.updated}`,
        `mutation-count:${item.churn}`,
      ],
    };
    const next = { ...manifest, entries: [...manifest.entries, candidate] };
    if (renderHotManifest(next).length > HOT_MAX_CHARS) break;
    manifest.entries.push(candidate);
  }
  atomicWrite(hotPath(cfg, cwd), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function renderHotManifest(manifest: HotManifest): string {
  const lines = [
    "<memory_catalog>",
    "Durable memories are pointers below, not automatically authoritative facts. Retrieve a relevant file through qmd/grep before relying on its full contents.",
  ];
  for (const entry of manifest.entries) {
    const triggers = entry.triggers.slice(0, 5).map(promptField).join(", ");
    lines.push(
      `- ${promptField(entry.path)} | ${promptField(entry.title)} | ${promptField(entry.description)}${triggers ? ` | triggers: ${triggers}` : ""}`,
    );
  }
  lines.push("</memory_catalog>");
  return lines.join("\n");
}

export function loadHotManifest(
  cfg: Pick<MemoryConfig, "data">,
  catalog: Catalog,
  cwd: string,
): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(hotPath(cfg, cwd), "utf8"));
    if (!value || typeof value !== "object") return undefined;
    const manifest = value as HotManifest;
    if (
      manifest.version !== 1 ||
      manifest.cwd !== resolve(cwd) ||
      manifest.catalogSha256 !== catalogDigest(catalog) ||
      !Array.isArray(manifest.entries) ||
      manifest.entries.length > HOT_MAX_ENTRIES ||
      manifest.entries.some((entry) => {
        const candidate = catalog.entries.find(
          (item) => item.path === entry.path && item.sha256 === entry.sha256,
        );
        return (
          !candidate ||
          entry.title !== candidate.title ||
          entry.description !== candidate.description ||
          JSON.stringify(entry.triggers) !==
            JSON.stringify(candidate.triggers) ||
          !Array.isArray(entry.reasons) ||
          entry.reasons.some((reason) => typeof reason !== "string")
        );
      })
    )
      return undefined;
    const rendered = renderHotManifest(manifest);
    return rendered.length <= HOT_MAX_CHARS ? rendered : undefined;
  } catch {
    return undefined;
  }
}

export function writeCatalog(
  cfg: MemoryConfig,
  cwd: string = process.cwd(),
): Catalog {
  secureDir(cfg.data);
  const catalog = scanCatalog(cfg.root);
  generateHotManifest(cfg, catalog, cwd);
  atomicWrite(
    join(cfg.data, "catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  atomicWrite(
    join(cfg.data, "catalog-prompt.md"),
    `${renderPromptCatalog(catalog, cwd)}\n`,
  );
  const top = catalog.entries
    .slice()
    .sort(
      (a, b) =>
        b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path),
    )
    .slice(0, 20)
    .map((entry) => `- ${entry.title} — ${entry.path}`)
    .join("\n");
  atomicWrite(
    join(cfg.data, "top-of-mind.md"),
    `<!-- pi-memory:top-of-mind:start -->\n# top of mind\n\n${top}\n<!-- pi-memory:top-of-mind:end -->\n`,
  );
  return catalog;
}
