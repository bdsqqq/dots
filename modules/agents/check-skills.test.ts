import type { CheckOptions, Checker } from "./check-skills.ts";
import type { TestContext } from "node:test";
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync }: typeof import("node:fs") = require("node:fs");
const { spawnSync }: typeof import("node:child_process") = require("node:child_process");
const { tmpdir }: typeof import("node:os") = require("node:os");
const { join }: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const { checkSkills, defaultRoot, validName }: Checker = require("./check-skills.ts");

type FixturePaths = { root: string; agentDir: string; temp: string };
function fixture(t: TestContext, files: Record<string, string>, options?: CheckOptions): ReturnType<Checker["checkSkills"]>;
function fixture(t: TestContext, files: Record<string, string>, options: CheckOptions, inspect: (paths: FixturePaths) => Promise<void>): Promise<void>;
function fixture(t: TestContext, files: Record<string, string>, options: CheckOptions = {}, inspect?: (paths: FixturePaths) => Promise<void>): ReturnType<Checker["checkSkills"]> | Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), "check-skills-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "skills");
  const agentDir = join(temp, "empty-agent");
  mkdirSync(root);
  mkdirSync(agentDir);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  if (inspect) return inspect({ root, agentDir, temp });
  return checkSkills(root, { agentDir, ...options });
}
const skill = (name = "good", body = "", description = "A bounded test skill.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

test("canonical skills expose their names through the real native loader", async (t) => {
  const result = await fixture(t, {
    "good/SKILL.md": skill("good", "[guide](references/guide.md#heading)\n[site](https://example.com/no-file)"),
    "good/references/guide.md": "[asset][asset]\n\n[asset]: ../assets/data.json\n",
    "good/assets/data.json": "{}",
    "other/SKILL.md": skill("other"),
    ".hidden/skill.md": "not a skill",
    "good/.cache/SKILL.md": "not a skill",
    ".pi/skills/default-trap/SKILL.md": skill("default-trap"),
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.skills.map((item) => item.name).sort(), ["good", "other"]);
  assert.equal(result.fragments, 1);
});

test("fenced and inline code are not link references", async (t) => {
  const result = await fixture(t, {
    "good/SKILL.md": skill("good", [
      "```md", "[missing](no.md)", "```",
      "~~~~markdown", "[also missing](absent.md)", "~~~~",
      "`[inline](not-there.md)`", "[heading](#not-validated)",
    ].join("\n")),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.fragments, 1);
});

const badCases: [string, Record<string, string>, RegExp][] = [
  ["lowercase entry", { "good/skill.md": skill() }, /exactly SKILL\.md/],
  ["malformed yaml", { "good/SKILL.md": "---\nname: [\n---\n" }, /invalid frontmatter|native warning/],
  ["missing description", { "good/SKILL.md": "---\nname: good\n---\n" }, /description/],
  ["missing declared name", { "good/SKILL.md": "---\ndescription: Good\n---\n" }, /invalid name/],
  ["non-string description", { "good/SKILL.md": skill("good", "", "123") }, /description/],
  ["long description", { "good/SKILL.md": skill("good", "", "x".repeat(1025)) }, /description/],
  ["invalid name", { "good/SKILL.md": skill("bad--name") }, /invalid name/],
  ["long name", { "good/SKILL.md": skill("x".repeat(65)) }, /invalid name/],
  ["name mismatch", { "good/SKILL.md": skill("other") }, /name must match directory/],
  ["duplicate name", { "good/SKILL.md": skill(), "other/SKILL.md": skill() }, /duplicate name/],
  ["broken reference", { "good/SKILL.md": skill("good", "[guide](references/absent.md)") }, /broken reference/],
  ["standalone loader entry", { "loose.md": skill("loose") }, /discovered without canonical source/],
  ["ignored canonical source", {
    ".gitignore": "good/\n",
    "good/SKILL.md": skill(),
  }, /source not discovered/],
  ["nested hidden skill", {
    "good/SKILL.md": skill(),
    "good/nested/SKILL.md": skill("nested"),
  }, /nested skill/],
  ["metadata map values", {
    "good/SKILL.md": "---\nname: good\ndescription: Good\nmetadata:\n  number: 42\n---\n",
  }, /metadata must map/],
  ["absolute nonportable link", {
    "good/SKILL.md": skill("good", "[local](/tmp/local.md)"),
  }, /nonportable absolute link/],
  ["repository escape even when target exists", {
    "good/SKILL.md": skill("good", "[code](../../repo-code.ts)"),
    "../repo-code.ts": "export {};",
  }, /nonportable link outside skill resources/],
];
for (const [name, files, expected] of badCases) {
  test(`rejects ${name} with real loader fixtures`, async (t) => {
    const result = await fixture(t, files);
    assert.match(result.errors.join("\n"), expected);
  });
}

test("archival crosslinks warn by default but fail the opt-in audit", async (t) => {
  await fixture(t, {
    "good/SKILL.md": skill("good", "[article](references/article.md)"),
    "good/references/article.md": "[old code][ref]\n\n[ref]: old-code.md",
  }, {}, async ({ root, agentDir }) => {
    const normal = await checkSkills(root, { agentDir });
    assert.deepEqual(normal.errors, []);
    assert.equal(normal.warnings.length, 1);
    assert.match(normal.warnings[0], /broken reference old-code.md/);
    assert.deepEqual(normal.linkCounts, { entrypoint: 1, supporting: 1 });
    const strict = await checkSkills(root, { agentDir, allDocumentLinks: true });
    assert.deepEqual(strict.warnings, []);
    assert.match(strict.errors.join("\n"), /broken reference old-code.md/);

    const cli = join(__dirname, "check-skills.ts");
    const invoke = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8" });
    const defaultRun = invoke("--root", root);
    assert.equal(defaultRun.status, 0, defaultRun.stderr);
    assert.match(defaultRun.stdout, /0 errors; 1 warnings/);
    const audit = invoke("--all-document-links", "--root", root);
    assert.equal(audit.status, 1, audit.stderr);
    assert.match(audit.stdout, /1 errors; 0 warnings/);
    assert.match(audit.stderr, /broken reference old-code.md/);
  });
});

test("managed directory symlinks retain native parity and portable sibling references", async (t) => {
  await fixture(t, {}, {}, async ({ root, temp, agentDir }) => {
    const sources = join(temp, "managed-sources");
    for (const name of ["good", "review"]) {
      const dir = join(sources, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), skill(name,
        name === "good" ? "[review](../review/SKILL.md)\n[resource](resource.txt)" : ""));
      symlinkSync(dir, join(root, name), "dir");
    }
    writeFileSync(join(sources, "good", "resource.txt"), "bundled");
    const result = await checkSkills(root, { agentDir });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.skills.map((item) => item.name).sort(), ["good", "review"]);
    const cli = join(__dirname, "check-skills.ts");
    const run = spawnSync(process.execPath, ["--experimental-strip-types", cli, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /2 canonical sources; 2 native skills; 0 errors/);
  });
});

test("behavior cases have a valid schema and refer to known skill names; NOT model evaluations", async (t) => {
  const cases: unknown = JSON.parse(readFileSync(join(__dirname, "skill-cases.json"), "utf8"));
  assert.ok(Array.isArray(cases) && cases.length >= 10);
  const agentDir = mkdtempSync(join(tmpdir(), "skill-cases-agent-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const known = new Set((await checkSkills(defaultRoot, { agentDir })).skills.map((item) => item.name));
  const ids = new Set<string>();
  for (const value of cases) {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    const entry = value as Record<string, unknown>;
    assert.deepEqual(Object.keys(entry).sort(),
      ["id", "prompt", "expectedSkills", "forbiddenSkills", "expectedBehavior"].sort());
    assert.ok(validName(entry.id), `invalid case id: ${entry.id}`);
    assert.ok(!ids.has(entry.id), `duplicate case id: ${entry.id}`);
    ids.add(entry.id);
    for (const field of ["prompt", "expectedBehavior"]) {
      const text = entry[field];
      assert.equal(typeof text, "string");
      assert.ok(typeof text === "string" && text.trim());
    }
    for (const field of ["expectedSkills", "forbiddenSkills"]) {
      assert.ok(Array.isArray(entry[field]));
      assert.equal(new Set(entry[field]).size, entry[field].length);
      for (const name of entry[field]) {
        assert.ok(validName(name), `invalid skill name: ${name}`);
        assert.ok(known.has(name), `unknown skill name: ${name}`);
      }
    }
    const expected = entry.expectedSkills as string[];
    const forbidden = entry.forbiddenSkills as string[];
    assert.ok(expected.every((name) => !forbidden.includes(name)));
  }
});
