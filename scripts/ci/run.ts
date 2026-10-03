import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateSha, validPath } from "./policy.ts";
import type { CommandSpec, Plan, Platform } from "./policy.ts";

export type CommandResult = {
  program: string;
  args: string[];
  cwd: string;
  status: "passed" | "failed" | "timed-out";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  log: string;
  executedArgs?: string[];
};
export type Receipt = {
  schemaVersion: 1;
  base: string;
  head: string;
  policyDigest: string;
  planDigest: string;
  platform: Platform;
  setup: CommandResult[];
  results: {
    id: string;
    phase: string;
    status: "passed" | "failed" | "blocked";
    commands: CommandResult[];
  }[];
  errors: string[];
  isolation: { controllerUid: number; candidateUid: number } | null;
};
export type ExecutionIdentity = { uid: number; gid: number; home: string; gitDir: string };

export const digestPlan = (plan: Plan): string =>
  createHash("sha256").update(JSON.stringify(plan)).digest("hex");

export function validatePlan(plan: Plan): void {
  if (plan.schemaVersion !== 1) throw new Error("unsupported verification plan");
  validateSha(plan.base);
  validateSha(plan.head);
  if (
    !/^[0-9a-f]{64}$/.test(plan.policyDigest) ||
    !Array.isArray(plan.checks) ||
    !Array.isArray(plan.blockers) ||
    !plan.blockers.every((value) => typeof value === "string")
  )
    throw new Error("malformed verification plan");
  const seen = new Set<string>();
  for (const check of plan.checks) {
    if (
      !["aarch64-darwin", "x86_64-linux"].includes(check.platform) ||
      !["local", "evaluation", "artifact", "host", "runtime"].includes(check.phase) ||
      typeof check.id !== "string" ||
      !check.id ||
      !Array.isArray(check.commands) ||
      !check.commands.length
    )
      throw new Error("invalid check");
    const key = `${check.platform}:${check.id}`;
    if (seen.has(key)) throw new Error(`duplicate planned check: ${key}`);
    seen.add(key);
    for (const command of check.commands) {
      if (
        !["node", "pnpm", "nix", "nix-instantiate"].includes(command.program) ||
        !Array.isArray(command.args) ||
        !command.args.every((value) => typeof value === "string" && !value.includes("\0")) ||
        !Number.isInteger(command.timeoutSeconds) ||
        command.timeoutSeconds < 1 ||
        command.timeoutSeconds > 3600 ||
        (command.cwd !== undefined && !validPath(command.cwd))
      )
        throw new Error(`invalid command: ${key}`);
      // A plan must not override the fresh home or introduce credentials.
      for (const [name, value] of Object.entries(command.env ?? {}))
        if (name !== "PI_TEST_BUILT_TOOLS" || value !== "1")
          throw new Error(`unapproved command environment: ${name}`);
    }
  }
}

export function nativePlatform(): Platform {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-darwin";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-linux";
  throw new Error(`unsupported worker: ${process.platform}/${process.arch}`);
}

/** This keeps tests away from auth/state; containment comes from the disposable CI VM. */
export function environment(home: string, path: string): Record<string, string> {
  return {
    PATH: path,
    HOME: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
    PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"),
    PI_BDS_CONFIG_OVERRIDES_PATH: join(home, "bds-pi.local.json"),
    PI_MEMORY_ROOT: join(home, "memory"),
    PI_MEMORY_DATA_DIR: join(home, "memory-data"),
    PI_MEMORY_STATE_DIR: join(home, "memory-state"),
    PI_MEMORY_SKILLS_ROOT: join(home, "skills"),
    PI_AGENT_MEMORY_PROMPT_WORKER: "0",
    BDS_PI_LOG_DIR: join(home, "logs"),
    PI_OFFLINE: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    SSH_ASKPASS_REQUIRE: "never",
    CI: "true",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
    NIX_CONFIG: "experimental-features = nix-command flakes\naccept-flake-config = false\n",
  };
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix));
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(canonical(dirname(path)), basename(path));
  }
}

/** File-backed output and process-group deadlines also bound children holding stdout open. */
export async function execute(
  command: CommandSpec,
  root: string,
  env: Record<string, string>,
  log: string,
  identity?: Pick<ExecutionIdentity, "uid" | "gid">,
): Promise<CommandResult> {
  const cwd = realpathSync(resolve(root, command.cwd ?? "."));
  if (!within(realpathSync(root), cwd)) throw new Error("command cwd escapes checkout");
  mkdirSync(dirname(log), { recursive: true });
  const descriptor = openSync(log, "w", 0o600);
  const started = Date.now();
  const program = command.program === "node" ? process.execPath : command.program;
  // The candidate supplies resources, never the validator used to certify them.
  // Keep logical commands portable across workers; record actual argv in evidence.
  const args =
    command.program === "node" && command.args[0] === "scripts/ci/probes.ts"
      ? [
          join(dirname(fileURLToPath(import.meta.url)), "probes.ts"),
          "--root",
          root,
          ...command.args.slice(1),
        ]
      : command.args;
  writeSync(descriptor, `${JSON.stringify({ program, args, cwd })}\n`);
  return await new Promise((done) => {
    let timedOut = false;
    let finished = false;
    const child = spawn(program, args, {
      cwd,
      env: { ...env, ...command.env },
      detached: true,
      shell: false,
      ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
      stdio: ["ignore", descriptor, descriptor],
    });
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, command.timeoutSeconds * 1000);
    const cancel = () => {
      timedOut = true;
      kill();
    };
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    const finish = (exitCode: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.removeListener("SIGTERM", cancel);
      process.removeListener("SIGINT", cancel);
      kill();
      closeSync(descriptor);
      done({
        program: command.program,
        args: command.args,
        cwd: command.cwd ?? ".",
        executedArgs: args,
        status: timedOut ? "timed-out" : exitCode === 0 ? "passed" : "failed",
        exitCode,
        signal,
        durationMs: Date.now() - started,
        log,
      });
    };
    child.once("error", (error) => {
      writeFileSync(log, `${error.message}\n`);
      finish(null, null);
    });
    child.once("exit", finish);
  });
}

export function needsPi(plan: Plan, platform: Platform): boolean {
  return plan.checks
    .filter((check) => check.platform === platform)
    .some((check) =>
      check.commands.some(
        (command) =>
          command.cwd === "modules/pi" ||
          command.cwd === "modules/node-pnpm" ||
          command.args.some(
            (arg) =>
              arg.startsWith("modules/agents/") ||
              (arg.startsWith("scripts/ci/") &&
                (arg.endsWith(".test.ts") ||
                  (arg === "scripts/ci/probes.ts" && command.args[1] !== "docs"))),
          ),
      ),
    );
}

export async function runPlan(
  plan: Plan,
  platform: Platform,
  options: {
    root: string;
    output: string;
    executeCommand?: typeof execute;
    /** Test boundary only; the CLI always installs the workspace when required. */
    install?: boolean;
    execution?: ExecutionIdentity;
  },
): Promise<Receipt> {
  validatePlan(plan);
  if (nativePlatform() !== platform)
    throw new Error("worker does not match requested native platform");
  const identity = options.execution;
  if (identity && (process.getuid?.() !== 0 || identity.uid !== 62001 || identity.gid !== 62001))
    throw new Error("hosted execution requires root controller and dedicated candidate identity");
  const root = realpathSync(options.root);
  const output = canonical(resolve(options.output));
  if (within(root, output)) throw new Error("evidence must live outside the candidate checkout");
  mkdirSync(output, { recursive: true });
  const home = identity?.home ?? mkdtempSync(join(tmpdir(), "ci-verification-"));
  const env = environment(
    home,
    `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  );
  // Keep the repository's release-age policy; do not bypass it to make CI green.
  const executeCommand = options.executeCommand ?? execute;
  const receipt: Receipt = {
    schemaVersion: 1,
    base: plan.base,
    head: plan.head,
    policyDigest: plan.policyDigest,
    planDigest: digestPlan(plan),
    platform,
    setup: [],
    results: [],
    errors: [],
    isolation: identity ? { controllerUid: 0, candidateUid: identity.uid } : null,
  };
  try {
    if (needsPi(plan, platform)) {
      mkdirSync(join(home, ".config/pnpm"), { recursive: true });
      cpSync(join(root, "modules/node-pnpm/config.yaml"), join(home, ".config/pnpm/config.yaml"));
    }
    if (plan.blockers.length) receipt.errors.push(...plan.blockers);
    if (!receipt.errors.length && options.install !== false && needsPi(plan, platform)) {
      const installed = await executeCommand(
        {
          program: "pnpm",
          args: ["install", "--frozen-lockfile"],
          cwd: "modules/pi",
          timeoutSeconds: 600,
        },
        root,
        env,
        join(output, "setup.log"),
        identity,
      );
      receipt.setup.push(installed);
      if (installed.status !== "passed")
        receipt.errors.push("frozen Pi workspace installation failed");
    }
    for (const check of plan.checks.filter((check) => check.platform === platform)) {
      const result: Receipt["results"][number] = {
        id: check.id,
        phase: check.phase,
        status: "blocked",
        commands: [],
      };
      receipt.results.push(result);
      if (receipt.errors.length) continue;
      result.status = "passed";
      for (const [index, command] of check.commands.entries()) {
        const log = join(output, `${receipt.results.length}-${index}.log`);
        const execution = await executeCommand(command, root, env, log, identity);
        result.commands.push(execution);
        if (execution.status !== "passed") {
          result.status = "failed";
          receipt.errors.push(`failed ${check.id}: ${command.program} ${command.args.join(" ")}`);
          break;
        }
      }
    }
    // Candidate HOME and .git are writable test inputs, never audit authority.
    const auditArgs = identity
      ? [
          `--git-dir=${identity.gitDir}`,
          `--work-tree=${root}`,
          "-c",
          "safe.directory=*",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
        ]
      : [];
    const dirty = execFileSync(
      "/usr/bin/git",
      [...auditArgs, "status", "--porcelain=v1", "--untracked-files=no"],
      {
        cwd: root,
        env: {
          ...env,
          HOME: "/var/empty",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (dirty) receipt.errors.push("verification modified tracked candidate files");
  } catch (error) {
    receipt.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    if (!identity) rmSync(home, { recursive: true, force: true });
  }
  return receipt;
}

function flags(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !["--plan", "--root", "--platform", "--output"].includes(argv[i]) ||
      values.has(argv[i]) ||
      !argv[i + 1]
    )
      throw new Error("invalid runner flags");
    values.set(argv[i], argv[i + 1]);
  }
  if (values.size !== 4)
    throw new Error("run.ts --plan FILE --root ROOT --platform PLATFORM --output DIRECTORY");
  return values;
}

export async function main(argv: string[]): Promise<void> {
  const values = flags(argv);
  const plan: Plan = JSON.parse(readFileSync(values.get("--plan")!, "utf8"));
  const root = realpathSync(values.get("--root")!);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  }).trim();
  if (head !== plan.head) throw new Error("worker candidate HEAD does not match plan");
  if (
    execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
    })
  )
    throw new Error("worker candidate tracked checkout must be clean");
  const receipt = await runPlan(plan, values.get("--platform")! as Platform, {
    root,
    output: values.get("--output")!,
  });
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.errors.length || receipt.results.some((result) => result.status !== "passed"))
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
