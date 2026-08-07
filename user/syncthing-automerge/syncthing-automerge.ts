#!/usr/bin/env node
/**
 * syncthing-automerge - automatic conflict resolution for Syncthing
 *
 * Watches for Syncthing conflict files and performs git three-way merges
 * using the original file and the latest backup from .stversions/
 *
 * Ported from Python (scripts/syncthing-automerge.py) to TypeScript
 *
 * Original: https://gist.github.com/solarkraft/26fe291a3de075ae8d96e1ada928fb7d
 *
 * MIT License - Copyright 2024 solarkraft
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ============================================================================
// TYPES
// ============================================================================

interface ConflictMatch {
  /** base name without extension */
  name: string;
  /** date portion of conflict marker (YYYYMMDD) */
  date: string;
  /** time portion of conflict marker (HHMMSS) */
  time: string;
  /** unique id portion of conflict marker */
  id: string;
  /** file extension (after the conflict marker) */
  extension: string;
  /** full path of conflict file */
  conflictPath: string;
  /** reconstructed original file path */
  originalPath: string;
}

interface QuarantinePaths {
  snapshot: string;
  metadata: string;
}

// ============================================================================
// PATTERNS
// ============================================================================

/**
 * Matches Syncthing conflict files.
 *
 * Examples:
 * - `filename.sync-conflict-20240115-143022-ABC123.md`
 * - `filename%2Fsync-conflict-20240115-143022-ABC123.md` (Logseq encoding)
 */
const CONFLICT_PATTERN =
  /^(.*?)(?:\.|%2F)sync-conflict-([0-9]{8})-([0-9]{6})-([A-Za-z0-9]{7})\.?(.*)$/;

// ============================================================================
// CORE LOGIC
// ============================================================================

/**
 * Parse a potential conflict file path. Returns null if not a conflict file.
 */
export function parseConflictFile(filePath: string, cwd: string): ConflictMatch | null {
  const relativePath = relative(cwd, filePath);
  const match = relativePath.match(CONFLICT_PATTERN);

  if (!match) return null;

  const [, name, date, time, id, extension] = match;
  const originalPath = extension ? `${name}.${extension}` : name;

  return {
    name,
    date,
    time,
    id,
    extension,
    conflictPath: relativePath,
    originalPath,
  };
}

/**
 * Find the matching trash-can backup, or the latest timestamped backup used
 * by Syncthing's simple and staggered versioning strategies.
 */
export function findBackupFile(
  originalPath: string,
  extension: string,
  cwd: string
): string | null {
  const stversionsDir = join(cwd, ".stversions");
  if (!existsSync(stversionsDir)) return null;

  const trashCanBackup = join(stversionsDir, originalPath);
  if (existsSync(trashCanBackup) && statSync(trashCanBackup).isFile()) {
    return relative(cwd, trashCanBackup);
  }

  const backupDir = join(stversionsDir, dirname(originalPath));
  if (!existsSync(backupDir)) return null;

  const fileName = originalPath.slice(originalPath.lastIndexOf("/") + 1);
  const baseName = extension ? fileName.slice(0, -(extension.length + 1)) : fileName;
  const extensionPattern = extension ? `\\.${escapeRegex(extension)}` : "";
  const backupPattern = new RegExp(
    `^${escapeRegex(baseName)}~([0-9]{8})-([0-9]{6})${extensionPattern}$`
  );

  const backups: { path: string; date: string; time: string }[] = [];

  try {
    for (const entry of readdirSync(backupDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        const match = entry.name.match(backupPattern);
        if (match) {
          backups.push({
            path: relative(cwd, join(backupDir, entry.name)),
            date: match[1],
            time: match[2],
          });
        }
      }
    }
  } catch {
    return null;
  }

  if (backups.length === 0) return null;

  // Sort by date/time descending, return latest
  backups.sort((a, b) => {
    const dtA = a.date + a.time;
    const dtB = b.date + b.time;
    return dtB.localeCompare(dtA);
  });

  return backups[0].path;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function getQuarantinePaths(cwd: string): QuarantinePaths {
  const quarantineDir = join(cwd, ".syncthing-conflicts");
  let id: string;
  let snapshot: string;
  let metadata: string;

  do {
    id = randomUUID();
    snapshot = join(quarantineDir, `${id}.conflict`);
    metadata = join(quarantineDir, `${id}.json`);
  } while (existsSync(snapshot) || existsSync(metadata));

  return { snapshot, metadata };
}

/**
 * Merge into a temporary file, then replace the original only if all three
 * inputs stayed unchanged while Git was running. The displaced original is
 * retained until the merged result has been installed without overwriting a
 * concurrently recreated canonical path.
 */
export async function mergeFiles(
  original: string,
  backup: string,
  conflict: string,
  cwd: string
): Promise<boolean> {
  const paths = [original, backup, conflict].map((path) => resolve(cwd, path));
  const hashes = paths.map(hashFile);

  const result = await new Promise<{ exitCode: number; output: Buffer }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn("git", ["merge-file", "-p", original, backup, conflict], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks) });
    });
  });

  if (result.exitCode !== 0 || paths.some((path, index) => hashFile(path) !== hashes[index])) {
    return false;
  }

  const originalFullPath = paths[0];
  const stagingDir = join(cwd, ".stversions", ".syncthing-automerge");
  mkdirSync(stagingDir, { recursive: true });
  const token = randomUUID();
  const temporaryPath = join(stagingDir, `${token}.merged`);
  const recoveryPath = join(stagingDir, `${token}.${basename(originalFullPath)}.original`);

  try {
    writeFileSync(temporaryPath, result.output);
    chmodSync(temporaryPath, statSync(originalFullPath).mode);

    renameSync(originalFullPath, recoveryPath);
    if (hashFile(recoveryPath) !== hashes[0]) {
      if (!existsSync(originalFullPath)) renameSync(recoveryPath, originalFullPath);
      return false;
    }

    try {
      linkSync(temporaryPath, originalFullPath);
    } catch {
      if (!existsSync(originalFullPath)) renameSync(recoveryPath, originalFullPath);
      return false;
    }

    rmSync(recoveryPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  return true;
}

/**
 * Handle a potential conflict file. Returns true if merge was performed.
 */
export async function handleConflict(filePath: string, cwd: string): Promise<boolean> {
  // Check file exists
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return false;
  }

  const parsed = parseConflictFile(filePath, cwd);
  if (!parsed) return false;

  console.log();
  console.log(`Conflict file found: ${parsed.conflictPath}`);

  // Small delay for Syncthing to finish moving temp files
  await new Promise((r) => setTimeout(r, 100));

  // Check original file exists
  const originalFullPath = resolve(cwd, parsed.originalPath);
  if (!existsSync(originalFullPath)) {
    console.log(`... but original file ${parsed.originalPath} doesn't exist`);
    console.log("(could be a syncthing tmpfile)");
    return false;
  }

  console.log(`For original file: ${parsed.originalPath}`);

  // Find backup
  const backupPath = findBackupFile(parsed.originalPath, parsed.extension, cwd);
  if (!backupPath) {
    console.log("No backup file found in .stversions/");
    console.log("This may be due to custom versioning settings - try simple versioning.");
    return false;
  }

  console.log(`Latest backup file: ${backupPath}`);

  const conflictFullPath = resolve(cwd, parsed.conflictPath);
  const quarantine = getQuarantinePaths(cwd);
  mkdirSync(dirname(quarantine.snapshot), { recursive: true });
  writeFileSync(
    quarantine.metadata,
    JSON.stringify(
      {
        version: 1,
        conflictPath: parsed.conflictPath,
        originalPath: parsed.originalPath,
        conflict: {
          date: parsed.date,
          time: parsed.time,
          id: parsed.id,
          extension: parsed.extension,
        },
        size: statSync(conflictFullPath).size,
        quarantinedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    { flag: "wx" }
  );
  try {
    renameSync(conflictFullPath, quarantine.snapshot);
  } catch (error) {
    rmSync(quarantine.metadata, { force: true });
    throw error;
  }

  // Perform merge
  console.log("Performing three-way merge...");
  let success: boolean;
  try {
    success = await mergeFiles(
      parsed.originalPath,
      backupPath,
      relative(cwd, quarantine.snapshot),
      cwd
    );
  } catch (error) {
    console.error(`Merge failed; conflict quarantined at ${relative(cwd, quarantine.snapshot)}`);
    throw error;
  }

  if (!success) {
    console.error(
      `Merge was not clean; conflict quarantined at ${relative(cwd, quarantine.snapshot)}`
    );
    return false;
  }

  // Delete the immutable conflict snapshot used by the successful merge.
  console.log("Deleting conflict file");
  rmSync(quarantine.snapshot);
  rmSync(quarantine.metadata);

  console.log("Deconfliction done!");
  console.log();
  return true;
}

export function createConflictQueue(cwd: string) {
  const pending = new Map<string, Promise<boolean>>();

  return (filePath: string): Promise<boolean> => {
    const parsed = parseConflictFile(filePath, cwd);
    if (!parsed) return Promise.resolve(false);

    const previous = pending.get(parsed.originalPath) ?? Promise.resolve(false);
    const current = previous
      .catch(() => false)
      .then(() => handleConflict(filePath, cwd))
      .finally(() => {
        if (pending.get(parsed.originalPath) === current) {
          pending.delete(parsed.originalPath);
        }
      });

    pending.set(parsed.originalPath, current);
    return current;
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const cwd = process.cwd();
  console.log("Running Syncthing deconflicter");
  console.log(`Watching: ${cwd}`);
  const enqueueConflict = createConflictQueue(cwd);

  const watcher = watch(
    ".",
    { recursive: true },
    (_event: string, filename: string | null) => {
      if (!filename) return;

      enqueueConflict(resolve(cwd, filename)).catch((e) => {
        console.error(`Error handling ${filename}:`, e.message);
      });
    }
  );

  watcher.on("error", (error) => {
    console.error("Watcher error:", error);
  });

  // Keep process alive
  await new Promise(() => {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
