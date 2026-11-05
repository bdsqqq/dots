import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { generate } from "../scripts/generate.ts";
import type { SchemaCatalog } from "../src/discovery.ts";
import type { SourceInventory } from "../scripts/har.ts";
const root = fileURLToPath(new URL("..", import.meta.url));
const catalog: SchemaCatalog = JSON.parse(
  readFileSync(join(root, "inventory/firmware.json"), "utf8"),
);
const sources: SourceInventory = JSON.parse(
  readFileSync(join(root, "inventory/sources.json"), "utf8"),
);

test("every catalog node and command is projected exactly once; generation is deterministic", () => {
  const outputs = generate(catalog, sources);
  assert.deepEqual([...outputs], [...generate(catalog, sources)]);
  const model = ts.createSourceFile(
    "generated.ts",
    outputs.get("src/model.generated.ts")!,
    ts.ScriptTarget.Latest,
    true,
  );
  const interfaces = new Map(
    model.statements.filter(ts.isInterfaceDeclaration).map((i) => [i.name.text, i]),
  );
  assert.equal(interfaces.get("ModelValues")?.members.length, catalog.nodes.length);
  assert.equal(
    interfaces.get("WritableValues")?.members.length,
    catalog.nodes.filter((n) => n.flags.value && n.flags.config).length,
  );
  const commands = catalog.nodes.flatMap((n) => n.commands.map((c) => n.path + "#" + c.name));
  for (const name of ["CommandInputs", "CommandOutputs"]) {
    const keys = interfaces
      .get(name)!
      .members.map((m) => (m.name && ts.isStringLiteral(m.name) ? m.name.text : ""));
    assert.deepEqual(keys, commands);
  }
  for (const [path, content] of outputs)
    assert.equal(readFileSync(join(root, path), "utf8"), content);
});

test("adding an advertised operation needs no parallel handwritten registry", () => {
  const changed = structuredClone(catalog);
  changed.nodes[0]!.commands.push({
    name: "fixtureThirdOperation",
    interface: "Fixture",
    input: [{ name: "Input", type: "xmo:str xmo:value", flags: { value: true } }],
    output: [],
  });
  const generated = generate(changed, sources);
  assert.match(
    generated.get("src/model.generated.ts")!,
    /fixtureThirdOperation.*\{ "Input"\?: string \}/,
  );
  assert.match(generated.get("API.md")!, /fixtureThirdOperation/);
});

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sagemcom-fast3896-claro-check-"));
  for (const path of [
    "src",
    "scripts",
    "inventory",
    "package.json",
    "tsconfig.json",
    "tsconfig.build.json",
  ])
    cpSync(join(root, path), join(dir, path), { recursive: true });
  mkdirSync(join(dir, "test"));
  cpSync(join(root, "test/consumer-types.ts"), join(dir, "test/consumer-types.ts"));
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  for (const [path, content] of generate(catalog, sources)) writeFileSync(join(dir, path), content);
  return dir;
}
function run(dir: string, args: string[]) {
  return spawnSync("pnpm", args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
}

test("actual check entrypoint detects stale, missing and changed-input outputs without repairing them", () => {
  const dir = copyFixture();
  try {
    for (const mode of ["stale", "missing", "input"]) {
      for (const [path, content] of generate(catalog, sources))
        writeFileSync(join(dir, path), content);
      writeFileSync(join(dir, "inventory/firmware.json"), JSON.stringify(catalog));
      const output = join(dir, "src/model.generated.ts");
      if (mode === "stale") writeFileSync(output, "// deliberate corruption\n");
      if (mode === "missing") rmSync(output);
      if (mode === "input") {
        const altered = structuredClone(catalog);
        altered.identity.SoftwareVersion = "fixture-changed";
        writeFileSync(join(dir, "inventory/firmware.json"), JSON.stringify(altered));
      }
      const before = existsSync(output) ? readFileSync(output, "utf8") : undefined;
      const result = run(dir, ["run", "check"]);
      assert.notEqual(result.status, 0, mode);
      assert.match(result.stdout + result.stderr, /stale generated output/, mode);
      assert.equal(
        existsSync(output) ? readFileSync(output, "utf8") : undefined,
        before,
        mode + " must not repair output",
      );
      const regenerated = run(dir, ["run", "generate"]);
      assert.equal(regenerated.status, 0, regenerated.stderr);
      const checked = run(dir, ["run", "catalog:check"]);
      assert.equal(checked.status, 0, checked.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative consumer type tests detect a deliberately loosened return type", () => {
  const dir = copyFixture();
  try {
    const before = run(dir, ["run", "typecheck"]);
    assert.equal(before.status, 0, before.stdout + before.stderr);
    const path = join(dir, "src/model.ts");
    const source = readFileSync(path, "utf8");
    assert.ok(source.includes("Promise<ModelValue<P>>"));
    writeFileSync(path, source.replace("Promise<ModelValue<P>>", "Promise<any>"));
    const broken = run(dir, ["run", "typecheck"]);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stdout + broken.stderr, /Unused '@ts-expect-error' directive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source literal seeds are accounted for by the captured discovery boundary", () => {
  for (const path of new Set(sources.paths.map((p) => p.path)))
    assert.ok(catalog.coverage.queriedPaths.includes(path), path);
  assert.equal(catalog.coverage.limitsReached, false);
});
