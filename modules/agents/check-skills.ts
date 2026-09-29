import type { Skill } from "../pi/node_modules/@earendil-works/pi-coding-agent";

const { existsSync, readFileSync, readdirSync, realpathSync, statSync }: typeof import("node:fs") = require("node:fs");
const { createRequire }: typeof import("node:module") = require("node:module");
const { basename, dirname, isAbsolute, join, relative, resolve, sep }: typeof import("node:path") = require("node:path");
const { pathToFileURL }: typeof import("node:url") = require("node:url");

const sdkRequire = createRequire(resolve(__dirname, "../pi/package.json"));
// The SDK exposes an import-only entry, so require.resolve(package) rejects it.
// Use the anchored Node search paths and the package's declared import export.
const sdkName = "@earendil-works/pi-coding-agent";
const sdkManifest = (sdkRequire.resolve.paths(sdkName) ?? [])
  .map((path) => join(path, sdkName, "package.json"))
  .find((path) => existsSync(path));
if (!sdkManifest) throw new Error("pi SDK unavailable; install modules/pi dependencies first");
const sdkPackage: { exports: { ".": { import: string } } } = JSON.parse(readFileSync(sdkManifest, "utf8"));
type NativeSdk = Pick<typeof import("../pi/node_modules/@earendil-works/pi-coding-agent"),
  "loadSkills" | "parseFrontmatter">;
// Only this runtime-resolved SDK boundary needs an asserted interface.
const sdk: Promise<NativeSdk> = import(
  pathToFileURL(sdkRequire.resolve(resolve(dirname(sdkManifest), sdkPackage.exports["."].import))).href
) as Promise<NativeSdk>;
const defaultRoot = resolve(__dirname, "skills");
const validName = (name: unknown): name is string =>
  typeof name === "string" && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);

// Bounded Markdown check: inline destinations and reference definitions, not
// prose/code paths or heading IDs. This is not a Markdown renderer or route eval.
function destinations(markdown: string): string[] {
  let fence: string | undefined;
  const lines = [];
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length &&
          line.slice(marker[0].length).trim() === "") fence = undefined;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    lines.push(line);
  }
  const text = lines.join("\n").replace(/(`+)[\s\S]*?\1/g, "");
  const targets = [];
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|(?:\\.|[^()\s]|\([^()\n]*\))+)(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
    targets.push(match[1]);
  }
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm)) {
    targets.push(match[1]);
  }
  return targets;
}

export type CheckOptions = { agentDir?: string; allDocumentLinks?: boolean };
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function checkSkills(root = defaultRoot, { agentDir = root, allDocumentLinks = false }: CheckOptions = {}) {
  const { loadSkills, parseFrontmatter } = await sdk;
  root = resolve(root);
  const errors: string[] = [];
  const warnings: string[] = [];
  const entries: string[] = [];
  const markdown: string[] = [];
  const visited = new Set<string>();
  function walk(dir: string, insideSkill = false): void {
    const real = realpathSync(dir);
    if (visited.has(real)) {
      errors.push(`${dir}: repeated directory or symlink cycle`);
      return;
    }
    visited.add(real);
    const children = readdirSync(dir, { withFileTypes: true });
    const canonical = children.some((entry) => entry.name === "SKILL.md" && statSync(join(dir, entry.name)).isFile());
    if (canonical) {
      if (insideSkill) errors.push(`${dir}: nested skill is hidden from native discovery`);
      entries.push(join(dir, "SKILL.md"));
    }
    for (const entry of children) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (statSync(path).isDirectory()) walk(path, insideSkill || canonical);
      else {
        if (entry.name.toLowerCase() === "skill.md" && entry.name !== "SKILL.md")
          errors.push(`${path}: entry must be exactly SKILL.md`);
        if (entry.name.endsWith(".md")) markdown.push(path);
      }
    }
  }
  try { walk(root); } catch (error) { errors.push(`${root}: ${message(error)}`); }
  if (!entries.length) errors.push(`${root}: no canonical SKILL.md entries`);
  const names = new Set<unknown>();
  for (const path of entries) {
    try {
      const content = readFileSync(path, "utf8");
      if (!/^---\r?\n/.test(content)) errors.push(`${path}: missing frontmatter`);
      const { frontmatter } = parseFrontmatter(content);
      const { name, description } = frontmatter;
      if (!validName(name)) errors.push(`${path}: invalid name (lowercase kebab-case, max 64)`);
      if (name !== basename(dirname(path))) errors.push(`${path}: name must match directory`);
      if (names.has(name)) errors.push(`${path}: duplicate name ${name}`);
      names.add(name);
      if (typeof description !== "string" || !description.trim() || description.length > 1024)
        errors.push(`${path}: description must be nonempty text, max 1024`);
      if (frontmatter.compatibility !== undefined &&
          (typeof frontmatter.compatibility !== "string" || frontmatter.compatibility.length > 500))
        errors.push(`${path}: compatibility must be text, max 500`);
      if (frontmatter.metadata !== undefined &&
          (!frontmatter.metadata || typeof frontmatter.metadata !== "object" || Array.isArray(frontmatter.metadata) ||
           Object.values(frontmatter.metadata).some((value) => typeof value !== "string")))
        errors.push(`${path}: metadata must map strings to strings`);
    } catch (error) { errors.push(`${path}: invalid frontmatter: ${message(error)}`); }
  }
  let fragments = 0;
  const linkCounts = { entrypoint: 0, supporting: 0 };
  const source = new Set(entries);
  const skillDirs = entries.map(dirname);
  const within = (path: string, dir: string): boolean => {
    const suffix = relative(dir, path);
    return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  };
  for (const path of markdown) {
    const entrypoint = source.has(path);
    // Archives remain evidence, not executable workflow contracts. Their links
    // are reported, but only entrypoint links gate the default collection check.
    const issues = entrypoint || allDocumentLinks ? errors : warnings;
    for (let target of destinations(readFileSync(path, "utf8"))) {
      target = target.replace(/^<|>$/g, "").replace(/\\([\\()[\] ])/g, "$1");
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      if (target.includes("#")) fragments++;
      target = target.split(/[?#]/)[0];
      if (!target) continue;
      linkCounts[entrypoint ? "entrypoint" : "supporting"]++;
      try {
        target = decodeURIComponent(target);
        const destination = resolve(dirname(path), target);
        if (isAbsolute(target)) issues.push(`${path}: nonportable absolute link ${target}`);
        // Lexical installed paths intentionally allow managed skill-directory
        // symlinks and portable sibling links such as ../review/SKILL.md.
        else if (!skillDirs.some((dir) => within(destination, dir)))
          issues.push(`${path}: nonportable link outside skill resources ${target}`);
        else if (!existsSync(destination)) issues.push(`${path}: broken reference ${target}`);
      } catch (error) { issues.push(`${path}: invalid link ${target}: ${message(error)}`); }
    }
  }
  let skills: Skill[] = [];
  try {
    const result = loadSkills({ cwd: root, agentDir, skillPaths: [root], includeDefaults: false });
    skills = result.skills;
    for (const diagnostic of result.diagnostics)
      errors.push(`${diagnostic.path}: native ${diagnostic.type}: ${diagnostic.message}`);
    const discovered = new Set(skills.map((skill) => resolve(skill.filePath)));
    for (const path of source) if (!discovered.has(path)) errors.push(`${path}: source not discovered`);
    for (const path of discovered) if (!source.has(path)) errors.push(`${path}: discovered without canonical source`);
  } catch (error) { errors.push(`native loader: ${message(error)}`); }
  return { errors, warnings, skills, entries, fragments, linkCounts };
}

export type Checker = { checkSkills: typeof checkSkills; defaultRoot: string; validName: typeof validName };
module.exports = { checkSkills, defaultRoot, validName } satisfies Checker;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let root = defaultRoot;
  let allDocumentLinks = false;
  let invalid = false;
  let hasRoot = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all-document-links" && !allDocumentLinks) allDocumentLinks = true;
    else if (args[i] === "--root" && !hasRoot && args[i + 1] && !args[i + 1].startsWith("--")) {
      root = args[++i];
      hasRoot = true;
    } else invalid = true;
  }
  if (invalid) {
    console.error("usage: node --experimental-strip-types modules/agents/check-skills.ts [--root DIRECTORY] [--all-document-links]");
    process.exitCode = 2;
  } else {
    const result = await checkSkills(root, { allDocumentLinks });
    for (const error of result.errors) console.error(error);
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
    console.log(`${result.entries.length} canonical sources; ${result.skills.length} native skills; ${result.errors.length} errors; ${result.warnings.length} warnings`);
    console.log(`local file-link occurrences: ${result.linkCounts.entrypoint} entrypoint (fatal), ${result.linkCounts.supporting} supporting (${allDocumentLinks ? "fatal" : "warning only; use --all-document-links to enforce"})`);
    console.log(`heading fragments not checked (${result.fragments}); URLs skipped; static contract only, not model routing`);
    process.exitCode = result.errors.length ? 1 : 0;
  }
}

if (require.main === module) void main().catch((error: unknown) => {
  console.error(message(error));
  process.exitCode = 1;
});
