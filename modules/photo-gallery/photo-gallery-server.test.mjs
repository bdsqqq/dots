import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { backendPath, galleryServer, parseArgs } from "./photo-gallery-server.mjs";

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
      intelligenceUrl: "http://127.0.0.1:3924",
    }
  );
});

test("maps gallery media and folder routes to copyparty", () => {
  assert.equal(backendPath("/gallery/raw/2026/08/a%20b.jpg?th"), "/raw/2026/08/a%20b.jpg?th");
  assert.equal(backendPath("/gallery/2026/08/a.jpg?v"), "/raw/2026/08/a.jpg?v");
  assert.equal(backendPath("/gallery/folders/2026/08/"), "/raw/2026/08/");
  assert.equal(backendPath("/raw/2026/08/a.jpg?v"), "/raw/2026/08/a.jpg?v");
  assert.equal(backendPath("/gallery/api/timeline"), null);
});

test("proxies the timeline from photo intelligence", async () => {
  const timeline = { generatedAt: "2026-08-20T00:00:00.000Z", itemCount: 1, groups: [] };
  const intelligence = createServer((request, response) => {
    assert.equal(request.url, "/timeline");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(timeline));
  });
  let gallery;
  try {
    await new Promise((resolvePromise) => intelligence.listen(0, "127.0.0.1", resolvePromise));
    gallery = galleryServer({
      assets: { html: "", css: "", js: "" },
      backendPort: 1,
      intelligenceUrl: `http://127.0.0.1:${intelligence.address().port}`,
    });
    await new Promise((resolvePromise) => gallery.listen(0, "127.0.0.1", resolvePromise));
    const response = await fetch(`http://127.0.0.1:${gallery.address().port}/gallery/api/timeline`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), timeline);
  } finally {
    if (gallery) await new Promise((resolvePromise) => gallery.close(resolvePromise));
    await new Promise((resolvePromise) => intelligence.close(resolvePromise));
  }
});
