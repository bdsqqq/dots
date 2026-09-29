import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { before, test, type TestContext } from "node:test";

const root: string = resolve(dirname(process.argv[1]), "../..");
const host: string = ".#darwinConfigurations.mbp-m2";
let hook: string;
let coreutils: string;
let bash: string;
let caseInsensitive: boolean;

function evaluate(attribute: string, ...options: string[]): string {
  return execFileSync(
    "nix", ["eval", "--no-write-lock-file", ...options, attribute],
    { cwd: root, encoding: "utf8", timeout: 180_000 },
  );
}

before((): void => {
  hook = evaluate(
    `${host}.config.home-manager.users.bdsqqq.home.activation.normalizeDataVisualizationSkillCase.data`,
    "--raw",
  );
  const tools: unknown = JSON.parse(evaluate(
    `${host}.pkgs`, "--json", "--apply",
    "pkgs: { coreutils = pkgs.coreutils.outPath; bash = pkgs.bash.outPath; }",
  ));
  assert.ok(typeof tools === "object" && tools !== null);
  assert.ok("coreutils" in tools && typeof tools.coreutils === "string");
  assert.ok("bash" in tools && typeof tools.bash === "string");
  coreutils = join(tools.coreutils, "bin");
  bash = join(tools.bash, "bin/bash");
  for (const executable of [bash, join(coreutils, "mv"), join(coreutils, "readlink")]) {
    assert.ok(statSync(executable).isFile(), `tool not realized: ${executable}`);
  }
  const directory: string = mkdtempSync(join(tmpdir(), "skill-case-fs-"));
  try {
    const lower: string = join(directory, "skill.md");
    const upper: string = join(directory, "SKILL.md");
    writeFileSync(lower, "");
    caseInsensitive = existsSync(upper)
      && statSync(lower).ino === statSync(upper).ino;
  } finally {
    rmSync(directory, { recursive: true });
  }
  console.log(`filesystem: ${process.platform}, case-insensitive inode aliases=${caseInsensitive}`);
  if (process.platform !== "darwin" || !caseInsensitive) {
    console.warn("WARNING: native case-insensitive Darwin coverage unavailable");
  }
});

interface ActivationOptions {
  dryRun?: boolean;
  failSecondMove?: boolean;
}

interface EntrySnapshot {
  name: string;
  inode: number;
  symlink: boolean;
  content: string;
}

class Fixture {
  readonly root: string;
  readonly home: string;
  readonly directory: string;
  readonly target: string;
  readonly newGeneration: string;
  readonly lower: string;
  readonly upper: string;
  readonly temporary: string;

  constructor(t: TestContext) {
    // Darwin's /var alias must match GNU readlink -e's physical target.
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "skill-case-repair-")));
    t.after((): void => rmSync(this.root, { recursive: true }));
    this.home = join(this.root, "home");
    const relative: string = ".config/agents/skills/data-visualization";
    this.directory = join(this.home, relative);
    mkdirSync(this.directory, { recursive: true });
    const store: string = join(this.root, "fake-store");
    const files: string = join(store, "home-files");
    this.target = join(files, relative, "SKILL.md");
    mkdirSync(dirname(this.target), { recursive: true });
    writeFileSync(this.target, "---\nname: data-visualization\ndescription: fixture\n---\nfixture\n");
    const generation: string = join(store, "generation");
    mkdirSync(generation);
    symlinkSync(files, join(generation, "home-files"), "dir");
    this.newGeneration = join(this.root, "new-generation");
    symlinkSync(generation, this.newGeneration, "dir");
    this.lower = join(this.directory, "skill.md");
    this.upper = join(this.directory, "SKILL.md");
    this.temporary = join(this.directory, ".SKILL.md.home-manager-case");
  }

  link(): number {
    symlinkSync(this.target, this.lower);
    if (caseInsensitive) {
      assert.equal(statSync(this.lower).ino, statSync(this.upper).ino);
      assert.equal(lstatSync(this.lower).ino, lstatSync(this.upper).ino);
    }
    return lstatSync(this.lower).ino;
  }

  snapshot(): EntrySnapshot[] {
    return readdirSync(this.directory).sort().map((name: string): EntrySnapshot => {
      const entry: string = join(this.directory, name);
      const symlink: boolean = lstatSync(entry).isSymbolicLink();
      return {
        name, inode: lstatSync(entry).ino, symlink,
        content: symlink ? readlinkSync(entry) : readFileSync(entry).toString("base64"),
      };
    });
  }

  activate(options: ActivationOptions = {}): SpawnSyncReturns<string> {
    // Only HM's execution boundary is stubbed; the hook is evaluated verbatim.
    let boundary: string = `
set -e
run() {
  if [[ -n "\${DRY_RUN:-}" ]]; then return 0; fi
  "$@"
}
errorEcho() { printf '%s\\n' "$*" >&2; }
`;
    if (options.failSecondMove) {
      boundary += `
mv() {
  if [[ "\${@: -1}" == "$HOME/.config/agents/skills/data-visualization/SKILL.md" ]]; then
    printf '%s\\n' 'injected second-move failure' >&2
    return 73
  fi
  command mv "$@"
}
`;
    }
    const result: SpawnSyncReturns<string> = spawnSync(
      bash, ["--noprofile", "--norc", "-c", boundary + hook],
      {
        env: {
          HOME: this.home, newGenPath: this.newGeneration,
          PATH: coreutils, LC_ALL: "C", ...(options.dryRun ? { DRY_RUN: "1" } : {}),
        },
        cwd: this.root, encoding: "utf8", timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, null);
    return result;
  }
}

function assertSuccess(result: SpawnSyncReturns<string>): void {
  assert.equal(result.status, 0, result.stderr);
}

test("repairs exact directory-entry casing and is idempotent", (t: TestContext): void => {
  const fixture: Fixture = new Fixture(t);
  const inode: number = fixture.link();
  assertSuccess(fixture.activate());
  assert.deepEqual(readdirSync(fixture.directory), ["SKILL.md"]);
  assert.ok(lstatSync(fixture.upper).isSymbolicLink());
  assert.equal(readlinkSync(fixture.upper), fixture.target);
  assert.equal(lstatSync(fixture.upper).ino, inode);
  assert.deepEqual(readFileSync(fixture.upper), readFileSync(fixture.target));
  const repaired: EntrySnapshot[] = fixture.snapshot();
  assertSuccess(fixture.activate());
  assert.deepEqual(fixture.snapshot(), repaired);
});

test("dry-run preserves the original link", (t: TestContext): void => {
  const fixture: Fixture = new Fixture(t);
  fixture.link();
  const before: EntrySnapshot[] = fixture.snapshot();
  assertSuccess(fixture.activate({ dryRun: true }));
  assert.deepEqual(fixture.snapshot(), before);
});

test("unrelated symlink remains untouched", (t: TestContext): void => {
  const fixture: Fixture = new Fixture(t);
  symlinkSync(join(fixture.root, "unrelated"), fixture.lower);
  const before: EntrySnapshot[] = fixture.snapshot();
  assertSuccess(fixture.activate());
  assert.deepEqual(fixture.snapshot(), before);
});

test("regular file remains untouched", (t: TestContext): void => {
  const fixture: Fixture = new Fixture(t);
  writeFileSync(fixture.lower, "user-owned");
  const before: EntrySnapshot[] = fixture.snapshot();
  assertSuccess(fixture.activate());
  assert.deepEqual(fixture.snapshot(), before);
});

test("uppercase link remains untouched", (t: TestContext): void => {
  const fixture: Fixture = new Fixture(t);
  symlinkSync(fixture.target, fixture.upper);
  const before: EntrySnapshot[] = fixture.snapshot();
  assertSuccess(fixture.activate());
  assert.deepEqual(fixture.snapshot(), before);
});

test("temporary collision fails and preserves both entries", (t: TestContext): void => {
  const fixture: Fixture = new Fixture(t);
  fixture.link();
  writeFileSync(fixture.temporary, "user-owned collision");
  const before: EntrySnapshot[] = fixture.snapshot();
  assert.notEqual(fixture.activate().status, 0);
  assert.deepEqual(fixture.snapshot(), before);
});

test("second-move failure rolls back the original link", (t: TestContext): void => {
  const fixture: Fixture = new Fixture(t);
  fixture.link();
  const before: EntrySnapshot[] = fixture.snapshot();
  const result: SpawnSyncReturns<string> = fixture.activate({ failSecondMove: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /injected second-move failure/);
  assert.deepEqual(fixture.snapshot(), before);
});
