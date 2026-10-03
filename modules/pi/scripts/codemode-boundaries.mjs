// Installed with node --import before loading the shipped extensions. No tool is mocked.
import { appendFileSync } from "node:fs";
import { Socket } from "node:net";
// The SDK may replace global fetch during startup; prevent that from reaching the wire.
Socket.prototype.connect = function () {
  throw new Error("offline codemode probe forbids sockets");
};
export const fixtureFetch = async (input, options) => {
  const url = String(input instanceof Request ? input.url : input);
  appendFileSync(process.env.PI_CODEMODE_NETWORK_LOG, `${url}\n`);
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
