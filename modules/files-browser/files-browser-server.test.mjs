import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
  startBackend,
  stopBackend,
  waitForBackend,
  waitForPublication,
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

test("waits for Syncthing before publishing instead of exiting", async () => {
  let attempts = 0;
  let ready = false;

  await waitForPublication(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("config not ready");
      ready = attempts === 3;
    },
    () => ready,
    0,
    () => {}
  );

  assert.equal(attempts, 3);
});

test("remote deletion invalidates the token and disappears from publication", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "files-browser-test-"));
  const source = join(temporary, "source");
  const snapshots = join(temporary, "snapshots");
  await mkdir(source);
  await mkdir(snapshots);
  await writeFile(join(source, "keep.txt"), "keep\n");
  await writeFile(join(source, "deleted.txt"), "deleted\n");

  const status = {
    state: "idle",
    needFiles: 0,
    needDirectories: 0,
    needSymlinks: 0,
    needBytes: 0,
    needDeletes: 0,
    sequence: 10,
    remoteSequence: { remoteB: 20, remoteA: 30 },
  };
  const afterDeletion = {
    ...status,
    needDeletes: 1,
    remoteSequence: { remoteB: 21, remoteA: 30 },
  };
  const file = (name, size) => ({
    name,
    type: "FILE_INFO_TYPE_FILE",
    modTime: "2026-01-01T00:00:00Z",
    size,
  });

  try {
    const before = await materializeSnapshot(source, snapshots, [
      file("keep.txt", 5),
      file("deleted.txt", 8),
    ]);
    assert.equal(await readFile(join(before.snapshot, "deleted.txt"), "utf8"), "deleted\n");
    assert.equal(folderReady(afterDeletion), true);
    assert.notEqual(modelToken(status), modelToken(afterDeletion));

    const after = await materializeSnapshot(source, snapshots, [file("keep.txt", 5)]);
    await assert.rejects(readFile(join(after.snapshot, "deleted.txt")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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

test("trusts the single local reverse-proxy hop", () => {
  const child = new EventEmitter();
  child.exitCode = null;
  let arguments_;
  startBackend(
    { copyparty: "/bin/copyparty", state: "/state" },
    1,
    "/snapshot",
    (_command, spawnArguments) => {
      arguments_ = spawnArguments;
      return child;
    }
  );

  assert.deepEqual(arguments_.slice(4, 6), ["--rproxy", "-1"]);
});

test("cleans up a spawn error that closes without an exit event", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "files-browser-test-"));
  const snapshot = join(temporary, "snapshot");
  await mkdir(snapshot);

  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  const backend = startBackend(
    { copyparty: "/missing-copyparty", state: temporary },
    999,
    snapshot,
    () => child
  );
  const waiting = waitForBackend(backend);
  child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
  child.emit("close");
  await assert.rejects(waiting, /spawn failed/);
  await Promise.race([
    stopBackend(backend),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("failed spawn cleanup timed out")), 1_000)
    ),
  ]);
  await assert.rejects(access(snapshot));
});
