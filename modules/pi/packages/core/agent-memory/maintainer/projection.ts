import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { MemoryConfig } from "../catalog.js";
import {
  canonicalJson,
  durableWrite,
  safeRelativePath,
  sha256,
  v3Data,
  withDirectoryLock,
  type JsonValue,
} from "./common.js";
import {
  listCanonicalMarkdown,
  readCanonicalFile,
  type HistoryConfig,
} from "./history.js";
import { sourcePathRejected } from "./policy.js";

export type QmdSourceManifest = {
  schemaVersion: 3;
  canonicalHead: string;
  publishedAt: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
};

export interface VerifiedCanonicalReader {
  list(head: string): string[];
  read(head: string, path: string): Buffer;
}

type ProjectionConfig = Pick<MemoryConfig, "data">;

function acceptedMarkdownPath(value: string): string {
  const path = safeRelativePath(value);
  if (!path.endsWith(".md") || path.startsWith(".") || sourcePathRejected(path))
    throw new Error(`qmd source rejected path ${path}`);
  return path;
}

export function publishQmdSource(
  cfg: ProjectionConfig,
  head: string,
  reader: VerifiedCanonicalReader,
  clock: () => Date = () => new Date(),
): QmdSourceManifest {
  if (!/^[a-f0-9]{40,64}$/.test(head))
    throw new Error("invalid qmd canonical head");
  return withDirectoryLock(v3Data(cfg, "projections/qmd-source.lock"), () =>
    publishQmdSourceLocked(cfg, head, reader, clock),
  );
}

function publishQmdSourceLocked(
  cfg: ProjectionConfig,
  head: string,
  reader: VerifiedCanonicalReader,
  clock: () => Date,
): QmdSourceManifest {
  const root = v3Data(cfg, "projections/qmd-source");
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(root), ".qmd-source-"));
  const backup = `${root}.backup.${process.pid}.${Date.now()}`;
  try {
    const listed = reader.list(head);
    if (new Set(listed).size !== listed.length)
      throw new Error("duplicate qmd source path");
    const files = listed.sort().map((candidate) => {
      const path = acceptedMarkdownPath(candidate);
      const content = reader.read(head, path);
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { mode: 0o600 });
      return { path, sha256: sha256(content), bytes: content.length };
    });
    const manifest: QmdSourceManifest = {
      schemaVersion: 3,
      canonicalHead: head,
      publishedAt: clock().toISOString(),
      files,
    };
    writeFileSync(
      join(staging, ".verified-manifest.json"),
      `${canonicalJson(manifest as unknown as JsonValue)}\n`,
      { mode: 0o600 },
    );
    if (existsSync(root)) {
      if (lstatSync(root).isSymbolicLink())
        throw new Error("qmd source cannot be a symlink");
      renameSync(root, backup);
    }
    renameSync(staging, root);
    rmSync(backup, { recursive: true, force: true });
    durableWrite(
      v3Data(cfg, "projections/qmd-source-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function projectedMarkdown(root: string, directory = root): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("qmd source cannot contain symlinks");
    if (entry.isDirectory()) return projectedMarkdown(root, path);
    return entry.isFile() && entry.name.endsWith(".md")
      ? [relative(root, path).replaceAll("\\", "/")]
      : [];
  });
}

export function publishVerifiedQmdSource(
  cfg: HistoryConfig,
  head: string,
  clock?: () => Date,
): QmdSourceManifest {
  return publishQmdSource(
    cfg,
    head,
    {
      list: (commit) => listCanonicalMarkdown(cfg, commit),
      read: (commit, path) => readCanonicalFile(cfg, commit, path),
    },
    clock,
  );
}

export function verifyQmdSource(
  cfg: ProjectionConfig,
  expectedHead?: string,
): QmdSourceManifest {
  const manifestPath = v3Data(cfg, "projections/qmd-source-manifest.json");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as QmdSourceManifest;
  if (
    manifest.schemaVersion !== 3 ||
    !/^[a-f0-9]{40,64}$/.test(manifest.canonicalHead) ||
    (expectedHead && manifest.canonicalHead !== expectedHead) ||
    !Array.isArray(manifest.files)
  )
    throw new Error("invalid qmd source manifest");
  const root = v3Data(cfg, "projections/qmd-source");
  const expectedPaths = manifest.files.map((file) => file.path).sort();
  const actualPaths = projectedMarkdown(root).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths))
    throw new Error("qmd source contains unverified markdown");
  for (const file of manifest.files) {
    const path = acceptedMarkdownPath(file.path);
    const value = readFileSync(join(root, path));
    if (value.length !== file.bytes || sha256(value) !== file.sha256)
      throw new Error(`qmd source changed ${path}`);
  }
  return manifest;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  describe("verified qmd source", () => {
    it("publishes only manifest-bound accepted markdown", () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-qmd-")) };
      const content = Buffer.from("# accepted\n");
      const manifest = publishQmdSource(
        cfg,
        "a".repeat(40),
        {
          list: () => ["nested/accepted.md"],
          read: () => content,
        },
        () => new Date("2026-09-03T12:00:00.000Z"),
      );
      expect(manifest.files).toEqual([
        {
          path: "nested/accepted.md",
          sha256: sha256(content),
          bytes: content.length,
        },
      ]);
      expect(verifyQmdSource(cfg, "a".repeat(40))).toEqual(manifest);
    });

    it.each([
      ".pi-memory/evidence/sha256/aa/a.json",
      ".stversions/old.md",
      "nested/.stversions/old.md",
      "memory.sync-conflict-20260903-a.md",
      ".qmd/cache.md",
    ])("rejects reserved retrieval input %s", (path) => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-qmd-")) };
      expect(() =>
        publishQmdSource(cfg, "a".repeat(40), {
          list: () => [path],
          read: () => Buffer.from("unsafe"),
        }),
      ).toThrow("qmd source rejected path");
    });

    it("replaces prior projections and binds them to the new head", () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-qmd-")) };
      const reader = (path: string): VerifiedCanonicalReader => ({
        list: () => [path],
        read: () => Buffer.from(`# ${path}\n`),
      });
      publishQmdSource(cfg, "a".repeat(40), reader("old.md"));
      publishQmdSource(cfg, "b".repeat(40), reader("new.md"));
      const root = v3Data(cfg, "projections/qmd-source");
      expect(existsSync(join(root, "old.md"))).toBe(false);
      expect(existsSync(join(root, "new.md"))).toBe(true);
      expect(verifyQmdSource(cfg).canonicalHead).toBe("b".repeat(40));
      expect(relative(root, join(root, "new.md"))).toBe("new.md");
    });

    it("rejects markdown absent from the verified manifest", () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-qmd-")) };
      publishQmdSource(cfg, "a".repeat(40), {
        list: () => ["accepted.md"],
        read: () => Buffer.from("# accepted\n"),
      });
      writeFileSync(
        v3Data(cfg, "projections/qmd-source/untracked.md"),
        "# untracked\n",
      );
      expect(() => verifyQmdSource(cfg)).toThrow(
        "contains unverified markdown",
      );
    });
  });
}
