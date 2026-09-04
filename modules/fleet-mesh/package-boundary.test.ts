import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { build } from "esbuild";
import ts from "typescript";

const execFileAsync = promisify(execFile);

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
    assert.notEqual(specifier, "@orpc/server", `${path} imports local oRPC binding`);
    if (specifier.startsWith(".")) {
      await localImports(resolve(dirname(path), specifier), seen);
    }
  }
  return seen;
}

test("the public package export cannot reach Node runtime modules", async () => {
  await localImports(new URL("./fleet-public.ts", import.meta.url).pathname);
});

test("the public package exposes behavior without its local binding", async () => {
  const publicModule = await import("./fleet-public.ts");
  assert.deepEqual(Object.keys(publicModule.fleetSchemaCatalog), [
    "fleet.json-value",
    "fleet.no-input",
    "fleet.node-id",
    "fleet.revision",
    "fleet.public-identity",
    "fleet.command-envelope",
    "fleet.receipt-envelope",
    "fleet.mesh-record",
    "fleet.mesh-node-snapshot",
    "fleet.node-summary",
    "fleet.node-summary-list",
    "fleet.node-description",
    "fleet.node-presence",
    "fleet.node-not-found",
    "fleet.desired-state-set-input",
    "fleet.desired-state-submission",
    "fleet.desired-state-status",
    "fleet.command-not-found",
  ]);
  assert.deepEqual(Object.keys(publicModule).sort(), [
    "CommandEnvelopeV1Schema",
    "CommandNotFoundV1Schema",
    "DesiredStateSetInputV1Schema",
    "DesiredStateStatusV1Schema",
    "DesiredStateSubmissionV1Schema",
    "FleetNodeDescriptionV1Schema",
    "FleetNodePresenceV1Schema",
    "FleetNodeSummaryListV1Schema",
    "FleetNodeSummaryV1Schema",
    "JsonValueV1Schema",
    "MeshNodeSnapshotV1Schema",
    "MeshRecordV1Schema",
    "NoInputV1Schema",
    "NodeIdV1Schema",
    "NodeNotFoundV1Schema",
    "PublicIdentityV1Schema",
    "ReceiptEnvelopeV1Schema",
    "RevisionV1Schema",
    "describeFleetNode",
    "desiredStateContract",
    "fleetContract",
    "fleetNodeExists",
    "fleetSchemaCatalog",
    "getDesiredStateStatus",
    "listFleetNodes",
    "setDesiredState",
    "validateV1JsonValue",
    "validateV1MeshNodeSnapshot",
    "validateV1MeshRecord",
    "validateV1MeshRecords",
    "validateV1Revision",
  ]);
});

test("the Node package preserves its explicit runtime surface", async () => {
  const nodeModule = await import("./fleet-node.ts");
  assert.deepEqual(Object.keys(nodeModule).sort(), [
    "DesiredStateRevisionStateV1Schema",
    "FileDesiredStateController",
    "FleetAuthority",
    "LocalFleetRuntime",
    "MeshNode",
    "createDesiredStateClient",
    "createDesiredStateRouter",
    "createFleetClient",
    "createFleetRouter",
    "createNodeIdentity",
    "decryptCommand",
    "fleetDaemonMain",
    "loadFleetDaemonConfiguration",
    "loadLocalFleetRuntimeOptions",
    "publicIdentity",
    "readSnapshot",
    "reconcile",
    "startConfiguredFleetDaemon",
    "startMeshDaemon",
    "validateAuthorityPublicKey",
    "validateFleetDaemonConfiguration",
    "validateNodeIdentityKeys",
    "writeSnapshot",
  ]);
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

test("the bundled fleet executable loads CommonJS dependencies from ESM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-bundle-"));
  try {
    const outfile = join(directory, "fleet.mjs");
    const result = await build({
      entryPoints: [new URL("./fleet-bin.ts", import.meta.url).pathname],
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
      bundle: true,
      format: "esm",
      logLevel: "silent",
      outfile,
      platform: "node",
      target: "node22",
      write: false,
    });
    await writeFile(outfile, result.outputFiles[0].contents);
    const { stdout } = await execFileAsync(process.execPath, [outfile, "--help"]);
    assert.match(stdout, /desired-state set/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
