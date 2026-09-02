import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { build } from "esbuild";
import ts from "typescript";

async function localImports(path: string, seen = new Set<string>()): Promise<Set<string>> {
  if (seen.has(path)) return seen;
  seen.add(path);
  const source = ts.createSourceFile(
    path,
    await readFile(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [];
  source.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
  });
  for (const specifier of imports) {
    assert.equal(specifier.startsWith("node:"), false, `${path} imports ${specifier}`);
    if (specifier.startsWith(".")) {
      await localImports(resolve(dirname(path), specifier), seen);
    }
  }
  return seen;
}

test("the public package export cannot reach Node runtime modules", async () => {
  const files = await localImports(new URL("./fleet-public.ts", import.meta.url).pathname);
  assert.deepEqual(
    [...files].map((path) => path.split("/").at(-1)).sort(),
    ["fleet-contract.ts", "fleet-operations.ts", "fleet-public.ts", "fleet-schema.ts"],
  );
});

test("the public package entry bundles for a browser", async () => {
  const result = await build({
    entryPoints: [new URL("./fleet-public.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    logLevel: "silent",
    platform: "browser",
    write: false,
  });
  assert.equal(result.outputFiles.length, 1);
  assert.ok(result.outputFiles[0].contents.length > 0);
});

test("the Node package entry is unavailable to browser bundles", async () => {
  await assert.rejects(
    () =>
      build({
        entryPoints: [new URL("./fleet-node.ts", import.meta.url).pathname],
        bundle: true,
        format: "esm",
        logLevel: "silent",
        platform: "browser",
        write: false,
      }),
    /Could not resolve "node:/,
  );
});
