import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { digestPlan, needsPi, validatePlan } from "./run.ts";
import type { Receipt } from "./run.ts";
import type { Plan, Platform } from "./policy.ts";

export type Conclusions = { plan: string; linux: string; darwin: string };
export type Verdict = { status: "passed" | "failed"; errors: string[]; autoMergeEligible: boolean };

/**
 * Receipts describe coverage; actual GitHub job conclusions are also required.
 * The trusted workflow supplies those conclusions, not candidate-authored JSON.
 */
export function aggregate(plan: Plan, receipts: Receipt[], jobs: Conclusions): Verdict {
  validatePlan(plan);
  const errors = [...plan.blockers];
  for (const name of ["plan", "linux", "darwin"] as const)
    if (jobs[name] !== "success")
      errors.push(`${name} job did not succeed: ${jobs[name] ?? "missing"}`);
  const platforms: Platform[] = ["aarch64-darwin", "x86_64-linux"];
  for (const receipt of receipts)
    if (!platforms.includes(receipt.platform)) errors.push("unexpected receipt platform");
  for (const platform of platforms) {
    const matches = receipts.filter((receipt) => receipt.platform === platform);
    if (matches.length !== 1) {
      errors.push(`${platform}: expected one receipt, got ${matches.length}`);
      continue;
    }
    const receipt = matches[0];
    if (receipt.isolation?.controllerUid !== 0 || receipt.isolation.candidateUid !== 62001)
      errors.push(`${platform}: missing enforced controller/candidate identity separation`);
    if (
      receipt.schemaVersion !== 1 ||
      receipt.head !== plan.head ||
      receipt.base !== plan.base ||
      receipt.policyDigest !== plan.policyDigest ||
      receipt.planDigest !== digestPlan(plan)
    )
      errors.push(`${platform}: stale or mismatched evidence`);
    if (
      !Array.isArray(receipt.errors) ||
      !Array.isArray(receipt.setup) ||
      !Array.isArray(receipt.results)
    ) {
      errors.push(`${platform}: malformed receipt`);
      continue;
    }
    errors.push(...receipt.errors.map((error) => `${platform}: ${error}`));
    if (needsPi(plan, platform)) {
      if (
        receipt.setup.length !== 1 ||
        receipt.setup[0].program !== "pnpm" ||
        JSON.stringify(receipt.setup[0].args) !==
          JSON.stringify(["install", "--frozen-lockfile"]) ||
        receipt.setup[0].cwd !== "modules/pi" ||
        receipt.setup[0].status !== "passed" ||
        receipt.setup[0].exitCode !== 0 ||
        receipt.setup[0].signal !== null
      )
        errors.push(`${platform}: missing or failed frozen workspace setup`);
    } else if (receipt.setup.length) errors.push(`${platform}: unexpected setup`);
    const expected = plan.checks.filter((check) => check.platform === platform);
    const expectedIds = new Set(expected.map((check) => check.id));
    for (const result of receipt.results)
      if (!expectedIds.has(result.id)) errors.push(`${platform}: unexpected check ${result.id}`);
    for (const check of expected) {
      const results = receipt.results.filter((result) => result.id === check.id);
      if (results.length !== 1) {
        errors.push(`${platform}: missing or duplicate check ${check.id}`);
        continue;
      }
      const result = results[0];
      if (
        result.status !== "passed" ||
        result.phase !== check.phase ||
        !Array.isArray(result.commands) ||
        result.commands.length !== check.commands.length
      ) {
        errors.push(`${platform}: incomplete or failed check ${check.id}`);
        continue;
      }
      for (const [index, command] of check.commands.entries()) {
        const actual = result.commands[index];
        if (
          actual.program !== command.program ||
          actual.cwd !== (command.cwd ?? ".") ||
          JSON.stringify(actual.args) !== JSON.stringify(command.args) ||
          actual.status !== "passed" ||
          actual.exitCode !== 0 ||
          actual.signal !== null ||
          !Number.isFinite(actual.durationMs) ||
          actual.durationMs < 0
        )
          errors.push(`${platform}: failed or substituted command ${check.id}/${index}`);
      }
    }
  }
  return {
    status: errors.length ? "failed" : "passed",
    errors,
    autoMergeEligible: !errors.length && plan.autoMergeEligible,
  };
}

export function markdown(plan: Plan, verdict: Verdict): string {
  const rows = plan.checks.map(
    (check) =>
      `| \`${check.platform}\` | ${check.phase} | \`${check.id.replaceAll("|", "\\|")}\` |`,
  );
  return [
    `## merge-ready: ${verdict.status}`,
    "",
    `candidate: \`${plan.head}\`; base: \`${plan.base}\``,
    `policy: \`${plan.policyDigest}\``,
    `automatic merge eligible: **${verdict.autoMergeEligible}**`,
    "",
    ...(verdict.errors.length
      ? ["### blockers", ...verdict.errors.map((error) => `- ${error.replaceAll("\n", " ")}`), ""]
      : []),
    "| platform | evidence phase | check |",
    "|---|---|---|",
    ...rows,
    "",
    "verification only: no host activation, production credentials, model calls or live services.",
    "a passing build does not establish activation, usability, Homebrew upgrades or live provider acceptance.",
    "",
  ].join("\n");
}

export function main(argv: string[]): void {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !["--plan", "--receipts", "--jobs", "--summary"].includes(argv[i]) ||
      values.has(argv[i]) ||
      !argv[i + 1]
    )
      throw new Error("invalid gate flags");
    values.set(argv[i], argv[i + 1]);
  }
  if (values.size !== 4)
    throw new Error("gate.ts --plan FILE --receipts DIRECTORY --jobs JSON --summary FILE");
  const plan: Plan = JSON.parse(readFileSync(values.get("--plan")!, "utf8"));
  const directory = values.get("--receipts")!;
  const receipts = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")) as Receipt);
  const verdict = aggregate(plan, receipts, JSON.parse(values.get("--jobs")!));
  writeFileSync(values.get("--summary")!, markdown(plan, verdict));
  console.log(JSON.stringify(verdict, null, 2));
  if (verdict.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
