import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertBackendLive,
  flattenModel,
  folderReady,
  materializeSnapshot,
  modelToken,
  parseArgs,
  waitForBackend,
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

test("remote index changes invalidate the publication token", () => {
  const status = {
    sequence: 10,
    remoteSequence: { remoteB: 20, remoteA: 30 },
  };
  assert.equal(
    modelToken(status),
    modelToken({ ...status, remoteSequence: { remoteA: 30, remoteB: 20 } })
  );
  assert.notEqual(
    modelToken(status),
    modelToken({ ...status, remoteSequence: { remoteB: 21, remoteA: 30 } })
  );
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

test("rejects indexed symlinks that escape the source root", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "files-browser-test-"));
  const source = join(temporary, "source");
  const snapshots = join(temporary, "snapshots");
  await mkdir(source);
  await mkdir(snapshots);
  await symlink("../outside", join(source, "escape"));

  try {
    await assert.rejects(
      materializeSnapshot(source, snapshots, [
        {
          name: "escape",
          type: "FILE_INFO_TYPE_SYMLINK",
          modTime: "2026-01-01T00:00:00Z",
          size: 0,
        },
      ]),
      /indexed symlink escapes source root/
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("published files remain pinned after source replacement", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "files-browser-test-"));
  const source = join(temporary, "source");
  const snapshots = join(temporary, "snapshots");
  await mkdir(source);
  await mkdir(snapshots);
  await writeFile(join(source, "indexed.txt"), "indexed\n");

  const entry = {
    name: "indexed.txt",
    type: "FILE_INFO_TYPE_FILE",
    modTime: "2026-01-01T00:00:00Z",
    size: 8,
  };

  try {
    const publication = await materializeSnapshot(source, snapshots, [entry]);
    const published = join(publication.snapshot, "indexed.txt");
    await rm(join(source, "indexed.txt"));
    await symlink("../outside", join(source, "indexed.txt"));
    assert.equal(await readFile(published, "utf8"), "indexed\n");
    await assert.rejects(readFile(join(published, "nested")));

    await rm(join(source, "indexed.txt"));
    await mkdir(join(source, "indexed.txt"));
    await writeFile(join(source, "indexed.txt", "nested"), "not indexed\n");
    assert.equal(await readFile(published, "utf8"), "indexed\n");
    await assert.rejects(readFile(join(published, "nested")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects a candidate backend that exits after a successful health response", async () => {
  const backend = {
    child: { exitCode: null },
    failure: null,
  };
  const server = createServer((_request, response) => {
    response.writeHead(200).end("ok\n");
    backend.failure = new Error("candidate exited");
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  backend.port = server.address().port;

  try {
    await assert.rejects(waitForBackend(backend), /candidate exited/);
    assert.throws(() => assertBackendLive(backend), /candidate exited/);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
