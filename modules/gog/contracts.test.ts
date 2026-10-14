import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const { checkSkills } = createRequire(import.meta.url)("../agents/check-skills.ts") as
  import("../agents/check-skills.ts").Checker;

for (const name of ["gog", "wacli"]) {
  test(`${name}: source discovery and explicit selection/behavior fixtures`, async () => {
    const root = resolve("modules", name);
    const result = await checkSkills(root);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.skills.map(skill => skill.name), [name]);
    const cases: unknown = JSON.parse(readFileSync(join(root, "skill-cases.json"), "utf8"));
    assert(Array.isArray(cases));
    const ids = new Set<string>();
    const shapes = new Set<string>();
    for (const value of cases) {
      assert(value && typeof value === "object");
      assert("id" in value && typeof value.id === "string");
      assert(!ids.has(value.id)); ids.add(value.id);
      assert("prompt" in value && typeof value.prompt === "string" && value.prompt.length > 20);
      for (const key of ["expectedSkills", "forbiddenSkills", "expectedActions", "forbiddenActions"]) {
        assert(key in value);
        const field: unknown = Reflect.get(value, key);
        assert(Array.isArray(field) && field.every(item => typeof item === "string"));
      }
      const expected: unknown = Reflect.get(value, "expectedSkills");
      const forbidden: unknown = Reflect.get(value, "forbiddenSkills");
      assert(Array.isArray(expected) && Array.isArray(forbidden));
      assert(expected.every(skill => ["gog", "wacli"].includes(skill) && !forbidden.includes(skill)));
      shapes.add(expected.includes(name) ? "positive" : expected.length ? "overlap" : "negative");
    }
    assert.deepEqual([...shapes].sort(), ["negative", "overlap", "positive"]);
  });
}

test("checker rejects a known malformed skill in an isolated fixture", async () => {
  const root = mkdtempSync(join(tmpdir(), "gog-skill-negative-"));
  try {
    writeFileSync(join(root, "SKILL.md"), "---\nname: invalid--name\n---\n");
    const result = await checkSkills(root);
    assert(result.errors.some(error => error.includes("invalid name")));
    assert(result.errors.some(error => error.includes("description")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
