import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { environment, ready } from "./auth.ts";

test("Places provisioning, enablement and explicit probe query are required", () => {
  const root = mkdtempSync(join(tmpdir(), "places-auth-test-"));
  try {
    const apiKeyFile = join(root, "key");
    writeFileSync(apiKeyFile, "PRIVATE_KEY\n", { mode: 0o600 });
    const cfg = { enabled: true, executable: "mock-places", apiKeyFile };
    let calls = 0;
    const run = () => { calls++; return '{"results":[]}'; };
    for (const delta of [{ enabled: false }, { apiKeyFile: "relative" }, { apiKeyFile: "/missing/fixture" }, { apiKeyFile: "/nix/store/key" }]) assert.throws(() => ready({ ...cfg, ...delta }, "fixture", run));
    assert.throws(() => ready(cfg, "", run)); assert.equal(calls, 0);
    const summary = ready(cfg, "fixture query", command => {
      assert.deepEqual(command.args, ["search", "fixture query", "--limit", "1", "--json", "--timeout", "10s"]);
      assert.equal(command.env?.GOOGLE_PLACES_API_KEY, "PRIVATE_KEY");
      assert.equal(command.env?.GOOGLE_PLACES_BASE_URL, undefined);
      return '{"results":[{"private":"PRIVATE_RESPONSE"}]}';
    });
    assert(!summary.includes("PRIVATE")); assert.match(summary, /potentially billable/);
    assert.throws(() => ready(cfg, "fixture", () => "PRIVATE_ERROR --help"), e => e instanceof Error && !e.message.includes("PRIVATE_ERROR"));
    assert.throws(() => ready(cfg, "fixture", () => '{}'));
    writeFileSync(apiKeyFile, "", { mode: 0o600 }); assert.throws(() => environment(cfg));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
