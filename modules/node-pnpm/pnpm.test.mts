import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./pnpm.mts", import.meta.url));
const pnpm = process.env.PNPM_TEST_BINARY ?? "pnpm";
const builtLauncher = process.env.PNPM_TEST_LAUNCHER;

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "tracked-pnpm-")));
  const tools = join(directory, "tools");
  const caller = join(directory, "caller");
  const home = join(directory, "home");
  for (const dir of [tools, caller, home]) mkdirSync(dir);
  copyFileSync(source, join(tools, "pnpm.mts"));
  const json = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  json(join(tools, "package.json"), {
    name: "tools",
    private: true,
    dependencies: { bridge: "workspace:*" },
  });
  writeFileSync(join(tools, "pnpm-workspace.yaml"), "packages:\n  - bridge\n");
  mkdirSync(join(tools, "bridge"));
  json(join(tools, "bridge/package.json"), { name: "bridge", version: "1.0.0" });
  json(join(caller, "package.json"), {
    name: "caller",
    private: true,
    scripts: { fail: "exit 23" },
  });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    CI: "true",
    PNPM_HOME: join(home, "pnpm"),
    NODE_OPTIONS: "",
    NODE_NO_WARNINGS: "0",
  };
  const run = (args: string[], binary = pnpm) =>
    spawnSync(process.execPath, [join(tools, "pnpm.mts"), binary, ...args], {
      cwd: caller,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  const ok = (args: string[]) => {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
    assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON|ExperimentalWarning/);
    return result.stdout.trim();
  };
  const tarball = (version: string) => {
    const root = join(directory, version);
    mkdirSync(join(root, "package"), { recursive: true });
    json(join(root, "package/package.json"), {
      name: "fixture-cli",
      version,
      bin: { "fixture-cli": "cli.cjs" },
    });
    writeFileSync(
      join(root, "package/cli.cjs"),
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
    );
    chmodSync(join(root, "package/cli.cjs"), 0o755);
    const path = join(directory, `fixture-cli-${version}.tgz`);
    const packed = spawnSync("tar", ["-czf", path, "package"], { cwd: root, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    return path;
  };
  return {
    directory,
    tools,
    caller,
    home,
    env,
    run,
    ok,
    tarball,
    json,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function assertGlobalInstall(tools: string, caller: string) {
  const manifest = JSON.parse(readFileSync(join(tools, "package.json"), "utf8"));
  assert.ok(
    manifest.dependencies["fixture-cli"],
    "global dependency must be saved in the tracked manifest",
  );
  assert.match(readFileSync(join(tools, "pnpm-lock.yaml"), "utf8"), /fixture-cli/);
  assert.ok(
    !existsSync(join(caller, "pnpm-lock.yaml")),
    "global install must not write the caller's lockfile",
  );
  assert.ok(
    !existsSync(join(caller, "node_modules")),
    "global install must not install into the caller",
  );
}

test("real pnpm installs, lists, updates and removes tracked global tools from an unrelated cwd", () => {
  const f = fixture();
  try {
    const beforeCaller = readFileSync(join(f.caller, "package.json"), "utf8");
    const one = f.tarball("1.0.0");
    f.ok(["i", "-g", one, "--offline", "--ignore-scripts"]);
    assertGlobalInstall(f.tools, f.caller);
    assert.equal(readFileSync(join(f.caller, "package.json"), "utf8"), beforeCaller);
    assert.ok(!existsSync(join(f.home, ".local/share/pnpm/global")));
    assert.deepEqual(JSON.parse(readFileSync(join(f.tools, "bridge/package.json"), "utf8")), {
      name: "bridge",
      version: "1.0.0",
    });
    const bin = f.ok(["bin", "--global"]);
    assert.equal(bin, join(f.tools, "node_modules/.bin"));
    const cli = () =>
      spawnSync("fixture-cli", [], {
        cwd: f.caller,
        env: { ...f.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
        encoding: "utf8",
      });
    assert.equal(cli().status, 0);
    assert.equal(cli().stdout.trim(), "1.0.0");
    assert.match(f.ok(["ls", "-g", "--json"]), /fixture-cli/);
    const oldLock = readFileSync(join(f.tools, "pnpm-lock.yaml"), "utf8");
    const two = f.tarball("2.0.0");
    f.ok(["up", "-g", `fixture-cli@file:${two}`, "--offline", "--ignore-scripts"]);
    assert.notEqual(readFileSync(join(f.tools, "pnpm-lock.yaml"), "utf8"), oldLock);
    assert.equal(cli().stdout.trim(), "2.0.0");
    f.ok(["install", "--global", "--offline", "--ignore-scripts"]);
    f.ok(["remove", "-g", "fixture-cli"]);
    assert.ok(
      !JSON.parse(readFileSync(join(f.tools, "package.json"), "utf8")).dependencies["fixture-cli"],
    );
    assert.doesNotMatch(readFileSync(join(f.tools, "pnpm-lock.yaml"), "utf8"), /fixture-cli/);
    assert.ok(!existsSync(join(bin, "fixture-cli")));
  } finally {
    f.dispose();
  }
});

test("ordinary installs target the caller, and real pnpm failures preserve their exit status", () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.tools, "package.json"), "utf8");
    f.ok(["add", f.tarball("1.0.0"), "--offline", "--ignore-scripts"]);
    assert.equal(readFileSync(join(f.tools, "package.json"), "utf8"), before);
    assert.ok(!existsSync(join(f.tools, "pnpm-lock.yaml")));
    assert.ok(
      JSON.parse(readFileSync(join(f.caller, "package.json"), "utf8")).dependencies["fixture-cli"],
    );
    assert.ok(existsSync(join(f.caller, "node_modules/.bin/fixture-cli")));
    assert.equal(f.ok(["exec", "/bin/echo", "-g"]), "-g");
    assert.equal(f.run(["run", "fail"]).status, 23);
    const failed = f.run(["add", "-g", "missing-tracked-pnpm-fixture-8c71", "--offline"]);
    assert.notEqual(failed.status, 0);
    assert.equal(readFileSync(join(f.tools, "package.json"), "utf8"), before);
  } finally {
    f.dispose();
  }
});

test("argument boundaries, global spellings and passthrough preserve exact arguments", () => {
  const f = fixture();
  try {
    const capture = join(f.directory, "capture");
    writeFileSync(
      capture,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(capture, 0o755);
    const prefix = ["--dir", f.tools, "--workspace-root"];
    const cases: [string[], string[]][] = [
      [
        ["i", "-g", "a package"],
        [...prefix, "i", "a package"],
      ],
      [
        ["--global", "add", "foo@1"],
        [...prefix, "add", "foo@1"],
      ],
      [
        ["add", "--global=true", "foo"],
        [...prefix, "add", "foo"],
      ],
      [
        ["add", "-gD", "foo"],
        [...prefix, "add", "-D", "foo"],
      ],
      [
        ["add", "-Dg", "foo"],
        [...prefix, "add", "-D", "foo"],
      ],
      [
        ["add", "foo"],
        ["add", "foo"],
      ],
      [
        ["--store-dir", "exec", "add", "-g", "foo"],
        [...prefix, "--store-dir", "exec", "add", "foo"],
      ],
      [
        ["lint", "-g"],
        ["lint", "-g"],
      ],
      [
        ["exec", "/bin/echo", "-g"],
        ["exec", "/bin/echo", "-g"],
      ],
      [
        ["run", "test", "--global"],
        ["run", "test", "--global"],
      ],
      [
        ["--dir", "elsewhere", "exec", "/bin/echo", "-g"],
        ["--dir", "elsewhere", "exec", "/bin/echo", "-g"],
      ],
      [
        ["exec", "tool", "--", "-g", "space value"],
        ["exec", "tool", "--", "-g", "space value"],
      ],
      [
        ["add", "--global=false", "foo"],
        ["add", "--global=false", "foo"],
      ],
      [
        ["add", "-g", "--", "-g"],
        [...prefix, "add", "--", "-g"],
      ],
    ];
    for (const [input, expected] of cases) {
      const result = f.run(input, capture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), expected);
    }
    for (const selector of [
      "--dir=elsewhere",
      "-Celsewhere",
      "--filter=bridge",
      "-Fbridge",
      "-gr",
      "--lockfile-dir=elsewhere",
      "--global=false",
    ]) {
      const result = f.run(["add", "-g", selector, "foo"], capture);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /other project selectors/);
      assert.equal(result.stdout, "");
    }
  } finally {
    f.dispose();
  }
});

test("the global-install verifier rejects a wrapper that bypasses redirection", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.tools, "pnpm.mts"),
      `import { spawnSync } from "node:child_process";
const [pnpm, ...args] = process.argv.slice(2);
const result = spawnSync(pnpm, args.filter((arg) => arg !== "-g"), { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    );
    f.ok(["add", "-g", f.tarball("1.0.0"), "--offline", "--ignore-scripts"]);
    assert.throws(() => assertGlobalInstall(f.tools, f.caller), /tracked manifest/);
    assert.ok(
      existsSync(join(f.caller, "node_modules/.bin/fixture-cli")),
      "negative control must actually install in the wrong project",
    );
  } finally {
    f.dispose();
  }
});

test(
  "the nix-built launcher works from a shell and a script without shadowing",
  { skip: !builtLauncher },
  () => {
    const f = fixture();
    try {
      const env = { ...f.env, PATH: `${dirname(builtLauncher!)}${delimiter}${process.env.PATH}` };
      const upstream = spawnSync(pnpm, ["--version"], { env, encoding: "utf8" });
      assert.equal(upstream.status, 0, upstream.stderr);
      for (const shell of ["/bin/bash", "/bin/zsh"]) {
        const result = spawnSync(
          shell,
          ["-f", "-c", "command -v pnpm; pnpm --version; pnpm bin -g"],
          { cwd: f.caller, env, encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.deepEqual(result.stdout.trim().split("\n"), [
          builtLauncher,
          upstream.stdout.trim(),
          join(dirname(source), "node_modules/.bin"),
        ]);
      }
      const script = join(f.directory, "probe.sh");
      writeFileSync(script, "#!/bin/sh\nexec pnpm bin -g\n");
      chmodSync(script, 0o755);
      const result = spawnSync(script, [], { cwd: f.caller, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.trim(), join(dirname(source), "node_modules/.bin"));
    } finally {
      f.dispose();
    }
  },
);
