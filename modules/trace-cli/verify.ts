#!/usr/bin/env node
// Runs this repo's local verification steps as one trace, so timings and failures accumulate
// in the default store. `trace-cli stats|assert baseline.json` read the history.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventLogger } from "../service-events/events.ts";
import { run } from "./ops.ts";
import { defaultStorePath } from "./store.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const steps: Record<string, { cwd: string; argv: string[] }> = {
  "pi-tsc": { cwd: "modules/pi", argv: ["pnpm", "exec", "tsc", "-p", "tsconfig.build.json", "--noEmit"] },
  "pi-vitest": { cwd: "modules/pi", argv: ["pnpm", "exec", "vitest", "run"] },
  "service-events-tests": { cwd: ".", argv: ["node", "--experimental-strip-types", "--test", "--test-concurrency=1", "modules/service-events/events.test.ts", "modules/service-events/projections.test.ts"] },
  "trace-cli-tests": { cwd: ".", argv: ["node", "--experimental-strip-types", "--test", "modules/trace-cli/trace-cli.test.ts"] },
  "nix-eval-mbp-m2": { cwd: ".", argv: ["nix", "eval", "--raw", "--no-write-lock-file", ".#darwinConfigurations.mbp-m2.system.drvPath"] },
};

const only = process.argv.slice(2);
const unknown = only.filter((n) => !(n in steps));
if (unknown.length) { console.error(`unknown step: ${unknown.join(", ")}\nsteps: ${Object.keys(steps).join(", ")}`); process.exit(2); }
const selected = only.length ? only : Object.keys(steps).filter((n) => n !== "nix-eval-mbp-m2");

const events = createEventLogger("trace-cli", { sink: (e) => { process.stderr.write(`${JSON.stringify(e)}\n`); } });
const store = defaultStorePath();

function runStep(name: string): number {
  const step = steps[name]!;
  // check output goes to stderr: compiler errors and test failures stay visible, stdout stays clean.
  const exec = (argv: string[], env: Record<string, string | undefined>) =>
    spawnSync(argv[0]!, argv.slice(1), { cwd: join(root, step.cwd), stdio: ["ignore", process.stderr.fd, process.stderr.fd], env }).status;
  const r = run({ store, events, exec }, name, step.argv, process.env);
  const code = r.status === "ran" ? r.exitCode : 2;
  console.error(`${code === 0 ? "ok  " : "FAIL"} ${name}`);
  return code;
}

// the root span's "command" is the selected steps; it only passes TRACEPARENT through the environment.
const rootExec = (_argv: string[], env: Record<string, string | undefined>) => {
  Object.assign(process.env, { TRACEPARENT: env.TRACEPARENT });
  return selected.map(runStep).some((c) => c !== 0) ? 1 : 0;
};

const result = run({ store, events, exec: rootExec }, "verify", ["verify"], process.env);
process.exit(result.status === "ran" ? result.exitCode : 2);
