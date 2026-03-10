import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SECRET_PATTERNS = [/^\.env$/, /^\.env\..+$/];
const SECRET_EXCEPTIONS = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);

/**
 * normalizes the path shorthands our local tools already accept.
 *
 * this keeps the path contract in one place so file-aware tools do not drift on
 * `@` prefix stripping or `~` expansion.
 */
export function expandPath(filePath: string): string {
  const stripped = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (stripped === "~") return os.homedir();
  if (stripped.startsWith("~/")) return os.homedir() + stripped.slice(1);
  return stripped;
}

export function resolveToAbsolute(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

/**
 * preserves the read tool's existing mac-friendly fallback order.
 *
 * callers already rely on this being tolerant of unicode normalization drift and
 * Finder-style narrow no-break spaces in timestamped names.
 */
function resolveWithVariantsUsing(
  filePath: string,
  cwd: string,
  exists: (candidate: string) => boolean,
): string {
  const resolved = resolveToAbsolute(filePath, cwd);
  if (exists(resolved)) return resolved;

  const amPm = resolved.replace(/ (AM|PM)\./g, `\u202F$1.`);
  if (amPm !== resolved && exists(amPm)) return amPm;

  const nfd = resolved.normalize("NFD");
  if (nfd !== resolved && exists(nfd)) return nfd;

  return resolved;
}

export function resolveWithVariants(filePath: string, cwd: string): string {
  return resolveWithVariantsUsing(filePath, cwd, (candidate) =>
    fs.existsSync(candidate),
  );
}

export function isSecretFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (SECRET_EXCEPTIONS.has(basename)) return false;
  return SECRET_PATTERNS.some((p) => p.test(basename));
}

/**
 * keeps directory formatting out of individual tools so `read` and `ls` render
 * the same entries and truncation notices.
 */
function headTailList(items: string[], maxItems: number): string[] {
  if (items.length <= maxItems) return items;
  const half = Math.floor(maxItems / 2);
  return [
    ...items.slice(0, half),
    "",
    `... [${items.length - half * 2} more entries] ...`,
    "",
    ...items.slice(-half),
  ];
}

export function listDirectory(dirPath: string, maxEntries: number): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err: any) {
    throw new Error(`cannot list directory: ${err.message}`);
  }

  const names = entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => a.localeCompare(b));

  return headTailList(names, maxEntries).join("\n");
}

export interface WalkDirOptions {
  filter?(entry: fs.Dirent, absolutePath: string): boolean;
  stopWhen?(entry: fs.Dirent, absolutePath: string): boolean;
}

/**
 * tiny recursive walker for local package internals.
 *
 * this is intentionally literal: no hidden ignore rules, no async layer, no
 * glob language. callers keep ownership of filtering and early-stop policy.
 */
export function walkDirSync(
  rootDir: string,
  options: WalkDirOptions = {},
): string[] {
  const matches: string[] = [];

  const walk = (dir: string): boolean => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);

      if (options.stopWhen?.(entry, absolutePath)) {
        matches.push(absolutePath);
        return true;
      }

      if (options.filter?.(entry, absolutePath)) {
        matches.push(absolutePath);
      }

      if (entry.isDirectory() && walk(absolutePath)) {
        return true;
      }
    }

    return false;
  };

  walk(rootDir);
  return matches;
}

// inline tests live here so the helper seam can move without depending on the
// read tool package for coverage.
if (import.meta.vitest) {
  const { afterEach, describe, expect, it } = import.meta.vitest;
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = fs;
  const { join } = path;
  const tmpRoots: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-fs-"));
    tmpRoots.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("expandPath", () => {
    it("strips @ prefix", () => {
      expect(expandPath("@/foo/bar")).toBe("/foo/bar");
    });

    it("expands ~ to homedir", () => {
      expect(expandPath("~")).toBe(os.homedir());
    });

    it("expands ~/ to homedir + path", () => {
      expect(expandPath("~/foo")).toBe(os.homedir() + "/foo");
    });

    it("returns unchanged path without prefix", () => {
      expect(expandPath("/absolute/path")).toBe("/absolute/path");
      expect(expandPath("relative/path")).toBe("relative/path");
    });
  });

  describe("resolveToAbsolute", () => {
    it("returns absolute paths unchanged", () => {
      expect(resolveToAbsolute("/foo/bar", "/cwd")).toBe("/foo/bar");
    });

    it("resolves relative paths against cwd", () => {
      expect(resolveToAbsolute("foo/bar", "/cwd")).toBe("/cwd/foo/bar");
    });

    it("expands ~ before resolving", () => {
      expect(resolveToAbsolute("~/foo", "/cwd")).toBe(os.homedir() + "/foo");
    });
  });

  describe("resolveWithVariants", () => {
    it("returns the existing resolved path unchanged", () => {
      const dir = makeTmpDir();
      const file = join(dir, "plain.txt");
      writeFileSync(file, "x");

      expect(resolveWithVariants(file, "/cwd")).toBe(file);
    });

    it("falls back to narrow no-break space am/pm names", () => {
      const dir = makeTmpDir();
      const variant = join(dir, "meeting\u202FPM.txt");
      writeFileSync(variant, "x");

      expect(resolveWithVariants(join(dir, "meeting PM.txt"), "/cwd")).toBe(
        variant,
      );
    });

    it("falls back to nfd-normalized names", () => {
      const requested = "/tmp/café.txt";
      const variant = requested.normalize("NFD");

      expect(
        resolveWithVariantsUsing(
          requested,
          "/cwd",
          (candidate) => candidate === variant,
        ),
      ).toBe(variant);
    });
  });

  describe("isSecretFile", () => {
    it("blocks .env files", () => {
      expect(isSecretFile("/home/user/.env")).toBe(true);
      expect(isSecretFile("/home/user/.env.local")).toBe(true);
      expect(isSecretFile("/home/user/.env.production")).toBe(true);
    });

    it("allows .env.example and friends", () => {
      expect(isSecretFile("/home/user/.env.example")).toBe(false);
      expect(isSecretFile("/home/user/.env.sample")).toBe(false);
      expect(isSecretFile("/home/user/.env.template")).toBe(false);
    });

    it("allows other files", () => {
      expect(isSecretFile("/home/user/config.json")).toBe(false);
      expect(isSecretFile("/home/user/README.md")).toBe(false);
    });
  });

  describe("listDirectory", () => {
    it("adds trailing slashes to directories", () => {
      const dir = makeTmpDir();
      mkdirSync(join(dir, "alpha"));
      writeFileSync(join(dir, "beta.txt"), "x");

      expect(listDirectory(dir, 10).split("\n")).toEqual([
        "alpha/",
        "beta.txt",
      ]);
    });

    it("truncates with the existing head-tail marker shape", () => {
      const dir = makeTmpDir();
      for (const name of ["a", "b", "c", "d", "e"]) {
        writeFileSync(join(dir, `${name}.txt`), name);
      }

      expect(listDirectory(dir, 4)).toBe(
        [
          "a.txt",
          "b.txt",
          "",
          "... [1 more entries] ...",
          "",
          "d.txt",
          "e.txt",
        ].join("\n"),
      );
    });
  });

  describe("walkDirSync", () => {
    it("collects matching files recursively", () => {
      const dir = makeTmpDir();
      mkdirSync(join(dir, "a", "b"), { recursive: true });
      writeFileSync(join(dir, "root.jsonl"), "x");
      writeFileSync(join(dir, "a", "b", "leaf.jsonl"), "x");
      writeFileSync(join(dir, "a", "b", "leaf.txt"), "x");

      expect(
        walkDirSync(dir, {
          filter: (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
        })
          .map((file) => path.basename(file))
          .sort(),
      ).toEqual(["leaf.jsonl", "root.jsonl"]);
    });

    it("stops after the first stopWhen match", () => {
      const dir = makeTmpDir();
      mkdirSync(join(dir, "a", "b"), { recursive: true });
      writeFileSync(join(dir, "a", "b", "target.jsonl"), "x");
      writeFileSync(join(dir, "a", "b", "later.jsonl"), "x");

      const matches = walkDirSync(dir, {
        stopWhen: (entry) => entry.isFile() && entry.name === "target.jsonl",
      });

      expect(matches).toHaveLength(1);
      expect(path.basename(matches[0]!)).toBe("target.jsonl");
    });
  });
}
