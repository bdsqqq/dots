#!/usr/bin/env node
// Runs this repo's local verification steps as one trace, so timings and failures accumulate
// in the default store. `trace-cli stats|assert baseline.json` read the history.
import { spawn } from "node:child_process";
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

const flags = process.argv.slice(2);
const serial = flags.includes("--serial");
const only = flags.filter((f) => f !== "--serial");
const unknown = only.filter((n) => !(n in steps));
if (unknown.length) { console.error(`unknown step: ${unknown.join(", ")}\nsteps: ${Object.keys(steps).join(", ")}\n--serial runs one step at a time (cleaner timings, slower)`); process.exit(2); }
const selected = only.length ? only : Object.keys(steps).filter((n) => n !== "nix-eval-mbp-m2");

const events = createEventLogger("trace-cli", { sink: (e) => { process.stderr.write(`${JSON.stringify(e)}\n`); } });
const store = defaultStorePath();

async function runStep(name: string): Promise<number> {
  const step = steps[name]!;
  // output is buffered per step and replayed only on failure, so parallel steps don't interleave.
  const exec = (argv: string[], env: Record<string, string | undefined>) => new Promise<number | null>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: join(root, step.cwd), env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => out.push(c));
    child.on("error", () => resolve(127));
    child.on("close", (code) => { if (code !== 0) process.stderr.write(Buffer.concat(out)); resolve(code); });
  });
  const r = await run({ store, events, exec }, name, step.argv, process.env, { mode: serial ? "serial" : "parallel" });
  const code = r.status === "ran" ? r.exitCode : 2;
  console.error(`${code === 0 ? "ok  " : "FAIL"} ${name}`);
  return code;
}

// the root span's "command" is the selected steps; it only passes TRACEPARENT through the environment.
const rootExec = async (_argv: string[], env: Record<string, string | undefined>) => {
  Object.assign(process.env, { TRACEPARENT: env.TRACEPARENT });
  const codes: number[] = [];
  if (serial) for (const n of selected) codes.push(await runStep(n));
  else codes.push(...(await Promise.all(selected.map(runStep))));
  return codes.some((c) => c !== 0) ? 1 : 0;
};

const result = await run({ store, events, exec: rootExec }, "verify", ["verify"], process.env, { mode: serial ? "serial" : "parallel" });
process.exit(result.status === "ran" ? result.exitCode : 2);
