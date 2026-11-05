import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
function checkMarkdown(text: string, file: string): void {
  assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, "unbalanced code fences");
  for (const link of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const path = link[1]!.split("#")[0]!;
    if (!path || /^[a-z]+:/i.test(path)) continue;
    assert.ok(
      existsSync(resolve(dirname(file), path)),
      `missing local documentation link: ${path}`,
    );
  }
}
test("package documentation has balanced fences and existing local links", () => {
  for (const path of ["../README.md", "../API.md", "../RUNBOOK.md"]) {
    const file = fileURLToPath(new URL(path, import.meta.url));
    checkMarkdown(readFileSync(file, "utf8"), file);
  }
});
test("documentation check catches a missing link and an unclosed fence", () => {
  const file = fileURLToPath(new URL("../README.md", import.meta.url));
  assert.throws(
    () => checkMarkdown("[missing](./deliberately-missing-file.md)", file),
    /missing local documentation link/,
  );
  assert.throws(() => checkMarkdown("```ts\nconst x=1;", file), /unbalanced code fences/);
});
