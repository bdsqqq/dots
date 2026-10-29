import { spawnSync } from "node:child_process";
import fs, { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { digest, fetchRelease, newer, parseRelease, publishedReleaseUrl, reportedVersion, runCommand, version, withVerifiedArchive } from "./release.ts";
import type { Architecture, Release, Run } from "./release.ts";
export { newer } from "./release.ts";

function replace(source: string, target: string) {
  mkdirSync(join(target, ".."), { recursive: true });
  const temporary = `${target}.rex-update-${process.pid}`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * claim the old inode, then publish without replacement. an uncooperative native
 * installer cannot share our lock; a check followed by ordinary rename loses its writes.
 * the path can briefly be absent, as with upstream's native `install` command.
 */
export function publish(source: string, target: string, expectedHash: string): boolean {
  const staging = mkdtempSync(join(dirname(target), ".rex-update-"));
  const held = join(staging, "previous"), candidate = join(staging, "candidate");
  let keepConflict = false;
  const linkIfAbsent = (from: string): boolean => {
    try { fs.linkSync(from, target); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };
  try {
    copyFileSync(source, candidate);
    chmodSync(candidate, 0o755);
    fs.renameSync(target, held);
    if (digest(held) !== expectedHash) {
      // if a second native write also arrived, preserve both instead of discarding one.
      keepConflict = !linkIfAbsent(held);
      return false;
    }
    return linkIfAbsent(candidate);
  } catch (error) {
    if (existsSync(held)) {
      // restoration itself can fail (e.g. a full filesystem); never delete the only held copy.
      keepConflict = true;
      keepConflict = !linkIfAbsent(held);
    }
    throw error;
  } finally {
    if (keepConflict) console.error(`rex: preserved executable for recovery at ${held}`);
    else rmSync(staging, { recursive: true, force: true });
  }
}

/** a native replacement gets the same validation and apply path as timer installs. */
export function applyInstalled({
  root = "/", run = runCommand,
  active = () => spawnSync("systemctl", ["is-active", "--quiet", "rex-login-server.service"]).status === 0,
}: { root?: string; run?: Run; active?: () => boolean } = {}): string {
  const binary = join(root, "usr/local/bin/rex");
  const backup = join(root, "var/lib/rex-update/last-good");
  const hash = digest(binary);
  const restart = active();
  mkdirSync(dirname(backup), { recursive: true });
  const validation = mkdtempSync(join(dirname(backup), ".validate-"));
  const snapshot = join(validation, "rex");
  try {
    copyFileSync(binary, snapshot);
    chmodSync(snapshot, 0o755);
    if (digest(snapshot) !== hash) throw new Error("rex changed during validation");
    run(snapshot, ["--help"]);
    const installed = run(snapshot, ["version"]);
    version(installed);
    if (digest(binary) !== hash) throw new Error("rex changed during validation");
    if (existsSync(backup) && digest(backup) === hash) return installed;
    if (restart) {
      run("systemctl", ["restart", "rex-login-server.service"]);
      run("systemctl", ["is-active", "--quiet", "rex-login-server.service"]);
    }
    // do not bless a second writer's untested replacement.
    if (digest(binary) !== hash) throw new Error("rex changed during validation");
    replace(snapshot, backup);
    return installed;
  } catch (error) {
    if (existsSync(backup) && digest(binary) === hash) {
      const restored = publish(backup, binary, hash);
      if (restored && restart) run("systemctl", ["restart", "rex-login-server.service"]);
    }
    throw error;
  } finally {
    rmSync(validation, { recursive: true, force: true });
  }
}

function writeReceipt(root: string, release: Release, binarySha256: string) {
  const receipt = join(root, "var/lib/rex-update/applied.json"), temporary = `${receipt}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ source: publishedReleaseUrl, release,
      binarySha256, appliedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, receipt);
  } finally { rmSync(temporary, { force: true }); }
}
function receiptMatches(root: string, release: Release, hash: string): boolean {
  try {
    const receipt = JSON.parse(readFileSync(join(root, "var/lib/rex-update/applied.json"), "utf8"));
    return receipt.source === publishedReleaseUrl && receipt.binarySha256 === hash &&
      JSON.stringify(parseRelease(receipt.release)) === JSON.stringify(release);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}
export function status(root = "/") {
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(root, "var/lib/rex-update/applied.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { state: "unverified", reason: "no pinned release has been verified", matchesInstalledBinary: false };
  }
  return { ...receipt, matchesInstalledBinary: existsSync(join(root, "usr/local/bin/rex")) &&
    digest(join(root, "usr/local/bin/rex")) === receipt.binarySha256 };
}

/** consume only the git-published pin, never the moving upstream channel. */
export function update({
  root = "/", arch = process.arch, run = runCommand, active,
}: { root?: string; arch?: string; run?: Run; active?: () => boolean } = {}): string {
  const binary = join(root, "usr/local/bin/rex");
  const installed = applyInstalled({ root, run, active });
  const original = digest(binary);
  if (arch !== "x64" && arch !== "arm64") throw new Error(`unsupported rex architecture: ${arch}`);
  const release = fetchRelease(publishedReleaseUrl, run);
  const sameVersion = reportedVersion(installed) === release.version;
  if (sameVersion && receiptMatches(root, release, original)) return "already current (verified published pin)";
  if (!sameVersion && !newer(release.version, installed)) return "newer native install or alternate build; published pin not applied";
  return withVerifiedArchive(release, arch as Architecture, candidate => {
    const verifiedHash = digest(candidate);
    if (digest(binary) !== original) return "native install changed during download; left untouched";
    if (sameVersion) {
      // bootstrap/current installs also need evidence; a version string alone cannot bless custom bytes.
      if (original !== verifiedHash) return "native bytes differ from published pin; left untouched";
      writeReceipt(root, release, verifiedHash);
      return "already current (verified published pin)";
    }
    if (!publish(candidate, binary, original)) return "native install changed at publish; left untouched";
    applyInstalled({ root, run, active });
    if (digest(binary) !== verifiedHash) return "native install changed during apply; left untouched";
    writeReceipt(root, release, verifiedHash);
    return `updated to ${release.version}`;
  }, run);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    console.log("rex-update: [--apply-only [--no-restart] | --status]; default: apply the pin published on main");
  } else if (process.argv.includes("--status")) {
    const result = status();
    console.log(JSON.stringify(result, null, 2));
    if (!result.matchesInstalledBinary) process.exitCode = 1;
  } else if (process.argv.includes("--apply-only")) {
    applyInstalled({ active: process.argv.includes("--no-restart") ? () => false : undefined });
    console.log("rex: native install validated/applied");
  } else {
    console.log(`rex: ${update()}`);
  }
}
