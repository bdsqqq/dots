import type { Checker } from "./check-skills.ts";
import type { TestContext } from "node:test";
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
}: typeof import("node:fs") = require("node:fs");
const { tmpdir }: typeof import("node:os") = require("node:os");
const { dirname, join, resolve }: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const { checkSkills }: Checker = require("./check-skills.ts");

const modulesRoot = resolve(__dirname, "..");
const names = ["gog", "wacli", "goplaces", "openhue", "xurl", "weather", "remindctl", "obsidian"];
const aliases = [".config/agents/skills", ".agents/skills", ".claude/skills", ".cursor/skills"];

function temporary(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "cli-live-skills-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function assertEntrypoints(modules: string): void {
  for (const name of names) {
    const directory = join(modules, "agents/skills", name);
    const entry = join(directory, "SKILL.md");
    assert.ok(lstatSync(directory).isDirectory(), `${name}: link the entry, not the module directory`);
    assert.ok(lstatSync(entry).isSymbolicLink(), `${name}: entry must be a real symlink`);
    assert.equal(readlinkSync(entry), `../../../${name}/SKILL.md`);
    assert.equal(realpathSync(entry), realpathSync(join(modules, name, "SKILL.md")));
  }
}

/** Guard the literal file targets used by these modules; native HM evaluation
 * remains responsible for computed targets and module merge semantics. */
function assertSharedRootOwnership(modules: string): void {
  const owner = readFileSync(join(modules, "agents/default.nix"), "utf8");
  for (const alias of aliases) {
    assert.ok(owner.includes(`"${alias}".source = skills;`), `missing shared root alias: ${alias}`);
  }
  for (const directory of readdirSync(modules, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const path = join(modules, directory.name, "default.nix");
    let source: string;
    try { source = readFileSync(path, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    // Covers both home.file."target" and quoted keys inside a home.file block.
    for (const match of source.matchAll(/"([^"\n]+)"\s*(?=\.|=)/g)) {
      const target = match[1];
      for (const alias of aliases) {
        assert.ok(!target.startsWith(`${alias}/`), `${path}: root/descendant home.file overlap: ${target}`);
        if (target === alias) assert.equal(directory.name, "agents", `${path}: duplicate shared root owner`);
      }
    }
  }
}

test("all eight CLI entrypoints are relative file links with one shared home.file owner", () => {
  assertEntrypoints(modulesRoot);
  assertSharedRootOwnership(modulesRoot);
});

test("isolated known-bad leaf declarations fail the ownership guard for every alias", (t) => {
  const modules = join(temporary(t), "modules");
  for (const name of ["agents", "gog"]) mkdirSync(join(modules, name), { recursive: true });
  writeFileSync(join(modules, "agents/default.nix"), readFileSync(join(modulesRoot, "agents/default.nix")));
  const good = readFileSync(join(modulesRoot, "gog/default.nix"), "utf8");
  const path = join(modules, "gog/default.nix");
  writeFileSync(path, good);
  assertSharedRootOwnership(modules);
  for (const alias of aliases) {
    const bad = good.replace(/}\s*$/, `  home.file."${alias}/gog/SKILL.md".source = ./SKILL.md;\n}\n`);
    assert.notEqual(bad, good);
    writeFileSync(path, bad);
    assert.throws(() => assertSharedRootOwnership(modules), /root\/descendant home.file overlap/);
  }
  writeFileSync(path, good.replace(/}\s*$/, '  home.file.".agents/skills".source = ./skills;\n}\n'));
  assert.throws(() => assertSharedRootOwnership(modules), /duplicate shared root owner/);
});

test("SDK discovers file entry links through all installed aliases and sees ordinary program writes", async (t) => {
  const temp = temporary(t);
  const modules = join(temp, "checkout/modules");
  const root = join(modules, "agents/skills");
  const agentDir = join(temp, "empty-agent");
  mkdirSync(agentDir);
  // Copy only canonical bodies into the isolated checkout; use the exact live
  // relative entry links. No writes can reach the real checkout or user home.
  for (const name of names) {
    mkdirSync(join(modules, name), { recursive: true });
    writeFileSync(join(modules, name, "SKILL.md"), readFileSync(join(modulesRoot, name, "SKILL.md")));
    mkdirSync(join(root, name), { recursive: true });
    symlinkSync(readlinkSync(join(modulesRoot, "agents/skills", name, "SKILL.md")), join(root, name, "SKILL.md"));
  }
  assertEntrypoints(modules);
  const paths = aliases.map((alias) => join(temp, "home", alias));
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(root, path, "dir");
  }
  const expected = [...names];
  async function assertDiscovery(path: string): Promise<void> {
    const result = await checkSkills(path, { agentDir });
    assert.deepEqual(result.errors, [], path);
    assert.deepEqual(result.skills.map((skill) => skill.name).sort(), [...expected].sort(), path);
  }
  for (const [index, path] of paths.entries()) {
    await assertDiscovery(path);
    const name = `program-installed-${index}`;
    const directory = join(path, name);
    mkdirSync(directory);
    writeFileSync(join(directory, "SKILL.md.tmp"), `---\nname: ${name}\ndescription: Installed by a program.\n---\n`);
    renameSync(join(directory, "SKILL.md.tmp"), join(directory, "SKILL.md"));
    expected.push(name);
    assert.ok(lstatSync(path).isSymbolicLink(), "native write must preserve root link");
    assert.equal(realpathSync(join(directory, "SKILL.md")), realpathSync(join(root, name, "SKILL.md")));
    await assertDiscovery(root);
  }
  for (const path of paths) await assertDiscovery(path);
});
