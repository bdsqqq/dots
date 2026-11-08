import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

// preload before extension imports: the real client keeps its managed-credential
// lookup and signing path, but neither /run/secrets read reaches the filesystem.
const readFile = fs.readFile;
fs.readFile = (async (...args: Parameters<typeof readFile>) => {
  const path = String(args[0]);
  if (
    path === "/run/secrets/mymind_keyid" ||
    path === "/run/secrets/mymind_privatekey"
  ) {
    assert.equal(args[1], "utf8");
    appendFileSync(process.env.PI_RENDER_MYMIND_CREDENTIAL_LOG!, `${path}\n`);
    return path.endsWith("keyid")
      ? "rendering-fixture"
      : Buffer.alloc(32, 7).toString("base64");
  }
  return readFile(...args);
}) as typeof readFile;
syncBuiltinESMExports();

export const fixtureFetch: typeof fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(options?.method, "GET");
  assert.equal(options?.redirect, "manual");
  const headers = new Headers(options?.headers);
  if (url.origin === "https://media.mymind.host") {
    assert.equal(
      headers.has("authorization"),
      false,
      "API credentials reached CDN",
    );
    assert.equal(url.pathname + url.search, "/rendering-fixture.png");
    return new Response(readFileSync(process.env.PI_RENDER_MYMIND_MEDIA!), {
      headers: { "content-type": "image/png" },
    });
  }
  assert.equal(url.origin, "https://api.mymind.com");
  assert.ok(
    /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(headers.get("authorization") ?? ""),
    "missing synthetic API bearer token",
  );
  const quota = {
    "ratelimit-cost": "2",
    ratelimit: '"burst";r=8;t=30, "sustained";r=98;t=3600',
  };
  if (
    url.pathname + url.search ===
    "/objects?q=rendering&limit=1&contentAs=text%2Fmarkdown"
  )
    return Response.json([{ id: "fx_01", title: "MYMIND_SEARCH_FIXTURE" }], {
      headers: quota,
    });
  if (url.pathname + url.search === "/objects/fx_01?contentAs=text%2Fmarkdown")
    return Response.json(
      {
        id: "fx_01",
        title: "MYMIND_OBJECT_FIXTURE",
        tags: ["synthetic"],
        content: "offline markdown",
      },
      { headers: quota },
    );
  if (url.pathname + url.search === "/objects/fx_01/thumbnail?size=64x64")
    return new Response(null, {
      status: 302,
      headers: {
        ...quota,
        location: "https://media.mymind.host/rendering-fixture.png",
      },
    });
  if (
    url.pathname + url.search ===
    "/objects/fx_quota?contentAs=text%2Fmarkdown"
  )
    return new Response(null, {
      status: 429,
      headers: { ratelimit: '"burst";r=0;t=17' },
    });
  throw new Error("unapproved mymind fixture request");
};
