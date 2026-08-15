import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  flattenModel,
  folderReady,
  materializeSnapshot,
  parseArgs,
} from "./files-browser-server.mjs";

test("parses required server options", () => {
  assert.deepEqual(
    parseArgs([
      "--source",
      "/source",
      "--state",
      "/state",
      "--syncthing-config",
      "/config.xml",
      "--syncthing-url",
      "http://127.0.0.1:8384",
      "--copyparty",
      "/bin/copyparty",
    ]),
    {
      source: "/source",
      state: "/state",
      syncthingConfig: "/config.xml",
      syncthingUrl: "http://127.0.0.1:8384",
      copyparty: "/bin/copyparty",
      host: "127.0.0.1",
      port: 3925,
    }
  );
});

test("rejects unsafe model paths", () => {
  assert.throws(
    () => flattenModel([{ name: "..", type: "FILE_INFO_TYPE_DIRECTORY" }]),
    /unsafe Syncthing path/
  );
});

test("allows ignored local deletion errors but not missing indexed content", () => {
  const synchronized = {
    state: "idle",
    needFiles: 0,
    needDirectories: 0,
    needSymlinks: 0,
    needBytes: 0,
    needDeletes: 42,
    pullErrors: 42,
  };
  assert.equal(folderReady(synchronized), true);
  assert.equal(folderReady({ ...synchronized, needFiles: 1 }), false);
  assert.equal(folderReady({ ...synchronized, state: "syncing" }), false);
});

test("materializes only indexed files and symlinks", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "files-browser-test-"));
  const source = join(temporary, "source");
  const snapshots = join(temporary, "snapshots");
  await mkdir(join(source, "docs"), { recursive: true });
  await mkdir(snapshots);
  await writeFile(join(source, "docs", "indexed.txt"), "indexed\n");
  await writeFile(join(source, "ignored.txt"), "ignored\n");
  await symlink("docs/indexed.txt", join(source, "shortcut"));

  const entries = [
    {
      name: "docs",
      type: "FILE_INFO_TYPE_DIRECTORY",
      modTime: "2026-01-01T00:00:00Z",
      size: 128,
      children: [
        {
          name: "indexed.txt",
          type: "FILE_INFO_TYPE_FILE",
          modTime: "2026-01-01T00:00:00Z",
          size: 8,
        },
      ],
    },
    {
      name: "shortcut",
      type: "FILE_INFO_TYPE_SYMLINK",
      modTime: "2026-01-01T00:00:00Z",
      size: 0,
    },
  ];

  try {
    const publication = await materializeSnapshot(source, snapshots, entries);
    assert.equal(await readFile(join(publication.snapshot, "docs", "indexed.txt"), "utf8"), "indexed\n");
    assert.equal(await readlink(join(publication.snapshot, "shortcut")), "docs/indexed.txt");
    await assert.rejects(readFile(join(publication.snapshot, "ignored.txt")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
