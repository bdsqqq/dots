import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256 } from "./catalog.js";
import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "./catalog.js";
import {
  commitHistory,
  diffHistory,
  headHistoryReceipt,
  initHistory,
  listHistory,
  repairHistory,
  sealMemoryRoot,
  showHistory,
  syncHistory,
  verifyHistory,
  withWritableMemoryRoot,
} from "./history.js";

function config(): MemoryConfig {
  const base = mkdtempSync(join(tmpdir(), "memory-history-"));
  return {
    state: join(base, "state"),
    data: join(base, "data"),
    root: join(base, "memories"),
    skillsRoot: join(base, "skills"),
  };
}
function core(id: string) {
  return {
    version: 2 as const,
    mutationId: id,
    kind: "test",
    reason: "test mutation",
    changes: [],
    provenance: { source: "test" },
  };
}
const mode = (path: string) => lstatSync(path).mode & 0o777;

describe("private memory history", () => {
  it("initializes a byte-preserving baseline and seals memory", () => {
    const cfg = config();
    mkdirSync(join(cfg.root, ".archive"), { recursive: true });
    mkdirSync(join(cfg.root, ".qmd"), { recursive: true });
    const active = join(cfg.root, "active.md");
    const archived = join(cfg.root, ".archive/old.md");
    const qmdMarkdown = join(cfg.root, ".qmd/cache.md");
    writeFileSync(active, Buffer.from([0x61, 0x00, 0xff]));
    writeFileSync(archived, "old\n");
    writeFileSync(qmdMarkdown, "auxiliary\n");
    const before = readFileSync(active);
    const report = initHistory(cfg);
    expect(report.commit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(readFileSync(active)).toEqual(before);
    expect(mode(cfg.root)).toBe(0o500);
    expect(mode(active)).toBe(0o400);
    expect(mode(join(cfg.root, ".qmd"))).toBe(0o700);
    expect(mode(qmdMarkdown) & 0o200).toBe(0o200);
    writeFileSync(join(cfg.root, ".qmd/index.sqlite-wal"), "writable\n");
    chmodSync(join(cfg.root, ".qmd"), 0o500);
    initHistory(cfg);
    expect(mode(join(cfg.root, ".qmd"))).toBe(0o700);
    expect(showHistory(cfg, "HEAD", "active.md")).toEqual(before.toString());
  });

  it("never follows a qmd state symlink while sealing", () => {
    const cfg = config();
    const outside = mkdtempSync(join(tmpdir(), "memory-qmd-outside-"));
    chmodSync(outside, 0o755);
    mkdirSync(cfg.root, { recursive: true });
    symlinkSync(outside, join(cfg.root, ".qmd"));
    expect(() => sealMemoryRoot(cfg)).toThrow(
      "qmd state directory cannot be a symlink",
    );
    expect(mode(outside)).toBe(0o755);
  });

  it("never follows a symlinked memory root", () => {
    const cfg = config();
    const outside = mkdtempSync(join(tmpdir(), "memory-root-outside-"));
    chmodSync(outside, 0o755);
    symlinkSync(outside, cfg.root);
    expect(() => initHistory(cfg)).toThrow("memory root cannot be a symlink");
    expect(mode(outside)).toBe(0o755);
  });

  it("commits receipts and supports list, show, diff, and dirty verification", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);
    withWritableMemoryRoot(cfg, () =>
      writeFileSync(join(cfg.root, "one.md"), "two\n"),
    );
    const result = commitHistory(cfg, {
      ...core("mutation_one"),
      changes: [
        {
          path: "one.md",
          beforeSha256: sha256("one\n"),
          afterSha256: sha256("two\n"),
          status: "active",
        },
      ],
    });
    const receipt = headHistoryReceipt(cfg)!;
    expect(receipt).toMatchObject({
      commit: result.commit,
      mutationId: "mutation_one",
    });
    expect(existsSync(join(cfg.data, "v2/mutations/mutation_one.json"))).toBe(
      true,
    );
    expect(listHistory(cfg, { memory: "one.md" })[0]?.commit).toBe(
      result.commit,
    );
    expect(showHistory(cfg, "HEAD", "one.md")).toBe("two\n");
    expect(diffHistory(cfg)).toContain("+two");
    chmodSync(cfg.root, 0o700);
    chmodSync(join(cfg.root, "one.md"), 0o600);
    writeFileSync(join(cfg.root, "one.md"), "dirty\n");
    expect(verifyHistory(cfg)).toMatchObject({ ok: false });
    sealMemoryRoot(cfg);
  });

  it("adopts and discards repairs", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);
    withWritableMemoryRoot(cfg, () =>
      writeFileSync(join(cfg.root, "one.md"), "adopted\n"),
    );
    expect(
      repairHistory(cfg, { mode: "adopt", reason: "keep local edit" }).commit,
    ).toBeTruthy();
    expect(headHistoryReceipt(cfg)?.changes).toMatchObject([
      {
        path: "one.md",
      },
    ]);
    withWritableMemoryRoot(cfg, () => {
      writeFileSync(join(cfg.root, "one.md"), "discard\n");
      writeFileSync(join(cfg.root, "extra.md"), "extra\n");
    });
    repairHistory(cfg, { mode: "discard", reason: "remove local edit" });
    expect(readFileSync(join(cfg.root, "one.md"), "utf8")).toBe("adopted\n");
    expect(existsSync(join(cfg.root, "extra.md"))).toBe(false);
  });

  it("restores sealing after helper failure and syncs without a remote", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);
    expect(() =>
      withWritableMemoryRoot(cfg, () => {
        expect(mode(cfg.root)).toBe(0o700);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(mode(cfg.root)).toBe(0o500);
    expect(mode(join(cfg.root, "one.md"))).toBe(0o400);
    expect(syncHistory(cfg)).toEqual({ ok: true, pushed: false });
    expect(verifyHistory(cfg).ok).toBe(true);
  });

  it("reconstructs receipt caches and refuses a changed origin", () => {
    const cfg = config();
    const remote = join(tmpdir(), `memory-remote-${Date.now()}.git`);
    const replacement = join(
      tmpdir(),
      `memory-remote-replacement-${Date.now()}.git`,
    );
    for (const path of [remote, replacement]) {
      const result = spawnSync("git", ["init", "--bare", path], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
    }
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    const initialized = initHistory(cfg, { remote });
    expect(syncHistory(cfg)).toMatchObject({ ok: true, pushed: true });
    const receipt = headHistoryReceipt(cfg)!;
    const cache = join(cfg.data, "v2/mutations", `${receipt.mutationId}.json`);
    chmodSync(join(cfg.data, "v2/mutations"), 0o700);
    rmSync(cache);
    expect(verifyHistory(cfg).ok).toBe(true);
    expect(existsSync(cache)).toBe(true);

    const explicitPush = spawnSync(
      "git",
      [
        `--git-dir=${join(cfg.data, "v2/history.git")}`,
        "remote",
        "set-url",
        "--add",
        "--push",
        "origin",
        remote,
      ],
      { encoding: "utf8" },
    );
    expect(explicitPush.status).toBe(0);
    const extraPush = spawnSync(
      "git",
      [
        `--git-dir=${join(cfg.data, "v2/history.git")}`,
        "remote",
        "set-url",
        "--add",
        "--push",
        "origin",
        replacement,
      ],
      { encoding: "utf8" },
    );
    expect(extraPush.status).toBe(0);
    expect(syncHistory(cfg)).toMatchObject({
      ok: false,
      pushed: false,
    });
    const changed = spawnSync(
      "git",
      [
        `--git-dir=${join(cfg.data, "v2/history.git")}`,
        "remote",
        "set-url",
        "--delete",
        "--push",
        "origin",
        replacement,
      ],
      { encoding: "utf8" },
    );
    expect(changed.status).toBe(0);
    const changedFetch = spawnSync(
      "git",
      [
        `--git-dir=${join(cfg.data, "v2/history.git")}`,
        "remote",
        "set-url",
        "origin",
        replacement,
      ],
      { encoding: "utf8" },
    );
    expect(changedFetch.status).toBe(0);
    expect(syncHistory(cfg)).toMatchObject({
      ok: false,
      pushed: false,
    });
    expect(initialized.remote).toBe(remote);
  });

  it("adopts an existing private remote instead of creating a new baseline", () => {
    const remote = join(tmpdir(), `memory-shared-remote-${Date.now()}.git`);
    expect(
      spawnSync("git", ["init", "--bare", remote], { encoding: "utf8" }).status,
    ).toBe(0);
    const first = config();
    mkdirSync(first.root, { recursive: true });
    writeFileSync(join(first.root, "shared.md"), "shared\n");
    const initial = initHistory(first, { remote });
    expect(syncHistory(first).ok).toBe(true);

    const second = config();
    const adopted = initHistory(second, { remote });

    expect(adopted.commit).toBe(initial.commit);
    expect(verifyHistory(second).ok).toBe(true);
    expect(readFileSync(join(second.root, "shared.md"), "utf8")).toBe(
      "shared\n",
    );

    withWritableMemoryRoot(first, () =>
      writeFileSync(join(first.root, "shared.md"), "updated\n"),
    );
    commitHistory(first, {
      ...core("mutation_shared"),
      changes: [
        {
          path: "shared.md",
          beforeSha256: sha256("shared\n"),
          afterSha256: sha256("updated\n"),
          status: "active",
        },
      ],
    });
    expect(syncHistory(first).ok).toBe(true);
    expect(syncHistory(second)).toMatchObject({
      ok: true,
      fastForwarded: true,
    });
    expect(readFileSync(join(second.root, "shared.md"), "utf8")).toBe(
      "updated\n",
    );
  });
});
