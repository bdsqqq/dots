import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backendPath, buildTimeline, parseArgs } from "./photo-gallery-server.mjs";

test("parses server options", () => {
  assert.deepEqual(
    parseArgs([
      "--source", "/photos",
      "--state", "/cache",
      "--copyparty", "/bin/copyparty",
      "--html", "/ui/index.html",
      "--css", "/ui/gallery.css",
      "--js", "/ui/gallery.js",
    ]),
    {
      source: "/photos",
      state: "/cache",
      copyparty: "/bin/copyparty",
      html: "/ui/index.html",
      css: "/ui/gallery.css",
      js: "/ui/gallery.js",
      host: "127.0.0.1",
      port: 3923,
      backendPort: 13923,
    }
  );
});

test("groups media by archive date and ignores sidecars", async () => {
  const root = await mkdtemp(join(tmpdir(), "photo-gallery-test-"));
  try {
    await mkdir(join(root, "2026", "08", "20"), { recursive: true });
    await mkdir(join(root, "2025", "12", "31"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "2026", "08", "20", "photo.HEIC"), "photo"),
      writeFile(join(root, "2026", "08", "20", "clip.mov"), "video"),
      writeFile(join(root, "2026", "08", "20", "photo.HEIC.json"), "{}"),
      writeFile(join(root, "2026", "08", "20", "._photo.HEIC"), "fork"),
      writeFile(join(root, "2025", "12", "31", "older.jpg"), "photo"),
    ]);

    const timeline = await buildTimeline(root);
    assert.equal(timeline.itemCount, 3);
    assert.deepEqual(
      timeline.groups.map(({ date, items }) => [date, items.map(({ name, type }) => [name, type])]),
      [
        ["2026-08-20", [["clip.mov", "video"], ["photo.HEIC", "image"]]],
        ["2025-12-31", [["older.jpg", "image"]]],
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maps gallery media and folder routes to copyparty", () => {
  assert.equal(backendPath("/gallery/raw/2026/08/a%20b.jpg?th"), "/raw/2026/08/a%20b.jpg?th");
  assert.equal(backendPath("/gallery/2026/08/a.jpg?v"), "/raw/2026/08/a.jpg?v");
  assert.equal(backendPath("/gallery/folders/2026/08/"), "/raw/2026/08/");
  assert.equal(backendPath("/raw/2026/08/a.jpg?v"), "/raw/2026/08/a.jpg?v");
  assert.equal(backendPath("/gallery/api/timeline"), null);
});
