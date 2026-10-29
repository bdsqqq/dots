import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [pnpm, ...args] = process.argv.slice(2);
const separator = args.indexOf("--");
const beforeSeparator = args.slice(0, separator < 0 ? args.length : separator);
const projectCommands = new Set([
  "add",
  "install",
  "i",
  "remove",
  "rm",
  "uninstall",
  "un",
  "update",
  "up",
  "upgrade",
  "list",
  "ls",
  "ll",
  "outdated",
  "why",
  "bin",
  "root",
  "rebuild",
  "approve-builds",
]);
// skip leading option values: a store directory named `exec` is not a command.
const valueOptions = new Set([
  "--dir",
  "-C",
  "--filter",
  "-F",
  "--filter-prod",
  "--store-dir",
  "--state-dir",
  "--registry",
  "--reporter",
  "--loglevel",
  "--npmrc-auth-file",
  "--userconfig",
  "--workspace-packages",
  "--workspace-concurrency",
  "--network-concurrency",
  "--fetch-retries",
  "--fetch-timeout",
  "--https-proxy",
  "--http-proxy",
  "--no-proxy",
  "--pm-on-fail",
  "--use-node-version",
]);
let commandIndex = -1;
for (let index = 0; index < beforeSeparator.length; index++) {
  const arg = beforeSeparator[index];
  if (valueOptions.has(arg)) index++;
  else if (!arg.startsWith("-")) {
    commandIndex = index;
    break;
  }
}
// run/exec and implicit scripts own trailing flags, even without an explicit `--`.
const childIndex =
  commandIndex >= 0 && !projectCommands.has(args[commandIndex]) ? commandIndex : -1;
const optionEnd = childIndex >= 0 ? childIndex : beforeSeparator.length;
const options = args.slice(0, optionEnd);
const isGlobal = (arg: string) =>
  arg === "--global" || arg === "--global=true" || /^-[^-]*g/.test(arg);
let forwarded = args;

if (options.some(isGlobal)) {
  // competing selectors must not redirect a supposedly global write elsewhere.
  if (
    options.some((arg) =>
      /^(?:-[CF]|-[^-]*r|--(?:dir|filter|filter-prod|recursive|ignore-workspace|global-dir|global-bin-dir|lockfile-dir)(?:$|=)|--config\.(?:dir|filter|recursive|global-dir|global-bin-dir|lockfile-dir)=|--global=false)/.test(
        arg,
      ),
    )
  ) {
    console.error(
      "pnpm: -g targets the tracked tools project; do not combine it with other project selectors",
    );
    process.exit(1);
  }
  forwarded = [
    "--dir",
    dirname(fileURLToPath(import.meta.url)),
    "--workspace-root",
    ...options.flatMap((arg) => {
      if (!isGlobal(arg)) return [arg];
      if (arg.startsWith("--")) return [];
      const remaining = arg.slice(1).replaceAll("g", "");
      return remaining ? [`-${remaining}`] : [];
    }),
    ...args.slice(optionEnd),
  ];
}

// the launcher supplies an absolute upstream binary, so delegation cannot recurse.
const result = spawnSync(pnpm, forwarded, { stdio: "inherit" });
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
