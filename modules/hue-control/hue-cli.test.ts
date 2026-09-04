import assert from "node:assert/strict";
import test from "node:test";

import { runHueCli } from "./hue-cli.ts";

test("CLI translates commands to the daemon HTTP API", async () => {
  const requests: Array<{ body: string | undefined; method: string | undefined; url: string }> = [];
  const request = async (input: string, init?: RequestInit): Promise<Response> => {
    requests.push({ body: init?.body?.toString(), method: init?.method, url: input });
    return Response.json({ ok: true });
  };

  await runHueCli(["--url", "http://127.0.0.1:8756/", "state"], request);
  await runHueCli(["--url", "http://127.0.0.1:8756", "brightness", "127"], request);

  assert.deepEqual(requests, [
    { body: undefined, method: undefined, url: "http://127.0.0.1:8756/api/state" },
    {
      body: '{"brightness":127}',
      method: "POST",
      url: "http://127.0.0.1:8756/api/light",
    },
  ]);
});
