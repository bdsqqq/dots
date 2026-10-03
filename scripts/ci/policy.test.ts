import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createPlan, homeTargets, hostTargets, platformForHost } from "./policy.ts";
import type { Change, Plan } from "./policy.ts";
import { main, parseNameStatus, planCheckout } from "./plan.ts";

const base = "a".repeat(40),
  head = "b".repeat(40);
function fixture(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ci-policy-"));
  const files: Record<string, string> = {
    "AGENTS.md": "# verification",
    "README.md": "# repository",
    "modules/pi/AGENTS.md": "# pi tests",
    "modules/agents/AGENTS.md": "# skills",
    "scripts/ci/policy.ts": "policy v1",
    "scripts/ci/plan.ts": "planner v1",
    "flake.nix": "{ outputs = inputs: {}; }",
    "hosts/mbp-m2/default.nix":
      "{ imports = [ ../../modules/pi ../../modules/agents ../../modules/zmx ../../modules/node-pnpm ]; }",
    "hosts/lgo-z2e/default.nix":
      "{ imports = [ ../../modules/pi ../../modules/agents ../../modules/zmx ../../modules/node-pnpm ]; }",
    "modules/pi/default.nix": '{ home.activation.install = "install"; }',
    "modules/agents/default.nix":
      '{ home.file.skills.source = ./skills; home.activation.caseRepair = "repair"; }',
    "modules/agents/skills/example/SKILL.md": "# example",
    "modules/zmx/default.nix": "{ src = ../pi/packages/extensions/zmx; }",
    "modules/pi/packages/extensions/zmx/package.json": '{"bin":{"zmx-rows":"./zmx-rows.ts"}}',
    "modules/pi/packages/extensions/zmx/zmx-rows.ts": "export const parse = () => [];",
    "modules/node-pnpm/default.nix":
      '{ home.activation.installPnpmTools = "install"; home.file.config.source = ./config.yaml; }',
    "modules/node-pnpm/config.yaml": "minimumReleaseAge: 2880",
    "modules/node-pnpm/package.json":
      '{"dependencies":{"@bdsqqq/pi-cli":"workspace:*","@openai/codex":"1","t3":"1","other":"1"}}',
    "modules/node-pnpm/pi-cli/bin/pi": '#!/bin/sh\nexec "$PI_BIN" "$@"',
    "modules/node-pnpm/pi-cli/package.json": '{"bin":{"pi":"bin/pi"}}',
    ...overrides,
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  Object.entries(files).forEach(([path, text]) => write(path, text));
  return {
    root,
    files,
    write,
    plan: (changes: Change[], old: Record<string, string> = files) =>
      createPlan({ root, base, head, changes, readBase: (path) => old[path] ?? null }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
const change = (path: string): Change => ({ status: "M", path });
const ids = (plan: Plan) => new Set(plan.checks.map((check) => check.id));
const commands = (plan: Plan) => plan.checks.flatMap((check) => check.commands);

test("ordinary pi TypeScript selects local behavior, not host builds", () => {
  const f = fixture();
  try {
    const plan = f.plan([change("modules/pi/packages/extensions/read/index.ts")]);
    assert.equal(plan.blockers.length, 0);
    assert(ids(plan).has("pi:local"));
    assert(!plan.checks.some((c) => c.phase === "host" || c.phase === "artifact"));
    assert(!commands(plan).some((c) => c.args.includes("--passWithNoTests")));
  } finally {
    f.close();
  }
});
test("core, lock and patch inputs exercise production parity and both offline codemode paths", () => {
  const f = fixture({
    "modules/pi/packages/extensions/read/package.json":
      '{"peerDependencies":{"@earendil-works/pi-coding-agent":"1.0.0"}}',
  });
  try {
    for (const path of [
      "modules/pi/packages/core/tool-policy/index.ts",
      "modules/pi/pnpm-lock.yaml",
      "modules/pi/patches/pi-ai-1.0.0.patch",
      "modules/pi/package.json",
      "modules/pi/dist/extensions/read/index.js",
      "modules/pi/packages/extensions/read/package.json",
    ]) {
      const plan = f.plan([change(path)]);
      assert(ids(plan).has("pi:production"), path);
      assert(commands(plan).some((c) => c.env?.PI_TEST_BUILT_TOOLS === "1"));
      assert(commands(plan).some((c) => c.args.includes("--built")));
      assert(commands(plan).some((c) => c.args.join(" ") === "scripts/ci/probes.ts manifest"));
      assert(!commands(plan).some((c) => c.args.includes("--live")));
    }
  } finally {
    f.close();
  }
});
test("runtime configs and plaintext prompts have reload/runtime and source codemode checks", () => {
  const f = fixture();
  try {
    for (const path of [
      "modules/pi/settings.json",
      "modules/pi/tool-policy.json",
      "modules/pi/prompts/test.md",
      "modules/agents/agents/agent.amp.finder.md",
      "config/global-agents.md",
    ]) {
      const plan = f.plan([change(path)]);
      assert(ids(plan).has("pi:runtime"), path);
      assert(commands(plan).some((c) => c.args.join(" ") === "scripts/check-codemode.mjs"));
      assert(!plan.checks.some((c) => c.phase === "host"), path);
    }
  } finally {
    f.close();
  }
});
test("union and deterministic dedup preserve all reasons across mixed edits", () => {
  const f = fixture();
  try {
    const changes = [
      change("modules/pi/settings.json"),
      change("modules/pi/packages/core/tools/index.ts"),
      change("README.md"),
    ];
    const first = f.plan(changes);
    assert.deepEqual(first, f.plan([...changes].reverse()));
    assert(
      ids(first).has("pi:local") &&
        ids(first).has("pi:production") &&
        ids(first).has("pi:runtime") &&
        ids(first).has("docs:README.md"),
    );
    assert.equal(
      new Set(first.checks.map((c) => `${c.platform}:${c.id}`)).size,
      first.checks.length,
    );
    assert.equal(first.checks.find((c) => c.id === "pi:local")!.reasons.length, 2);
  } finally {
    f.close();
  }
});
test("literal Nix consumer graph distinguishes host roots and supports transitive paths", () => {
  const f = fixture({
    "hosts/mbp-m2/default.nix": "{ imports = [ ../../modules/only-darwin ]; }",
    "modules/only-darwin/default.nix": "{ imports = [ ./sub.nix ]; }",
    "modules/only-darwin/sub.nix": "{ programs.zsh.enable = true; }",
  });
  try {
    const plan = f.plan([change("modules/only-darwin/sub.nix")]);
    assert.equal(plan.blockers.length, 0);
    assert(ids(plan).has("evaluate:mbp-m2"));
    assert(!ids(plan).has("evaluate:lgo-z2e"));
    assert(plan.checks.some((c) => c.id.startsWith("parse:")));
    assert(!plan.checks.some((c) => c.phase === "host"));
    assert(commands(plan).some((c) => c.args.includes(`.#${hostTargets["mbp-m2"]}.drvPath`)));
  } finally {
    f.close();
  }
});
test("deleted and renamed Nix paths retain base consumer coverage", () => {
  const f = fixture({
    "hosts/mbp-m2/default.nix": "{ imports = [ ../../modules/old.nix ]; }",
    "modules/old.nix": "{ programs.zsh.enable = true; }",
  });
  try {
    const old = { ...f.files };
    rmSync(join(f.root, "modules/old.nix"));
    f.write("hosts/mbp-m2/default.nix", "{ imports = [ ../../modules/new.nix ]; }");
    f.write("modules/new.nix", "{ programs.zsh.enable = false; }");
    const renamed = f.plan(
      [{ status: "R", path: "modules/new.nix", previousPath: "modules/old.nix" }],
      old,
    );
    assert(ids(renamed).has("evaluate:mbp-m2"));
    assert(!ids(renamed).has("parse:modules/old.nix"));
    assert(ids(renamed).has("parse:modules/new.nix"));
    const deleted = f.plan([{ status: "D", path: "modules/old.nix" }], old);
    assert(ids(deleted).has("evaluate:mbp-m2"));
    assert(!deleted.blockers.some((b) => b.includes("unconsumed")));
  } finally {
    f.close();
  }
});
test("empty, unconsumed, dynamic and generic runtime inputs fail closed", () => {
  const f = fixture({
    "modules/unused.nix": "{}",
    "modules/pi/dynamic.nix": "{ imports = [ ./platform/${system}.nix ]; }",
    "modules/other/default.nix": "{ src = ./worker.py; }",
    "modules/other/worker.py": "print('runtime')",
    "hosts/mbp-m2/default.nix": "{ imports = [ ../../modules/other ]; }",
  });
  try {
    assert(f.plan([]).blockers.length);
    assert(f.plan([change("modules/unused.nix")]).blockers.some((b) => b.includes("unconsumed")));
    assert(f.plan([change("modules/pi/dynamic.nix")]).blockers.some((b) => b.includes("dynamic")));
    const runtime = f.plan([change("modules/other/worker.py")]);
    assert(runtime.blockers.some((b) => b.includes("local behavior")));
    assert(ids(runtime).has("host:mbp-m2"));
    assert.equal(f.plan([change("unknown/file.js")]).autoMergeEligible, false);
    assert(f.plan([change("../escape")]).blockers.length);
  } finally {
    f.close();
  }
});
test("flake inputs require full native affected hosts; significant Nix integration escalates", () => {
  const f = fixture({
    "modules/pi/packages/extensions/read/credential.nix": "{ sops.secrets.token = {}; }",
    "hosts/mbp-m2/default.nix": "{ imports = [ ../../modules/boot.nix ]; }",
    "modules/boot.nix": "{ boot.kernelParams = []; }",
  });
  try {
    for (const path of ["flake.lock", "flake.nix"]) {
      const plan = f.plan([change(path)]);
      assert.equal(plan.checks.filter((c) => c.phase === "host").length, 7);
      assert.equal(plan.checks.filter((c) => c.phase === "evaluation").length, 7);
      plan.checks
        .filter((c) => c.id.startsWith("host:"))
        .forEach((c) => assert.equal(c.platform, platformForHost[c.id.slice(5)]));
    }
    assert(ids(f.plan([change("modules/boot.nix")])).has("host:mbp-m2"));
    const credential = f.plan([change("modules/pi/packages/extensions/read/credential.nix")]);
    assert(ids(credential).has("nix-check:credential-ownership"));
    assert(ids(credential).has("nix-check:credential-host-closures"));
  } finally {
    f.close();
  }
});
test("home activation wiring uses actual affected homes and temporary Darwin hook test", () => {
  const f = fixture();
  try {
    for (const path of ["modules/pi/default.nix", "modules/agents/default.nix"]) {
      const plan = f.plan([change(path)]);
      assert(ids(plan).has("home:mbp-m2") && ids(plan).has("home:lgo-z2e"));
      assert(!plan.checks.some((c) => c.phase === "host"));
      assert(commands(plan).some((c) => c.args.includes(`.#${homeTargets["mbp-m2"]}`)));
    }
    const plan = f.plan([change("modules/agents/default.nix")]);
    const hook = plan.checks.find((c) => c.id === "agents:darwin-case-hook")!;
    assert.equal(hook.platform, "aarch64-darwin");
    assert(hook.commands[0].args.includes("modules/agents/test-skill-case-repair.test.ts"));
  } finally {
    f.close();
  }
});
test("portable skill bytes require frozen install, checker/scorer, typecheck, home artifact and docs", () => {
  const f = fixture();
  try {
    const plan = f.plan([change("modules/agents/skills/example/SKILL.md")]);
    assert.equal(plan.blockers.length, 0);
    for (const id of [
      "agents:local",
      "home:mbp-m2",
      "evaluate:mbp-m2",
      "docs:modules/agents/skills/example/SKILL.md",
    ])
      assert(ids(plan).has(id));
    assert(commands(plan).some((c) => c.args.includes("--frozen-lockfile")));
  } finally {
    f.close();
  }
});
test("zmx requires the selected wrapper, not only pkgs.zmx", () => {
  const f = fixture();
  try {
    for (const path of [
      "modules/pi/packages/extensions/zmx/zmx-rows.ts",
      "modules/pi/packages/extensions/zmx/package.json",
    ]) {
      const plan = f.plan([change(path)]);
      assert.equal(plan.blockers.length, 0);
      assert(ids(plan).has("pi:local") && ids(plan).has("evaluate:mbp-m2"));
      const wrapper = plan.checks.find((c) => c.id === "zmx-rows:mbp-m2")!;
      assert.equal(wrapper.phase, "artifact");
      assert(wrapper.commands[0].args.includes("--expr"));
      assert(wrapper.commands[0].args.at(-1)!.includes('== "zmx-rows"'));
      assert(wrapper.commands[0].args.at(-1)!.includes("home.packages"));
    }
  } finally {
    f.close();
  }
});
test("CI bootstrap is testable but never auto-merge eligible; digest binds nested guidance and code", () => {
  const f = fixture();
  try {
    const changes = [change("scripts/ci/policy.ts")];
    const plan = f.plan(changes);
    assert.equal(plan.blockers.length, 0);
    assert.equal(plan.autoMergeEligible, false);
    assert(ids(plan).has("ci:self-tests"));
    f.write("modules/pi/AGENTS.md", "# different pi policy");
    assert.notEqual(f.plan(changes).policyDigest, plan.policyDigest);
    const next = f.plan(changes).policyDigest;
    f.write("scripts/ci/plan.ts", "planner v2");
    assert.notEqual(f.plan(changes).policyDigest, next);
    assert.equal(f.plan([change(".github/workflows/check.yml")]).autoMergeEligible, false);
  } finally {
    f.close();
  }
});
test("trusted policy digest ignores proposed candidate policy and binds every trusted CI control", () => {
  const candidate = fixture();
  const trusted = fixture({ "scripts/ci/run.ts": "trusted runner" });
  const plan = () =>
    createPlan({
      root: candidate.root,
      policyRoot: trusted.root,
      base,
      head,
      changes: [change("scripts/ci/policy.ts")],
      readBase: (path) => candidate.files[path] ?? null,
    });
  try {
    const digest = plan().policyDigest;
    candidate.write("AGENTS.md", "proposed guidance");
    candidate.write("scripts/ci/policy.ts", "proposed policy");
    candidate.write("scripts/ci/run.ts", "proposed runner");
    assert.equal(plan().policyDigest, digest);
    for (const path of [
      "AGENTS.md",
      "modules/pi/AGENTS.md",
      "scripts/ci/policy.ts",
      "scripts/ci/plan.ts",
      "scripts/ci/run.ts",
      "scripts/ci/gate.ts",
      "scripts/ci/probes.ts",
    ]) {
      const before = plan().policyDigest;
      trusted.write(path, `changed trusted ${path}`);
      assert.notEqual(plan().policyDigest, before, path);
    }
  } finally {
    candidate.close();
    trusted.close();
  }
});
test("self-CI/workflow edits select the installed strict TypeScript checker and real actionlint", () => {
  const f = fixture({
    "scripts/ci/run.ts": "runner",
    "scripts/ci/gate.ts": "gate",
    "scripts/ci/probes.ts": "probes",
    "scripts/ci/run.test.ts": "runner test",
  });
  try {
    for (const path of ["scripts/ci/run.ts", ".github/workflows/verify.yml"]) {
      const plan = f.plan([change(path)]);
      assert.equal(plan.autoMergeEligible, false);
      assert.equal(plan.blockers.length, 0);
      const checker = plan.checks.find((c) => c.id === "ci:typecheck")!.commands[0];
      assert.equal(checker.program, "node");
      assert.equal(checker.args[0], "modules/pi/node_modules/typescript/bin/tsc");
      assert(checker.args.includes("--strict") && checker.args.includes("--noEmit"));
      assert(checker.args.includes("--allowImportingTsExtensions"));
      for (const name of ["policy.ts", "plan.ts", "run.ts", "gate.ts", "probes.ts", "run.test.ts"])
        assert(checker.args.includes(`scripts/ci/${name}`));
      const workflow = plan.checks.find((c) => c.id === "ci:workflow")!.commands[0];
      assert.deepEqual(workflow.args, [
        "run",
        "--no-write-lock-file",
        "--inputs-from",
        ".",
        "nixpkgs#actionlint",
        "--",
        ".github/workflows/verify.yml",
      ]);
      assert.equal(workflow.timeoutSeconds, 300);
    }
  } finally {
    f.close();
  }
});
test("global tools updates select frozen workspaces and bounded version authority without host builds", () => {
  const f = fixture({
    "modules/node-pnpm/pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "modules/node-pnpm/pnpm-workspace.yaml": "packages: [pi-cli]",
  });
  try {
    for (const path of [
      "modules/node-pnpm/package.json",
      "modules/node-pnpm/pnpm-lock.yaml",
      "modules/node-pnpm/pnpm-workspace.yaml",
      "modules/node-pnpm/pi-cli/package.json",
      "modules/node-pnpm/pi-cli/bin/pi",
    ]) {
      const plan = f.plan([change(path)]);
      assert.equal(plan.blockers.length, 0, path);
      assert(ids(plan).has("node-pnpm:install") && ids(plan).has("node-pnpm:tools"));
      assert(ids(plan).has("pi:local") && ids(plan).has("pi:install"));
      const install = plan.checks.find((c) => c.id === "node-pnpm:install")!.commands[0];
      assert.equal(install.cwd, "modules/node-pnpm");
      assert.deepEqual(install.args, ["install", "--frozen-lockfile"]);
      const probe = plan.checks.find((c) => c.id === "node-pnpm:tools")!;
      assert.equal(probe.phase, "runtime");
      assert.deepEqual(probe.commands[0].args, ["scripts/ci/probes.ts", "tools"]);
      assert(probe.reasons[0].includes("only pi, codex, t3"));
      assert(!plan.checks.some((c) => c.phase === "host" || c.phase === "artifact"));
      assert(
        !commands(plan).some((c) => c.args.some((arg) => /preview|activate|--live/.test(arg))),
      );
    }
    assert(f.plan([change("modules/node-pnpm/other-tool/runtime.js")]).blockers.length);
  } finally {
    f.close();
  }
});
test("global tool wiring and copied pnpm policy build affected homes, never activate them", () => {
  const f = fixture();
  try {
    for (const path of ["modules/node-pnpm/default.nix", "modules/node-pnpm/config.yaml"]) {
      const plan = f.plan([change(path)]);
      assert.equal(plan.blockers.length, 0, path);
      assert(ids(plan).has("evaluate:mbp-m2") && ids(plan).has("home:mbp-m2"));
      assert(ids(plan).has("evaluate:lgo-z2e") && ids(plan).has("home:lgo-z2e"));
      assert(ids(plan).has("node-pnpm:tools"));
      assert(!plan.checks.some((c) => c.phase === "host"));
    }
  } finally {
    f.close();
  }
});
test("global package bytes embedded in service restart triggers also build that host closure", () => {
  const f = fixture({
    "hosts/mbp-m2/default.nix": "{ imports = [ ../../modules/consumer ]; }",
    "modules/consumer/default.nix":
      "{ systemd.services.tools.restartTriggers = [ ../node-pnpm/package.json ]; }",
  });
  try {
    const plan = f.plan([change("modules/node-pnpm/package.json")]);
    assert.equal(plan.blockers.length, 0);
    assert(ids(plan).has("evaluate:mbp-m2") && ids(plan).has("host:mbp-m2"));
    assert(!ids(plan).has("host:lgo-z2e"));
    assert(ids(plan).has("node-pnpm:tools"));
  } finally {
    f.close();
  }
});
test("standalone package roots build their existing outputs, not invented host dependencies", () => {
  const f = fixture({
    "flake.nix": `{
      perSystem = { pkgs, ... }: {
        packages.photo-semantic-benchmark = import ./modules/photo-intelligence/benchmark { inherit pkgs; };
        packages.household-intake-smb-audit = import ./modules/household-intake/package.nix { inherit pkgs; };
        packages.kindle-tailscale-autostart = import ./modules/kindle-tailscale-autostart { inherit pkgs; };
      };
      flake = {};
    }`,
    "modules/photo-intelligence/benchmark/default.nix":
      '{ pkgs }: pkgs.writeShellApplication { text = "benchmark"; }',
    "modules/household-intake/package.nix":
      '{ pkgs }: pkgs.writeShellApplication { text = "audit"; }',
    "modules/kindle-tailscale-autostart/default.nix":
      '{ pkgs }: pkgs.runCommand "kindle" {} "copy"',
  });
  try {
    for (const [path, name, count] of [
      ["modules/photo-intelligence/benchmark/default.nix", "photo-semantic-benchmark", 2],
      ["modules/household-intake/package.nix", "household-intake-smb-audit", 2],
      ["modules/kindle-tailscale-autostart/default.nix", "kindle-tailscale-autostart", 1],
    ] as const) {
      const plan = f.plan([change(path)]);
      assert.equal(plan.blockers.length, 0);
      assert.equal(plan.checks.filter((c) => c.id === `package:${name}`).length, count);
      assert.equal(plan.checks.filter((c) => c.id === `evaluate-package:${name}`).length, count);
      assert(!plan.checks.some((c) => c.id.startsWith("host:") || c.id.startsWith("evaluate:")));
      assert(commands(plan).some((c) => c.args.includes(`.#packages.x86_64-linux.${name}`)));
      if (name === "kindle-tailscale-autostart")
        assert(
          !plan.checks.some((c) => c.id === `package:${name}` && c.platform === "aarch64-darwin"),
        );
    }
  } finally {
    f.close();
  }
});
test("flake expression/input changes force all registered standalone outputs independently of host builds", () => {
  const f = fixture({
    "flake.nix": `{
      perSystem = { pkgs, ... }: {
        packages.photo-semantic-benchmark = import ./modules/photo-intelligence/benchmark { pkgs = throw "broken"; };
        packages.household-intake-smb-audit = import ./modules/household-intake/package.nix { inherit pkgs; };
        packages.kindle-tailscale-autostart = import ./modules/kindle-tailscale-autostart { inherit pkgs; };
        packages.tailnet-artifact-generator = pkgs.writeShellApplication { text = "\${./scripts/generate-tailnet-artifacts.py}"; };
        checks.darwin-transcription = pkgs.runCommand "test" {} "test";
        checks.credential-ownership = pkgs.runCommand "test" {} "test";
      };
      flake = {};
    }`,
    "modules/photo-intelligence/benchmark/default.nix": "{ pkgs }: pkgs.writeShellApplication {}",
    "modules/household-intake/package.nix": "{ pkgs }: pkgs.writeShellApplication {}",
    "modules/kindle-tailscale-autostart/default.nix": '{ pkgs }: pkgs.runCommand "copy" {} "copy"',
    "scripts/generate-tailnet-artifacts.py": "# generator",
  });
  try {
    for (const path of ["flake.nix", "flake.lock"]) {
      const plan = f.plan([change(path)]);
      assert.equal(plan.blockers.length, 0, path);
      for (const name of [
        "photo-semantic-benchmark",
        "household-intake-smb-audit",
        "kindle-tailscale-autostart",
        "tailnet-artifact-generator",
      ]) {
        assert(ids(plan).has(`evaluate-package:${name}`), `${path}: ${name}`);
        assert(ids(plan).has(`package:${name}`), `${path}: ${name}`);
      }
      assert(
        plan.checks
          .filter((c) => c.id === "package:kindle-tailscale-autostart")
          .every((c) => c.platform === "x86_64-linux"),
      );
      assert(ids(plan).has("nix-check:credential-ownership"));
      assert(
        plan.checks
          .filter((c) => c.id === "nix-check:darwin-transcription")
          .every((c) => c.platform === "aarch64-darwin"),
      );
      assert.equal(plan.checks.filter((c) => c.phase === "host").length, 7);
    }
  } finally {
    f.close();
  }
});
test("removed exports, unknown outputs and changed unmapped flake consumption block", () => {
  const source = `{
    perSystem = { pkgs, ... }: {
      packages.photo-semantic-benchmark = import ./modules/photo-intelligence/benchmark { inherit pkgs; };
      checks.darwin-transcription = pkgs.runCommand "test" {} "test";
    };
    flake = {};
  }`;
  const f = fixture({
    "flake.nix": source,
    "modules/photo-intelligence/benchmark/default.nix": "{ pkgs }: pkgs.writeShellApplication {}",
    "modules/unknown-check/default.nix": '{ pkgs }: pkgs.runCommand "unknown" {} "copy"',
  });
  try {
    f.write(
      "flake.nix",
      source
        .replace(/^\s*packages\.photo-semantic-benchmark.*$/m, "")
        .replace(/^\s*checks\.darwin-transcription.*$/m, ""),
    );
    const removed = f.plan([change("flake.nix")]);
    assert(removed.blockers.some((b) => b.includes("missing current standalone package export")));
    assert(removed.blockers.some((b) => b.includes("missing current standalone check export")));
    assert(!ids(removed).has("package:photo-semantic-benchmark"));
    f.write(
      "flake.nix",
      source.replace(
        "perSystem = { pkgs, ... }: {",
        'perSystem = { pkgs, ... }: { packages.unknown = pkgs.runCommand "unknown" {} "copy";',
      ),
    );
    assert(
      f
        .plan([change("flake.lock")])
        .blockers.some((b) => b.includes("unmapped standalone package export")),
    );
    f.write(
      "flake.nix",
      source.replace(
        'pkgs.runCommand "test" {} "test"',
        "import ./modules/unknown-check { inherit pkgs; }",
      ),
    );
    assert(
      f
        .plan([change("flake.nix")])
        .blockers.some((b) => b.includes("unmapped standalone flake input")),
    );
  } finally {
    f.close();
  }
});
test("unsupported standalone outputs and runtime bytes fail closed without fake host coverage", () => {
  const f = fixture({
    "flake.nix": `{
      perSystem = { pkgs, ... }: {
        packages.unknown = import ./modules/unknown-package { inherit pkgs; };
        packages.photo-semantic-benchmark = import ./modules/photo-intelligence/benchmark { inherit pkgs; };
      };
      flake = {};
    }`,
    "modules/unknown-package/default.nix": '{ pkgs }: pkgs.runCommand "unknown" {} "copy"',
    "modules/photo-intelligence/benchmark/default.nix":
      "{ pkgs }: pkgs.writeShellApplication { source = ./benchmark.py; }",
    "modules/photo-intelligence/benchmark/benchmark.py": "print('runtime')",
  });
  try {
    const unknown = f.plan([change("modules/unknown-package/default.nix")]);
    assert(unknown.blockers.some((b) => b.includes("unsupported standalone")));
    assert(!unknown.checks.some((c) => c.phase === "host"));
    const runtime = f.plan([change("modules/photo-intelligence/benchmark/benchmark.py")]);
    assert(runtime.blockers.some((b) => b.includes("bounded behavior")));
    assert(ids(runtime).has("package:photo-semantic-benchmark"));
    assert(!runtime.checks.some((c) => c.phase === "host"));
    f.write("modules/unknown-factory/default.nix", "{ data = ./helper.md; }");
    f.write("modules/unknown-factory/helper.md", "# factory data");
    f.write(
      "flake.nix",
      `let helper = import ./modules/unknown-factory; in {
      perSystem = {};
      flake = {};
    }`,
    );
    const unknownHelper = f.plan([change("modules/unknown-factory/helper.md")]);
    assert(unknownHelper.blockers.some((b) => b.includes("unsupported flake factory")));
    assert(!unknownHelper.checks.some((c) => c.phase === "host"));
  } finally {
    f.close();
  }
});
test("Nix build constructors cannot stop at parsing and evaluation", () => {
  const f = fixture({
    "hosts/mbp-m2/default.nix": "{ imports = [ ../../modules/artifact.nix ]; }",
  });
  try {
    for (const constructor of [
      "runCommand",
      "runCommandLocal",
      "writeScriptBin",
      "writeShellApplication",
      "writeTextFile",
      "derivation",
      "symlinkJoin",
      "buildEnv",
      "buildGoModule",
      "buildNpmPackage",
      "buildRustPackage",
      "mkDerivation",
      "callPackage",
      "overrideAttrs",
    ]) {
      f.write(
        "modules/artifact.nix",
        `{ pkgs }: { home.packages = [ (pkgs.${constructor} {}) ]; }`,
      );
      const plan = f.plan([change("modules/artifact.nix")]);
      assert(ids(plan).has("host:mbp-m2"), constructor);
    }
  } finally {
    f.close();
  }
});
test("theme bytes load through the real Pi resource probe; other unknown resources block", () => {
  const f = fixture();
  try {
    const theme = f.plan([
      change("modules/pi/packages/extensions/editor/themes/unboxed-dark.json"),
    ]);
    assert.equal(theme.blockers.length, 0);
    assert(ids(theme).has("pi:runtime"));
    assert(commands(theme).some((c) => c.args.join(" ") === "scripts/check-codemode.mjs"));
    for (const path of [
      "modules/pi/packages/extensions/editor/resources/unknown.json",
      "modules/pi/packages/extensions/editor/resources/unknown.yaml",
      "modules/pi/prompts/ignored-resource.json",
      "modules/pi/packages/core/unknown-resource.json",
    ])
      assert(
        f.plan([change(path)]).blockers.some((b) => b.includes("consumer check")),
        path,
      );
  } finally {
    f.close();
  }
});
test("critical release-age, nested guidance and runtime policy changes cannot auto-merge", () => {
  const f = fixture();
  try {
    for (const path of [
      "modules/node-pnpm/config.yaml",
      "AGENTS.md",
      "modules/pi/AGENTS.md",
      "modules/agents/AGENTS.md",
      "config/global-agents.md",
      "modules/pi/tool-policy.json",
      "modules/agents/bds-pi.json",
      "modules/node-pnpm/package.json",
      "modules/node-pnpm/pnpm-lock.yaml",
    ])
      assert.equal(f.plan([change(path)]).autoMergeEligible, false, path);
  } finally {
    f.close();
  }
});
test("workspace, npmrc and manifest release-age overrides always require manual review", () => {
  const f = fixture();
  try {
    for (const [path, content] of [
      ["modules/pi/pnpm-workspace.yaml", "minimumReleaseAge: 0\nminimumReleaseAgeExclude: ['*']"],
      ["modules/node-pnpm/pnpm-workspace.yaml", "minimumReleaseAge: 0"],
      ["modules/pi/.npmrc", "minimum-release-age=0"],
      ["modules/node-pnpm/.npmrc", "minimum-release-age-exclude[]=*"],
      ["modules/pi/package.json", '{"pnpm":{"minimumReleaseAge":0}}'],
      [
        "modules/pi/packages/extensions/read/package.json",
        '{"pnpm":{"minimumReleaseAgeExclude":["*"]}}',
      ],
      ["modules/node-pnpm/package.json", '{"pnpm":{"minimumReleaseAge":0}}'],
    ]) {
      f.write(path, content);
      assert.equal(f.plan([change(path)]).autoMergeEligible, false, path);
    }
  } finally {
    f.close();
  }
});
test("repository package, trash constructor and theme consumption match real candidate sources", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const readBase = (path: string) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
  const plan = (path: string) =>
    createPlan({ root, base, head, changes: [change(path)], readBase });
  const benchmark = plan("modules/photo-intelligence/benchmark/default.nix");
  assert.equal(benchmark.blockers.length, 0);
  assert(ids(benchmark).has("package:photo-semantic-benchmark"));
  assert(!benchmark.checks.some((c) => c.phase === "host"));
  const household = plan("modules/household-intake/package.nix");
  assert.equal(household.blockers.length, 0);
  assert(ids(household).has("package:household-intake-smb-audit"));
  const kindle = plan("modules/kindle-tailscale-autostart/default.nix");
  assert.equal(kindle.blockers.length, 0);
  assert.equal(
    kindle.checks.filter((c) => c.id === "package:kindle-tailscale-autostart").length,
    1,
  );
  const trash = plan("modules/trash/default.nix");
  assert.equal(trash.blockers.length, 0);
  assert(trash.checks.some((c) => c.phase === "host"));
  const theme = plan("modules/pi/packages/extensions/editor/themes/unboxed-dark.json");
  assert.equal(theme.blockers.length, 0);
  assert(ids(theme).has("pi:runtime"));
  const darwinOverlay = plan("overlays/libplist-darwin.nix");
  assert.equal(darwinOverlay.blockers.length, 0);
  assert(
    darwinOverlay.checks
      .filter((c) => c.id.startsWith("evaluate:"))
      .every((c) => c.platform === "aarch64-darwin"),
  );
  const linuxOverlay = plan("overlays/quickshell.nix");
  assert.equal(linuxOverlay.blockers.length, 0);
  assert.deepEqual(
    linuxOverlay.checks.filter((c) => c.id.startsWith("evaluate:")).map((c) => c.id),
    ["evaluate:lgo-z2e"],
  );
  for (const path of ["flake.nix", "flake.lock"]) {
    const inputs = plan(path);
    assert.equal(inputs.blockers.length, 0, path);
    for (const name of [
      "photo-semantic-benchmark",
      "household-intake-smb-audit",
      "kindle-tailscale-autostart",
      "tailnet-artifact-generator",
    ])
      assert(
        ids(inputs).has(`evaluate-package:${name}`) && ids(inputs).has(`package:${name}`),
        `${path}: ${name}`,
      );
    assert(
      inputs.checks
        .filter((c) => c.id === "package:kindle-tailscale-autostart")
        .every((c) => c.platform === "x86_64-linux"),
    );
    assert(
      ids(inputs).has("nix-check:tailnet-registry") &&
        ids(inputs).has("nix-check:credential-host-closures"),
    );
  }
});
test("tailnet inputs select existing artifact/registry derivations", () => {
  const f = fixture();
  try {
    const plan = f.plan([
      change("modules/tailnet/catalog.nix"),
      change("modules/tailnet-registry/tailnet-registry.ts"),
    ]);
    assert(ids(plan).has("nix-check:tailnet-artifacts"));
    assert(ids(plan).has("nix-check:tailnet-registry"));
  } finally {
    f.close();
  }
});
test("opaque import lists and unsupported agent runtime code do not receive inferred coverage", () => {
  const f = fixture({
    "modules/opaque.nix": "{ imports = modulesFor platform; }",
    "hosts/mbp-m2/default.nix": "{ imports = [ ../../modules/opaque.nix ]; }",
    "modules/agents/research/acquire.py": "print('fetch')",
  });
  try {
    assert(f.plan([change("modules/opaque.nix")]).blockers.some((b) => b.includes("dynamic")));
    assert(
      f
        .plan([change("modules/agents/research/acquire.py")])
        .blockers.some((b) => b.includes("bounded behavior")),
    );
  } finally {
    f.close();
  }
});
test("NUL diff parser preserves spaces/newlines, deletion and both rename/copy sides", () => {
  assert.deepEqual(
    parseNameStatus("M\0a file\nname.md\0D\0gone.nix\0R100\0old.nix\0new.nix\0C075\0a.md\0b.md\0"),
    [
      { status: "M", path: "a file\nname.md" },
      { status: "D", path: "gone.nix" },
      { status: "R", previousPath: "old.nix", path: "new.nix" },
      { status: "C", previousPath: "a.md", path: "b.md" },
    ],
  );
  for (const bad of ["M\0path", "R100\0old\0", "X\0path\0", "M\0../path\0", "M\0\0"])
    assert.throws(() => parseNameStatus(bad));
});
test("planner flags and SHA validation reject option injection before git", () => {
  assert.throws(() => main(["--root", "/tmp", "--base", "--help"]));
  assert.throws(() => main(["--root", "/tmp", "--root", "/tmp"]));
  assert.throws(() => planCheckout("/tmp", "HEAD", head), /SHA/);
});
test("checkout planner verifies exact HEAD, rejects tracked dirt, and writes a plan", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-plan-git-"));
  const trusted = fixture({ "scripts/ci/run.ts": "trusted runner" });
  const run = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    run("init", "--quiet");
    run("config", "user.email", "fixture@example.invalid");
    run("config", "user.name", "fixture");
    writeFileSync(join(root, "README.md"), "# before");
    run("add", "README.md");
    run("commit", "--quiet", "-m", "fixture base");
    const base = run("rev-parse", "HEAD").trim();
    writeFileSync(join(root, "README.md"), "# after");
    run("add", "README.md");
    run("commit", "--quiet", "-m", "fixture head");
    const head = run("rev-parse", "HEAD").trim();
    assert.throws(() => planCheckout(root, base, base), /HEAD/);
    const plan = planCheckout(root, base, head);
    assert.deepEqual(plan.changes, [{ status: "M", path: "README.md" }]);
    const output = join(root, "runtime", "plan.json");
    main(["--root", root, "--base", base, "--head", head, "--output", output]);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), plan);
    main([
      "--root",
      root,
      "--base",
      base,
      "--head",
      head,
      "--output",
      output,
      "--policy-root",
      trusted.root,
    ]);
    const trustedPlan = planCheckout(root, base, head, trusted.root);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), trustedPlan);
    assert.notEqual(trustedPlan.policyDigest, plan.policyDigest);
    assert.throws(
      () =>
        main(["--root", root, "--base", base, "--head", head, "--output", join(root, "README.md")]),
      /tracked file/,
    );
    writeFileSync(join(root, "README.md"), "# dirty");
    assert.throws(() => planCheckout(root, base, head), /clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    trusted.close();
  }
});
