import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const skillDirectory = resolve(
  new URL(".", import.meta.url).pathname,
  "../agents/skills/company-money",
);

test("company-money skill is instructions-only, bounded, manual, and read-only", async () => {
  assert.deepEqual(await readdir(skillDirectory), ["SKILL.md"]);
  const source = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");
  assert.match(source, /accessing-google-workspace/);
  assert.match(source, /explicit inclusive date interval/);
  assert.match(source, /narrow Wise-only query/);
  assert.match(source, /read-only search, message, and attachment/);
  assert.match(source, /never request Gmail write scopes/);
  assert.match(source, /never .*schedule/i);
  assert.match(source, /removes the envelope only after a durable ingest or quarantine result/);
  assert.doesNotMatch(source, /mcpServers:|allowed-tools:|client_secret|refresh_token/);
});
