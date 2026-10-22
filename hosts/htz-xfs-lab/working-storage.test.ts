import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GIB, assertReady, assertSources, capacityReport, collectRoot, nativeCommand, parseStorage, type Command, type Storage } from "./working-storage.ts";

const cfg = parseStorage(JSON.parse(readFileSync(new URL("./storage.json", import.meta.url), "utf8")));
const stats = (free = 38, mode = "normal") => `device :\n  1K-blocks : ${45 * GIB / 1024}\n  1K-blocks available : ${free * GIB / 1024}\n  operating mode : ${mode}\n`;
const mounted: Command = (executable, args) => executable === "findmnt" ? args.includes("LABEL") ? cfg.label : "fixture-uuid" : "";

test("reports physical capacity, not the overcommitted filesystem", () => {
  const result = capacityReport(stats(), 8 * GIB);
  assert.equal(result.healthy, true);
  assert.equal(result.vdo_physical_total_bytes, 45 * GIB);
  assert.equal(result.vdo_physical_free_bytes, 38 * GIB);
});

test("physical pressure, bad mode, and root pressure fail at the policy boundaries", () => {
  assert.equal(capacityReport(stats(9), 4 * GIB).healthy, false);
  assert.equal(capacityReport(stats(10), 4 * GIB).healthy, true);
  assert.equal(capacityReport(stats(), GIB).healthy, false);
  assert.equal(capacityReport(stats(38, "read-only"), 8 * GIB).healthy, false);
});

test("missing and invalid physical statistics never report success", () => {
  for (const output of ["", "no VDO device", stats(46), stats(-1), stats().replace("47185920", "invalid")]) {
    assert.throws(() => capacityReport(output, 8 * GIB), /invalid VDO/);
  }
});

test("valid mounts pass; missing mounts and wrong identities fail", () => {
  assert.doesNotThrow(() => assertReady(cfg, false, mounted));
  const missing: Command = () => { throw new Error("absent mount"); };
  assert.throws(() => assertReady(cfg, true, missing), /absent mount/);
  assert.throws(() => assertReady(cfg, true, (exe, args) => args.includes("LABEL") ? "wrong-label" : mounted(exe, args)), /identity/);
  assert.throws(() => assertReady(cfg, false, (exe, args) => args.at(-1) === join(cfg.home, cfg.directories[0]) ? "wrong-uuid" : mounted(exe, args)), /bind identity/);
});

test("seed validation rejects incomplete, missing, and symlinked sources", () => {
  const root = mkdtempSync(join(tmpdir(), "working-storage-"));
  const selected: Storage = { ...cfg, volume: join(root, "volume"), home: join(root, "home"), directories: ["repo"] };
  const source = join(selected.volume, "host-data/bdsqqq/repo");
  const marker = join(selected.volume, "host-data/.migration-complete");
  try {
    mkdirSync(join(selected.volume, "host-data/bdsqqq"), { recursive: true });
    assert.throws(() => assertSources(selected, mounted));
    writeFileSync(marker, "");
    assert.throws(() => assertSources(selected, mounted));
    mkdirSync(source);
    assert.doesNotThrow(() => assertSources(selected, mounted));
    rmSync(source, { recursive: true });
    symlinkSync(root, source);
    assert.throws(() => assertSources(selected, mounted), /unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pressure GC preserves profiles and only asks for the required dead-store bytes", () => {
  const calls: { executable: string; args: string[] }[] = [];
  const command: Command = (executable, args) => { calls.push({ executable, args }); return ""; };
  collectRoot(4 * GIB, command);
  assert.deepEqual(calls, []);
  collectRoot(3 * GIB, command);
  assert.deepEqual(calls, [{ executable: "nix-store", args: ["--gc", "--max-freed", String(5 * GIB)] }]);
});

test("configuration rejects unsafe or duplicate source paths", () => {
  for (const directories of [[], ["../escape"], ["/absolute"], ["repo", "repo"], ["a//b"], [1]]) {
    assert.throws(() => parseStorage({ ...cfg, directories }));
  }
  assert.throws(() => parseStorage({ ...cfg, volume: "/" }));
  assert.throws(() => parseStorage({ ...cfg, home: "/home/../elsewhere" }));
});

test("native command failures and timeouts are bounded and structural", () => {
  assert.throws(() => nativeCommand("/intentionally-missing-working-storage-probe", []), /failed or timed out/);
  assert.throws(() => nativeCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 50), /failed or timed out/);
});

test("CLI rejects malformed configuration before any mount or GC operation", () => {
  const root = mkdtempSync(join(tmpdir(), "working-storage-cli-"));
  try {
    const config = join(root, "invalid.json");
    writeFileSync(config, "{}");
    const result = spawnSync(process.execPath, [new URL("./working-storage.ts", import.meta.url).pathname, "--config", config, "health"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).healthy, false);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
