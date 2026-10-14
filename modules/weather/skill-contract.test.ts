// Static case schema and an executable weather example; not model routing evals.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";

const modules = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["remindctl", "goplaces", "openhue", "xurl", "weather", "obsidian"];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("case fixtures cover positive, negative, and overlapping requests", () => {
  for (const name of names) {
    const data: unknown = JSON.parse(readFileSync(join(modules, name, "skill-cases.json"), "utf8"));
    assert.ok(record(data));
    assert.ok(Array.isArray(data.cases));
    const kinds = new Set<string>();
    for (const candidate of data.cases) {
      const value: unknown = candidate;
      assert.ok(record(value));
      assert.equal(typeof value.kind, "string");
      if (typeof value.kind !== "string") throw new Error("invalid case kind");
      kinds.add(value.kind);
      assert.ok(typeof value.prompt === "string" && value.prompt.length > 0);
      assert.ok(typeof value.acceptance === "string" && value.acceptance.length > 0);
      assert.ok(value.expectedSkill === null ||
        (typeof value.expectedSkill === "string" && [...names, "gog"].includes(value.expectedSkill)));
    }
    assert.deepEqual(kinds, new Set(["positive", "negative", "overlap"]));
    assert.ok(typeof data.status === "string" && data.status.includes("not executed"));
    assert.ok(typeof data.adversarial === "string" && data.adversarial.length > 0);
  }
});

test("weather example accepts JSON and rejects known malformed responses", () => {
  const body = readFileSync(join(modules, "weather", "SKILL.md"), "utf8");
  const example = /```sh\n([\s\S]*?)\n```/.exec(body)?.[1];
  assert.ok(example);
  const fixtures = [
    { response: JSON.stringify({ nearest_area: [], current_condition: [{ temp_C: "21" }], weather: [] }), valid: true },
    { response: JSON.stringify({ error: "upstream failure" }), valid: false },
    { response: "<html>service unavailable</html>", valid: false },
  ];
  for (const fixture of fixtures) {
    const dir = mkdtempSync(join(tmpdir(), "weather-fixture-"));
    try {
      writeFileSync(join(dir, "response"), fixture.response);
      writeFileSync(join(dir, "curl"), '#!/bin/sh\ncat "$WEATHER_FIXTURE"\n');
      chmodSync(join(dir, "curl"), 0o755);
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-c", example], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WEATHER_FIXTURE: join(dir, "response") },
        timeout: 5000,
      });
      assert.equal(result.status === 0, fixture.valid, result.stderr);
      if (fixture.valid) {
        const output: unknown = JSON.parse(result.stdout);
        assert.ok(record(output) && Array.isArray(output.current));
        const current: unknown = output.current[0];
        assert.ok(record(current));
        assert.equal(current.temp_C, "21");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
