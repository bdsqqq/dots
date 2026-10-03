import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPlan, validateSha, validPath } from "./policy.ts";
import type { Change, Plan } from "./policy.ts";

export function parseNameStatus(output: string): Change[] {
  if (output && !output.endsWith("\0")) throw new Error("truncated NUL git diff");
  const tokens = output.split("\0");
  tokens.pop();
  const changes: Change[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!/^(?:[AMDT]|[RC]\d{1,3})$/.test(status))
      throw new Error(`unsupported git status: ${status}`);
    const first = tokens[i++];
    if (!first || !validPath(first)) throw new Error("invalid git path");
    if (status.startsWith("R") || status.startsWith("C")) {
      const path = tokens[i++];
      if (!path || !validPath(path)) throw new Error("missing rename/copy destination");
      changes.push({ status: status[0] as "R" | "C", previousPath: first, path });
    } else changes.push({ status: status as Change["status"], path: first });
  }
  return changes;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function canonicalOutput(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(canonicalOutput(dirname(path)), basename(path));
  }
}
export function planCheckout(root: string, base: string, head: string, policyRoot?: string): Plan {
  validateSha(base);
  validateSha(head);
  root = realpathSync(resolve(root));
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root)
    throw new Error("--root must be the git working-tree root");
  if (git(root, ["rev-parse", "HEAD"]).trim() !== head)
    throw new Error("candidate HEAD does not match --head");
  // Untracked runtime artifacts are allowed; tracked work is never overwritten.
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=no", "-z"]))
    throw new Error("candidate tracked checkout must be clean");
  for (const sha of [base, head]) git(root, ["cat-file", "-e", `${sha}^{commit}`]);
  const changes = parseNameStatus(
    git(root, ["diff", "--name-status", "-z", "--find-renames", base, head, "--"]),
  );
  return createPlan({ root, base, head, changes, policyRoot });
}
export function main(argv: string[]): void {
  const required = ["--root", "--base", "--head", "--output"];
  const allowed = new Set([...required, "--policy-root"]);
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i],
      value = argv[i + 1];
    if (!allowed.has(key) || flags.has(key) || !value || value.startsWith("--"))
      throw new Error(
        "usage: plan.ts --root ROOT --base SHA --head SHA --output FILE [--policy-root ROOT]",
      );
    flags.set(key, value);
  }
  if (required.some((key) => !flags.has(key))) throw new Error("missing required planner flags");
  const plan = planCheckout(
    flags.get("--root")!,
    flags.get("--base")!,
    flags.get("--head")!,
    flags.get("--policy-root"),
  );
  const output = canonicalOutput(resolve(flags.get("--output")!));
  const root = realpathSync(resolve(flags.get("--root")!));
  const outputPath = relative(root, output);
  if (!outputPath.startsWith("../") && git(root, ["ls-files", "-z", "--", outputPath]))
    throw new Error("--output must not overwrite a tracked file");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
