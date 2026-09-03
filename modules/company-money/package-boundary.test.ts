import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
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

test("the public package recursively reaches only portable verticals", async () => {
  const root = new URL(".", import.meta.url).pathname;
  const files = await localImports(resolve(root, "company-money-public.ts"));
  assert.deepEqual(
    [...files].map((path) => relative(root, path)).sort(),
    [
      "company-money-contract.ts",
      "company-money-public.ts",
      "ledger/ingest.ts",
      "ledger/link-transfers.ts",
      "ledger/report.ts",
      "ledger/state.ts",
      "money.ts",
    ],
  );
});

test("the public package bundles for a browser while the Node entry does not", async () => {
  const publicEntry = new URL("./company-money-public.ts", import.meta.url).pathname;
  const result = await build({
    entryPoints: [publicEntry],
    bundle: true,
    format: "esm",
    logLevel: "silent",
    platform: "browser",
    write: false,
  });
  assert.equal(result.outputFiles.length, 1);
  assert.ok(result.outputFiles[0].contents.length > 0);

  await assert.rejects(
    () =>
      build({
        entryPoints: [new URL("./company-money-node.ts", import.meta.url).pathname],
        bundle: true,
        format: "esm",
        logLevel: "silent",
        platform: "browser",
        write: false,
      }),
    /Could not resolve "node:/,
  );
});

test("Wise translation has no Google, OAuth, credential, search, or write capability", async () => {
  const path = new URL("./evidence/wise-gmail.ts", import.meta.url).pathname;
  const source = await readFile(path, "utf8");
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  parsed.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
  });
  assert.deepEqual(imports, ["arktype", "../money.ts", "../ledger/ingest.ts", "../ledger/state.ts"]);
  assert.doesNotMatch(source, /googleapis|oauth|credential|messages\.(?:list|modify)|gmail\.users/i);
  assert.match(source, /translateWiseGmailEnvelope\(\s*value: unknown/);
});
