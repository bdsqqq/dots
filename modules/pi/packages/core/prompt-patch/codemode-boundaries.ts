// Installed with node --import before loading the shipped extensions. No tool is mocked.
import { appendFileSync } from "node:fs";
import { Socket } from "node:net";
// The SDK may replace global fetch during startup; prevent that from reaching the wire.
Socket.prototype.connect = function () {
  throw new Error("offline codemode probe forbids sockets");
};
const mymind = process.env.PI_RENDER_MYMIND_MEDIA
  ? await import("../box-format/rendering-mymind-boundary.ts")
  : undefined;
export const fixtureFetch: typeof fetch = async (input, options) => {
  const url = String(input instanceof Request ? input.url : input);
  appendFileSync(process.env.PI_CODEMODE_NETWORK_LOG!, `${url}\n`);
  if (
    mymind &&
    ["api.mymind.com", "media.mymind.host"].includes(new URL(url).hostname)
  )
    return mymind.fixtureFetch(input, options);
  if (url === "https://codemode.example/fixture")
    return new Response("WEB_FIXTURE_".repeat(500), {
      headers: { "content-type": "text/plain" },
    });
  if (url === "https://api.parallel.ai/v1/search")
    return Response.json({
      results: [
        {
          url: "https://codemode.example/fixture",
          title: "WEB_FIXTURE",
          excerpts: ["SEARCH_FIXTURE"],
        },
      ],
      warnings: [],
      usage: [],
    });
  if (url === "https://api.parallel.ai/v1/extract")
    return Response.json({
      results: [
        {
          url: "https://codemode.example/fixture",
          title: "WEB_FIXTURE",
          full_content: "WEB_FIXTURE_".repeat(500),
          excerpts: ["EXTRACT_FIXTURE"],
        },
      ],
      warnings: [],
      usage: [],
    });
  throw new Error(`unapproved network boundary: ${url}`);
};
globalThis.fetch = fixtureFetch;
