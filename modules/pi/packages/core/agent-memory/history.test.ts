import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sha256 } from "./catalog.js";
import { describe, expect, it, vi } from "vitest";
import type { MemoryConfig } from "./catalog.js";
import { withMemoryWideEventFactory } from "./observability.js";
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
    expect(() =>
      commitHistory(
        cfg,
        { ...core("mutation_one"), changes: [] },
        { allowEmpty: true },
      ),
    ).toThrow("duplicate history mutation id");
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

  it("records a clean adopt repair as an empty commit", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);

    const repaired = repairHistory(cfg, {
      mode: "adopt",
      reason: "reseed clean history",
    });

    expect(repaired.commit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(headHistoryReceipt(cfg)).toMatchObject({
      commit: repaired.commit,
      kind: "repair-adopt",
      changes: [],
    });
  });

  it("does not suppress staging failures for empty repairs", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    const initialized = initHistory(cfg);
    withWritableMemoryRoot(cfg, () =>
      writeFileSync(join(cfg.root, "one.md"), "two\n"),
    );
    const lock = join(cfg.data, "v2/history.git/index.lock");
    writeFileSync(lock, "held\n");

    expect(() =>
      repairHistory(cfg, {
        mode: "adopt",
        reason: "must not bypass staging",
      }),
    ).toThrow(/index\.lock/);
    expect(
      spawnSync(
        "git",
        [`--git-dir=${join(cfg.data, "v2/history.git")}`, "rev-parse", "HEAD"],
        { encoding: "utf8" },
      ).stdout.trim(),
    ).toBe(initialized.commit);
    rmSync(lock);
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

  it("reuses immutable proof at the same head and verifies only an appended suffix", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);

    const first = verifyHistory(cfg);
    expect(first).toMatchObject({
      ok: true,
      telemetry: { mode: "full", commits: 1, semanticProcesses: 3 },
    });
    const hit = verifyHistory(cfg);
    expect(hit).toMatchObject({
      ok: true,
      telemetry: {
        mode: "process-hit",
        commits: 0,
        blobs: 0,
        semanticProcesses: 0,
      },
    });

    withWritableMemoryRoot(cfg, () =>
      writeFileSync(join(cfg.root, "one.md"), "two\n"),
    );
    commitHistory(cfg, {
      ...core("suffix_one"),
      changes: [
        {
          path: "one.md",
          beforeSha256: sha256("one\n"),
          afterSha256: sha256("two\n"),
          status: "active",
        },
      ],
    });
    expect(verifyHistory(cfg)).toMatchObject({
      ok: true,
      telemetry: { mode: "suffix", commits: 1 },
    });
  });

  it("verifies history beyond the default subprocess output limit", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    initHistory(cfg);
    expect(verifyHistory(cfg).ok).toBe(true);
    commitHistory(
      cfg,
      {
        ...core("large_receipt"),
        reason: "x".repeat(1024 * 1024),
      },
      { allowEmpty: true },
    );

    expect(verifyHistory(cfg)).toMatchObject({
      ok: true,
      telemetry: { mode: "suffix", commits: 1 },
    });
  });

  it("keeps volatile checks live on a proof hit and fails closed on checkpoint loss", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);
    expect(verifyHistory(cfg).ok).toBe(true);

    chmodSync(cfg.root, 0o700);
    chmodSync(join(cfg.root, "one.md"), 0o600);
    writeFileSync(join(cfg.root, "one.md"), "dirty\n");
    expect(verifyHistory(cfg).issues).toContain("dirty memory worktree");
    withWritableMemoryRoot(cfg, () =>
      spawnSync(
        "git",
        [
          `--git-dir=${join(cfg.data, "v2/history.git")}`,
          `--work-tree=${cfg.root}`,
          "checkout",
          "-f",
          "HEAD",
          "--",
          "one.md",
        ],
        { encoding: "utf8" },
      ),
    );
    rmSync(join(cfg.data, "v2/history-verification.initialized"));
    expect(verifyHistory(cfg).issues).toContain(
      "history verification checkpoint marker is missing; explicit history recovery is required",
    );
    writeFileSync(
      join(cfg.data, "v2/history-verification.initialized"),
      "initialized\n",
    );
    rmSync(join(cfg.data, "v2/history-verification.json"));
    expect(verifyHistory(cfg).issues).toContain(
      "history verification checkpoint is missing; explicit history recovery is required",
    );
  });

  it("migrates a v1 checkpoint after device-id churn", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);
    expect(verifyHistory(cfg).ok).toBe(true);
    const path = join(cfg.data, "v2/history-verification.json");
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    const history = join(cfg.data, "v2/history.git");
    const repository = realpathSync(history);
    const inode = lstatSync(history).ino;
    writeFileSync(
      path,
      `${JSON.stringify({
        ...checkpoint,
        version: 1,
        repository: `${repository}:999999:${inode}`,
      })}\n`,
    );

    expect(verifyHistory(cfg)).toMatchObject({
      ok: true,
      telemetry: { mode: "full", commits: 1 },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 2,
    });
    expect(JSON.parse(readFileSync(path, "utf8")).repository).toMatch(
      new RegExp(
        `^${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[0-9a-f-]{36}$`,
      ),
    );
  });

  it("refuses a v1 checkpoint for a replaced repository", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);
    expect(verifyHistory(cfg).ok).toBe(true);
    const path = join(cfg.data, "v2/history-verification.json");
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    const history = join(cfg.data, "v2/history.git");
    const repository = realpathSync(history);
    const inode = lstatSync(history).ino;
    writeFileSync(
      path,
      `${JSON.stringify({
        ...checkpoint,
        version: 1,
        repository: `${repository}:999999:${inode + 1}`,
      })}\n`,
    );

    expect(verifyHistory(cfg).issues).toContain(
      "history verification checkpoint identity changed; explicit history recovery is required",
    );
  });

  it("refuses a v2 repository replaced at the same path", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);
    expect(verifyHistory(cfg).ok).toBe(true);
    const history = join(cfg.data, "v2/history.git");
    const replaced = join(cfg.data, "v2/replaced-history.git");
    renameSync(history, replaced);
    expect(
      spawnSync("git", ["clone", "--bare", replaced, history], {
        encoding: "utf8",
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", [`--git-dir=${history}`, "remote", "remove", "origin"], {
        encoding: "utf8",
      }).status,
    ).toBe(0);

    expect(verifyHistory(cfg).issues).toContain(
      "history verification checkpoint identity changed; explicit history recovery is required",
    );
  });

  it("serializes concurrent repository identity publication", async () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);
    const run = () =>
      new Promise<{ code: number | null; stderr: string }>((resolveRun) => {
        const child = spawn(
          "bun",
          [
            "run",
            join(process.cwd(), "packages/core/agent-memory/index.ts"),
            "history",
            "verify",
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              PI_MEMORY_DATA_DIR: cfg.data,
              PI_MEMORY_ROOT: cfg.root,
              PI_MEMORY_STATE_DIR: cfg.state,
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (code) => resolveRun({ code, stderr }));
      });

    const results = await Promise.all([run(), run()]);

    expect(results).toEqual([
      { code: 0, stderr: "" },
      { code: 0, stderr: "" },
    ]);
    const checkpoint = JSON.parse(
      readFileSync(join(cfg.data, "v2/history-verification.json"), "utf8"),
    );
    expect(checkpoint).toMatchObject({ version: 2 });
    expect(verifyHistory(cfg)).toMatchObject({
      ok: true,
      basis: { repository: checkpoint.repository },
    });
  });

  it("reclaims abandoned verification locks", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(join(cfg.root, "one.md"), "one\n");
    initHistory(cfg);
    const lock = join(cfg.data, "v2/history-verification.lock");
    writeFileSync(lock, "");
    utimesSync(lock, new Date(0), new Date(0));
    expect(verifyHistory(cfg).ok).toBe(true);

    writeFileSync(lock, "2147483647\n");
    expect(verifyHistory(cfg).ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
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

  it("emits one terminal for a dry-run init boundary", () => {
    const finish = vi.fn();
    const report = withMemoryWideEventFactory(
      () => ({ id: "test", set: vi.fn(), error: vi.fn(), finish }),
      () => initHistory(config(), { dryRun: true }),
    );
    expect(report).toMatchObject({ initialized: true, dryRun: true });
    expect(finish).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith("success", {
      initialized: true,
      dryRun: true,
      hasCommit: false,
    });
  });
});
