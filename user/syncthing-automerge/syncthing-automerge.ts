#!/usr/bin/env bun
/**
 * syncthing-automerge - automatic conflict resolution for Syncthing
 *
 * Watches for Syncthing conflict files and performs git three-way merges
 * using the original file and the latest backup from .stversions/
 *
 * Ported from Python (scripts/syncthing-automerge.py) to TypeScript/Bun
 *
 * Original: https://gist.github.com/solarkraft/26fe291a3de075ae8d96e1ada928fb7d
 *
 * MIT License - Copyright 2024 solarkraft
 */

import { watch } from "chokidar";
import { existsSync, readdirSync, rmSync, statSync } from "fs";
import { join, relative, resolve } from "path";

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
function parseConflictFile(filePath: string, cwd: string): ConflictMatch | null {
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
 * Find the latest backup file in .stversions/ matching the original file.
 */
function findBackupFile(originalPath: string, extension: string, cwd: string): string | null {
  const stversionsDir = join(cwd, ".stversions");
  if (!existsSync(stversionsDir)) return null;

  // Backup pattern: .stversions/filename~YYYYMMDD-HHMMSS.ext
  const baseName = originalPath.replace(/\.[^.]+$/, "");
  const backupPattern = new RegExp(
    `^${escapeRegex(baseName)}~([0-9]{8})-([0-9]{6})\\.${escapeRegex(extension)}$`
  );

  const backups: { path: string; date: string; time: string }[] = [];

  function scanDir(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else {
        const rel = relative(cwd, fullPath);
        const match = rel.match(backupPattern);
        if (match) {
          backups.push({ path: rel, date: match[1], time: match[2] });
        }
      }
    }
  }

  try {
    scanDir(stversionsDir);
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

/**
 * Perform git three-way merge.
 */
async function mergeFiles(original: string, backup: string, conflict: string, cwd: string): Promise<boolean> {
  const result = await Bun.$`git merge-file --union ${original} ${backup} ${conflict}`
    .cwd(cwd)
    .quiet()
    .nothrow();

  return result.exitCode === 0;
}

/**
 * Handle a potential conflict file. Returns true if merge was performed.
 */
async function handleConflict(filePath: string, cwd: string): Promise<boolean> {
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

  // Perform merge
  console.log("Performing three-way merge...");
  const success = await mergeFiles(parsed.originalPath, backupPath, parsed.conflictPath, cwd);

  if (!success) {
    console.error("Git merge failed!");
    return false;
  }

  // Delete conflict file
  console.log("Deleting conflict file");
  rmSync(resolve(cwd, parsed.conflictPath));

  console.log("Deconfliction done!");
  console.log();
  return true;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const cwd = process.cwd();
  console.log("Running Syncthing deconflicter");
  console.log(`Watching: ${cwd}`);

  const watcher = watch(".", {
    cwd,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  watcher.on("add", (path) => {
    handleConflict(resolve(cwd, path), cwd).catch((e) => {
      console.error(`Error handling ${path}:`, e.message);
    });
  });

  watcher.on("change", (path) => {
    handleConflict(resolve(cwd, path), cwd).catch((e) => {
      console.error(`Error handling ${path}:`, e.message);
    });
  });

  watcher.on("error", (error) => {
    console.error("Watcher error:", error);
  });

  // Keep process alive
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
