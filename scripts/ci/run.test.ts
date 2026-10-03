import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { environment, execute, nativePlatform, runPlan, validatePlan } from "./run.ts";
import type { Plan } from "./policy.ts";

const platform = nativePlatform();
function plan(args = ["-e", "console.log('fixture')"]): Plan {
  return {
    schemaVersion: 1,
    base: "a".repeat(40),
    head: "b".repeat(40),
    policyDigest: "c".repeat(64),
    changes: [{ status: "M", path: "README.md" }],
    blockers: [],
    autoMergeEligible: true,
    checks: [
      {
        id: "fixture",
        platform,
        phase: "local",
        reasons: ["fixture"],
        commands: [{ program: "node", args, timeoutSeconds: 5 }],
      },
    ],
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ci-run-candidate-"));
  const output = mkdtempSync(join(tmpdir(), "ci-run-evidence-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root, timeout: 10_000 });
  return {
    root,
    output,
    close: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    },
  };
}

test("worker environment never inherits auth, SSH sockets or startup code", () => {
  process.env.GH_TOKEN = "not-a-real-token";
  process.env.NODE_OPTIONS = "--inspect";
  process.env.SSH_AUTH_SOCK = "/private/socket";
  try {
    const env = environment("/temporary/home", "/usr/bin:/bin");
    assert.equal(env.HOME, "/temporary/home");
    for (const key of ["GH_TOKEN", "NODE_OPTIONS", "SSH_AUTH_SOCK", "OPENAI_API_KEY"])
      assert.equal(env[key], undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.PI_OFFLINE, "1");
  } finally {
    delete process.env.GH_TOKEN;
    delete process.env.NODE_OPTIONS;
    delete process.env.SSH_AUTH_SOCK;
  }
});

test("plan rejects shell commands, escaping cwd, environment overrides and invalid deadlines", () => {
  for (const mutation of [
    (p: Plan) => {
      p.checks[0].commands[0].program = "sh" as never;
    },
    (p: Plan) => {
      p.checks[0].commands[0].cwd = "../escape";
    },
    (p: Plan) => {
      p.checks[0].commands[0].env = { HOME: "/Users/bdsqqq" };
    },
    (p: Plan) => {
      p.checks[0].commands[0].timeoutSeconds = 0;
    },
    (p: Plan) => {
      p.checks.push(p.checks[0]);
    },
  ]) {
    const value = plan();
    mutation(value);
    assert.throws(() => validatePlan(value));
  }
});

test("real command execution writes phase evidence and a persistent receipt", async () => {
  const f = fixture();
  try {
    const receipt = await runPlan(plan(), platform, { ...f, install: false });
    assert.deepEqual(receipt.errors, []);
    assert.equal(receipt.results[0].status, "passed");
    assert.equal(receipt.results[0].commands[0].exitCode, 0);
    assert.match(readFileSync(receipt.results[0].commands[0].log, "utf8"), /fixture/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.output, "receipt.json"), "utf8")), receipt);
  } finally {
    f.close();
  }
});

test("failure stops dependent checks and cannot become a partial green receipt", async () => {
  const f = fixture();
  try {
    const value = plan(["-e", "process.exit(7)"]);
    value.checks.push({ ...value.checks[0], id: "dependent" });
    const receipt = await runPlan(value, platform, { ...f, install: false });
    assert.equal(receipt.results[0].status, "failed");
    assert.equal(receipt.results[0].commands[0].exitCode, 7);
    assert.equal(receipt.results[1].status, "blocked");
    assert.deepEqual(receipt.results[1].commands, []);
    assert(receipt.errors.length);
  } finally {
    f.close();
  }
});

test("coverage blockers run no candidate commands", async () => {
  const f = fixture();
  try {
    const value = plan();
    value.blockers.push("unmapped consumer");
    const receipt = await runPlan(value, platform, { ...f, install: false });
    assert.equal(receipt.results[0].status, "blocked");
    assert.deepEqual(receipt.results[0].commands, []);
    assert.deepEqual(receipt.errors, ["unmapped consumer"]);
  } finally {
    f.close();
  }
});

test("worker refuses the other architecture and evidence inside candidate", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      runPlan(plan(), platform === "aarch64-darwin" ? "x86_64-linux" : "aarch64-darwin", f),
      /native/,
    );
    await assert.rejects(
      runPlan(plan(), platform, { root: f.root, output: join(f.root, "evidence") }),
      /outside/,
    );
  } finally {
    f.close();
  }
});

test("deadline kills an entire child group without waiting on inherited stdout", async () => {
  const f = fixture();
  try {
    const started = Date.now();
    const result = await execute(
      {
        program: "node",
        timeoutSeconds: 1,
        args: [
          "-e",
          "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)",
        ],
      },
      f.root,
      environment(f.output, process.env.PATH ?? ""),
      join(f.output, "timeout.log"),
    );
    assert.equal(result.status, "timed-out");
    assert.equal(result.signal, "SIGKILL");
    assert(Date.now() - started < 5000);
  } finally {
    f.close();
  }
});

test("symlink cwd cannot escape the checkout", async () => {
  const f = fixture();
  try {
    symlinkSync(f.output, join(f.root, "escape"));
    await assert.rejects(
      execute(
        { program: "node", args: ["--version"], cwd: "escape", timeoutSeconds: 2 },
        f.root,
        environment(f.output, ""),
        join(f.output, "escape.log"),
      ),
      /escapes/,
    );
  } finally {
    f.close();
  }
});

test("candidate probe replacements cannot certify their own broken resources", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "scripts/ci"), { recursive: true });
    writeFileSync(join(f.root, "scripts/ci/probes.ts"), "console.log('forged pass')");
    writeFileSync(join(f.root, "README.md"), "[broken](missing.md)");
    const result = await execute(
      {
        program: "node",
        args: ["scripts/ci/probes.ts", "docs", "README.md"],
        timeoutSeconds: 5,
      },
      f.root,
      environment(f.output, ""),
      join(f.output, "trusted.log"),
    );
    assert.equal(result.status, "failed");
    assert.notEqual(result.executedArgs?.[0], join(f.root, "scripts/ci/probes.ts"));
    assert.deepEqual(result.executedArgs?.slice(1, 3), ["--root", f.root]);
    assert.match(readFileSync(result.log, "utf8"), /missing\.md/);
    assert.doesNotMatch(readFileSync(result.log, "utf8"), /forged pass/);
  } finally {
    f.close();
  }
});

test("a changed tracked file is a failure even when the process exits zero", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "tracked"), "before");
    execFileSync("git", ["add", "tracked"], { cwd: f.root, timeout: 10_000 });
    // Index contents count as tracked work; compare status to prove the postcondition.
    const receipt = await runPlan(
      plan(["-e", "require('fs').writeFileSync('tracked','after')"]),
      platform,
      { ...f, install: false },
    );
    assert(receipt.errors.includes("verification modified tracked candidate files"));
  } finally {
    f.close();
  }
});
