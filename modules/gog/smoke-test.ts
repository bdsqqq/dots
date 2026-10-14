#!/usr/bin/env node
/** Built-binary probes and synthetic config only; never open live private state. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

const [gog, wacli, gogVersion, wacliVersion] = process.argv.slice(2);
assert(gog && wacli && gogVersion && wacliVersion,
  "usage: node modules/gog/smoke-test.ts GOG_BINARY WACLI_BINARY GOG_VERSION WACLI_VERSION");
const probes: [string, string[], string][] = [
  [gog, ["--version"], gogVersion],
  [gog, ["--help"], "gmail"],
  [gog, ["auth", "add", "--help"], "--readonly"],
  [gog, ["auth", "add", "--help"], "--services"],
  [gog, ["auth", "credentials", "set", "--help"], "credentials"],
  [gog, ["auth", "keyring", "--help"], "keyring"],
  [gog, ["auth", "remove", "--help"], "remove"],
  [gog, ["gmail", "search", "--help"], "--max"],
  [gog, ["calendar", "events", "--help"], "--from"],
  [gog, ["config", "path", "--help"], "path"],
  [wacli, ["--version"], wacliVersion],
  [wacli, ["--help"], "--store"],
  [wacli, ["auth", "--help"], "bootstrap sync"],
  [wacli, ["auth", "status", "--help"], "status"],
  [wacli, ["auth", "logout", "--help"], "invalidate session"],
  [wacli, ["doctor", "--help"], "--connect"],
  [wacli, ["messages", "search", "--help"], "--limit"],
  [wacli, ["send", "text", "--help"], "--to"],
];
const home = mkdtempSync(join(tmpdir(), "gog-wacli-help-"));
try {
  // Remove inherited CLI overrides so probes cannot select live credentials.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("GOG_") && !key.startsWith("WACLI_")));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
  const run = (binary: string, args: string[]): string => {
    const result = spawnSync(binary, args, { env, cwd: home, encoding: "utf8", timeout: 20_000 });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, `${binary} ${args.join(" ")}: ${output}`);
    return output;
  };
  for (const [binary, args, expected] of probes) {
    const output = run(binary, args);
    assert(output.toLowerCase().includes(expected.toLowerCase()), `${args.join(" ")}: missing ${expected}: ${output}`);
    console.log(`pass: ${basename(binary)} ${args.join(" ")}${args[0] === "--version" ? `: ${output.trim()}` : ""}`);
  }
  assert.deepEqual(readdirSync(home), [], "help unexpectedly wrote private state");
  const config = run(gog, ["config", "path"]).trim();
  const fromHome = relative(home, config);
  assert(isAbsolute(config) && fromHome && !fromHome.startsWith("..") && !isAbsolute(fromHome), "config escaped isolated home");
  mkdirSync(dirname(config), { recursive: true });
  const target = join(home, "synthetic-config.json");
  const original = '{"default_timezone":"America/Sao_Paulo"}\n';
  writeFileSync(target, original);
  symlinkSync(target, config);
  run(gog, ["config", "set", "timezone", "UTC"]);
  assert(!lstatSync(config).isSymbolicLink(), "native writer unexpectedly preserved file symlink");
  assert.equal(readFileSync(target, "utf8"), original, "native writer edited symlink target");
  assert(readFileSync(config, "utf8").includes('"UTC"'));
  console.log("pass: synthetic gog config write replaces file symlink, preserving target");
  const search: unknown = JSON.parse(run(wacli, [
    "--store", join(home, "wacli-store"), "--json",
    "messages", "search", "__isolated_empty_store_probe__", "--limit", "1",
  ]));
  assert(search && typeof search === "object" && "data" in search);
  const data = search.data;
  assert(data && typeof data === "object" && "fts" in data && data.fts === true,
    "built wacli must provide SQLite full-text search");
  console.log("pass: isolated empty wacli store uses full-text search; real history untested");
  console.log(`${probes.length} help/version probes passed; no private-state files created by help; auth/API behavior untested`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
