import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createConflictQueue,
  findBackupFile,
  handleConflict,
  parseConflictFile,
} from "./syncthing-automerge.ts";

async function withVault(run: (vault: string) => Promise<void>) {
  const vault = await mkdtemp(join(tmpdir(), "syncthing-automerge-"));
  try {
    await run(vault);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}

async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("parses a nested Syncthing conflict path", () => {
  const cwd = "/vault";
  assert.deepEqual(
    parseConflictFile(
      "/vault/.obsidian/app.sync-conflict-20260728-203035-L2PJ4F3.json",
      cwd
    ),
    {
      name: ".obsidian/app",
      date: "20260728",
      time: "203035",
      id: "L2PJ4F3",
      extension: "json",
      conflictPath: ".obsidian/app.sync-conflict-20260728-203035-L2PJ4F3.json",
      originalPath: ".obsidian/app.json",
    }
  );
});

test("uses a trash-can backup as the merge base", async () => {
  await withVault(async (vault) => {
    await mkdir(join(vault, ".stversions", ".obsidian"), { recursive: true });
    await writeFile(join(vault, ".stversions", ".obsidian", "app.json"), "{}\n");

    assert.equal(
      findBackupFile(".obsidian/app.json", "json", vault),
      ".stversions/.obsidian/app.json"
    );
  });
});

test("uses the latest simple-versioning backup as the merge base", async () => {
  await withVault(async (vault) => {
    const versions = join(vault, ".stversions", "notes");
    await mkdir(versions, { recursive: true });
    await writeFile(join(versions, "plan~20260101-120000.md"), "old\n");
    await writeFile(join(versions, "plan~20260102-120000.md"), "new\n");

    assert.equal(
      findBackupFile("notes/plan.md", "md", vault),
      ".stversions/notes/plan~20260102-120000.md"
    );
  });
});

test("supports extensionless simple-versioning backups", async () => {
  await withVault(async (vault) => {
    const versions = join(vault, ".stversions");
    await mkdir(versions, { recursive: true });
    await writeFile(join(versions, "README~20260101-120000"), "base\n");

    assert.equal(
      findBackupFile("README", "", vault),
      ".stversions/README~20260101-120000"
    );
  });
});

test("merges divergent edits and removes the conflict copy", async () => {
  await withVault(async (vault) => {
    const original = join(vault, "note.md");
    const conflict = join(vault, "note.sync-conflict-20990101-203035-L2PJ4F3.md");
    const backup = join(vault, ".stversions", "note.md");
    await mkdir(join(vault, ".stversions"), { recursive: true });
    await writeFile(backup, "alpha\nbeta\ngamma\n");
    await writeFile(original, "alpha local\nbeta\ngamma\n");
    await writeFile(conflict, "alpha\nbeta\ngamma remote\n");

    assert.equal(await handleConflict(conflict, vault), true);
    assert.equal(await readFile(original, "utf8"), "alpha local\nbeta\ngamma remote\n");
    await assert.rejects(readFile(conflict));
  });
});

test("preserves both files when no merge base exists", async () => {
  await withVault(async (vault) => {
    const original = join(vault, "note.md");
    const conflict = join(vault, "note.sync-conflict-20990101-203035-L2PJ4F3.md");
    await writeFile(original, "local\n");
    await writeFile(conflict, "remote\n");

    assert.equal(await handleConflict(conflict, vault), false);
    assert.equal(await readFile(original, "utf8"), "local\n");
    assert.equal(await readFile(conflict, "utf8"), "remote\n");
  });
});

test("preserves both files when the three-way merge is not clean", async () => {
  await withVault(async (vault) => {
    const original = join(vault, "note.md");
    const conflict = join(vault, "note.sync-conflict-20990101-203035-L2PJ4F3.md");
    await mkdir(join(vault, ".stversions"), { recursive: true });
    await writeFile(join(vault, ".stversions", "note.md"), "setting: base\n");
    await writeFile(original, "setting: local\n");
    await writeFile(conflict, "setting: remote\n");

    assert.equal(await handleConflict(conflict, vault), false);
    assert.equal(await readFile(original, "utf8"), "setting: local\n");
    await assert.rejects(readFile(conflict));

    const quarantine = join(vault, ".syncthing-conflicts");
    const entries = await readdir(quarantine);
    assert.equal(entries.filter((entry) => entry.endsWith(".conflict")).length, 1);
    assert.equal(entries.filter((entry) => entry.endsWith(".json")).length, 1);

    const snapshot = entries.find((entry) => entry.endsWith(".conflict"));
    const metadata = entries.find((entry) => entry.endsWith(".json"));
    assert.ok(snapshot);
    assert.ok(metadata);
    assert.equal(await readFile(join(quarantine, snapshot), "utf8"), "setting: remote\n");
    const record = JSON.parse(await readFile(join(quarantine, metadata), "utf8"));
    assert.deepEqual(
      {
        ...record,
        quarantinedAt: undefined,
      },
      {
        version: 1,
        conflictPath: "note.sync-conflict-20990101-203035-L2PJ4F3.md",
        originalPath: "note.md",
        conflict: {
          date: "20990101",
          time: "203035",
          id: "L2PJ4F3",
          extension: "md",
        },
        size: 16,
        quarantinedAt: undefined,
      }
    );
    assert.match(record.quarantinedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("serializes conflicts that target the same original", async () => {
  await withVault(async (vault) => {
    const original = join(vault, "note.md");
    const firstConflict = join(vault, "note.sync-conflict-20990101-203035-L2PJ4F3.md");
    const secondConflict = join(vault, "note.sync-conflict-20990101-203036-YORN2Q5.md");
    const base = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const local = [...base];
    const first = [...base];
    const second = [...base];
    local[1] += " local";
    first[14] += " first";
    second[28] += " second";

    await mkdir(join(vault, ".stversions"), { recursive: true });
    await writeFile(join(vault, ".stversions", "note.md"), `${base.join("\n")}\n`);
    await writeFile(original, `${local.join("\n")}\n`);
    await writeFile(firstConflict, `${first.join("\n")}\n`);
    await writeFile(secondConflict, `${second.join("\n")}\n`);

    const enqueue = createConflictQueue(vault);
    assert.deepEqual(
      await Promise.all([enqueue(firstConflict), enqueue(secondConflict)]),
      [true, true]
    );
    const merged = await readFile(original, "utf8");
    assert.match(merged, /line 2 local/);
    assert.match(merged, /line 15 first/);
    assert.match(merged, /line 29 second/);
    await assert.rejects(readFile(firstConflict));
    await assert.rejects(readFile(secondConflict));
  });
});

test("the watcher merges a newly created conflict", async () => {
  await withVault(async (vault) => {
    await mkdir(join(vault, ".stversions"), { recursive: true });
    await writeFile(join(vault, ".stversions", "note.md"), "alpha\nbeta\ngamma\n");
    await writeFile(join(vault, "note.md"), "alpha local\nbeta\ngamma\n");

    const script = fileURLToPath(new URL("./syncthing-automerge.ts", import.meta.url));
    const child = spawn(process.execPath, [script], {
      cwd: vault,
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("Watching:")) resolve();
        });
      });

      const conflict = join(vault, "note.sync-conflict-20990101-203035-L2PJ4F3.md");
      await writeFile(conflict, "alpha\nbeta\ngamma remote\n");
      await waitFor(() => !existsSync(conflict));

      assert.equal(await readFile(join(vault, "note.md"), "utf8"), "alpha local\nbeta\ngamma remote\n");
    } finally {
      child.kill();
      if (child.exitCode === null) await once(child, "exit");
    }
  });
});
