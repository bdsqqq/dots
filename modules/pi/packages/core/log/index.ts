import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createError,
  createLogger,
  initLogger,
  parseError,
  type AuditableLogger,
  type DrainContext,
} from "evlog";
import { createFsDrain } from "evlog/fs";

export type LogDrain = (context: DrainContext) => void | Promise<void>;
export type WideEventOutcome = "success" | "degraded" | "failure" | "skipped";
type Fields = Record<string, unknown>;
const RESERVED_FIELDS = new Set([
  "correlation",
  "environment",
  "level",
  "operation",
  "operationId",
  "outcome",
  "process",
  "schemaVersion",
  "service",
  "startedAt",
  "timestamp",
]);

function unsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function consumerFields(fields: Fields | undefined): Fields {
  const filtered = Object.fromEntries(
    Object.entries(fields ?? {})
      .filter(([key]) => !RESERVED_FIELDS.has(key) && !unsafeObjectKey(key))
      .slice(0, 64),
  );
  return safeMarkerValue(filtered) as Fields;
}

type SharedLogState = {
  initialized: boolean;
  directory?: string;
  drains: Set<LogDrain>;
  pending: Set<Promise<void>>;
  loggerFactory?: typeof createLogger;
  localDrain?: LogDrain;
};

type PendingOperation = {
  version: 1;
  service: string;
  operation: string;
  operationId: string;
  startedAt: string;
  pid: number;
  correlation?: unknown;
};

const STATE = Symbol.for("@bds_pi/log");
const shared = globalThis as unknown as {
  [STATE]?: SharedLogState;
};
const state =
  shared[STATE] ??
  (shared[STATE] = {
    initialized: false,
    drains: new Set(),
    pending: new Set(),
  });

/**
 * stores logs under xdg state rather than any extension's data directory so
 * every pi package shares one queryable stream.
 */
function defaultDirectory(): string {
  const stateHome =
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return resolve(process.env.BDS_PI_LOG_DIR || join(stateHome, "pi", "logs"));
}

function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function markerDirectory(directory: string): string {
  return join(directory, "pending");
}

function markerPath(directory: string, operationId: string): string {
  const digest = createHash("sha256").update(operationId).digest("hex");
  return join(markerDirectory(directory), `${digest}.json`);
}

function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeMarker(directory: string, operationId: string): void {
  const expected = markerPath(directory, operationId);
  if (existsSync(expected)) {
    unlinkSync(expected);
    fsyncPath(markerDirectory(directory));
    return;
  }
  const pending = markerDirectory(directory);
  if (!existsSync(pending)) return;
  for (const name of readdirSync(pending)) {
    const path = join(pending, name);
    try {
      const marker = JSON.parse(readFileSync(path, "utf8")) as PendingOperation;
      if (marker.operationId === operationId) {
        unlinkSync(path);
        fsyncPath(pending);
        return;
      }
    } catch {}
  }
}

function sanitizeString(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-\n]+PRIVATE KEY-----[\s\S]*?-----END [^-\n]+PRIVATE KEY-----/gi,
      "<filtered>",
    )
    .replace(
      /\b(?:sk|rk|ghp|github_pat|glpat|npm|pypi|xox[baprs]|AIza)[-_A-Za-z0-9]{12,}\b/g,
      "<filtered>",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer <filtered>")
    .replace(
      /\b([a-z][a-z0-9+.-]*):\/\/[^\s/:]+:[^\s/@]+@([^\s]+)/gi,
      "$1://<filtered>@$2",
    );
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeString(message).slice(0, 500);
}

function normalizeOperationId(value: string | undefined): string {
  if (value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) return value;
  if (!value) return randomUUID();
  return `op_${createHash("sha256").update(value).digest("hex")}`;
}

type SanitizationBudget = {
  chars: number;
  nodes: number;
  seen: WeakSet<object>;
};

function safeMarkerValue(
  value: unknown,
  key = "",
  budget: SanitizationBudget = {
    chars: 16_000,
    nodes: 256,
    seen: new WeakSet(),
  },
  depth = 0,
): unknown {
  if (budget.nodes-- <= 0 || depth > 6) return "<truncated>";
  const canonicalKey = key.replace(/[-_]/g, "").toLowerCase();
  if (
    /(?:authorization|cookie|password|passwd|secret|token|apikey|privatekey|accesskey)$/.test(
      canonicalKey,
    )
  )
    return "<filtered>";
  if (typeof value === "string") {
    const sanitized = sanitizeString(value);
    const available = Math.max(0, Math.min(1_000, budget.chars));
    budget.chars -= available;
    return sanitized.length > available
      ? `${sanitized.slice(0, available)}<truncated>`
      : sanitized;
  }
  if (Array.isArray(value))
    return value
      .slice(0, 32)
      .map((item) => safeMarkerValue(item, key, budget, depth + 1));
  if (value && typeof value === "object") {
    if (budget.seen.has(value)) return "<circular>";
    budget.seen.add(value);
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .filter(([childKey]) => !unsafeObjectKey(childKey))
        .map(([childKey, child]) => {
          const sanitizedKey = sanitizeString(childKey).slice(0, 128);
          budget.chars -= sanitizedKey.length;
          return [
            budget.chars < 0 || !sanitizedKey
              ? "<truncated-key>"
              : sanitizedKey,
            safeMarkerValue(child, childKey, budget, depth + 1),
          ];
        }),
    );
  }
  return value;
}

function reportFailure(action: string, error: unknown): void {
  console.error(`[bds-pi/log] ${action}: ${safeMessage(error)}`);
}

function track(work: Promise<void>): Promise<void> {
  state.pending.add(work);
  void work.finally(() => state.pending.delete(work));
  return work;
}

async function boundedDrain(
  drain: LogDrain,
  context: DrainContext,
): Promise<void> {
  const timeout = Number(process.env.BDS_PI_LOG_DRAIN_TIMEOUT_MS || 5_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(drain(context)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`drain timed out after ${timeout}ms`)),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function dispatch(context: DrainContext): Promise<void> {
  return track(
    Promise.allSettled(
      [...state.drains].map(async (drain) => {
        try {
          // The local drain serializes durable writes itself. Timing out while
          // it waits for an earlier write would let flushLogs return before
          // the terminal record reaches disk.
          if (drain === state.localDrain) await drain(context);
          else await boundedDrain(drain, context);
        } catch (error) {
          reportFailure("drain failed", error);
        }
      }),
    ).then(() => undefined),
  );
}

function currentLogPath(directory: string): string {
  return join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function secureCurrentLog(directory: string): void {
  secureDirectory(directory);
  const path = currentLogPath(directory);
  if (existsSync(path)) chmodSync(path, 0o600);
}

export type LogRetentionReport = {
  capBytes: number;
  beforeBytes: number;
  afterBytes: number;
  acknowledgedFilesRemoved: number;
  unacknowledgedFilesRemoved: number;
  droppedBytes: number;
};

function acknowledgementDirectory(directory: string): string {
  return join(directory, "acknowledged");
}

function acknowledgementPath(directory: string, name: string): string {
  return join(
    acknowledgementDirectory(directory),
    `${createHash("sha256").update(name).digest("hex")}.ack`,
  );
}

export function acknowledgeLogFile(directory: string, name: string): void {
  if (!/^\d{4}-\d{2}-\d{2}(?:[T._-][A-Za-z0-9._-]+)?\.jsonl$/.test(name))
    throw new Error("invalid acknowledged log name");
  const acknowledged = acknowledgementDirectory(directory);
  secureDirectory(acknowledged);
  const path = acknowledgementPath(directory, name);
  writeFileSync(path, `${name}\n`, { mode: 0o600 });
  fsyncPath(path);
  fsyncPath(acknowledged);
}

function writeTelemetryGap(
  directory: string,
  report: LogRetentionReport,
): void {
  const path = join(directory, "telemetry-gap.json");
  let prior = { droppedFiles: 0, droppedBytes: 0 };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as typeof prior;
    if (
      Number.isSafeInteger(value.droppedFiles) &&
      Number.isSafeInteger(value.droppedBytes)
    )
      prior = value;
  } catch {}
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({
      schemaVersion: 1,
      reason: "local-hard-cap-eviction",
      observedAt: new Date().toISOString(),
      droppedFiles: prior.droppedFiles + report.unacknowledgedFilesRemoved,
      droppedBytes: prior.droppedBytes + report.droppedBytes,
    })}\n`,
    { mode: 0o600 },
  );
  fsyncPath(temporary);
  renameSync(temporary, path);
  fsyncPath(directory);
}

export function enforceLocalLogCap(
  directory: string,
  capBytes: number = Number(
    process.env.BDS_PI_LOG_MAX_BYTES || 128 * 1024 * 1024,
  ),
): LogRetentionReport {
  if (!Number.isSafeInteger(capBytes) || capBytes < 1)
    throw new Error("invalid local log byte cap");
  secureDirectory(directory);
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({
      name,
      path: join(directory, name),
      bytes: statSync(join(directory, name)).size,
      acknowledged: existsSync(acknowledgementPath(directory, name)),
    }));
  const beforeBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const report: LogRetentionReport = {
    capBytes,
    beforeBytes,
    afterBytes: beforeBytes,
    acknowledgedFilesRemoved: 0,
    unacknowledgedFilesRemoved: 0,
    droppedBytes: 0,
  };
  for (const file of files.sort((left, right) => {
    if (left.acknowledged !== right.acknowledged)
      return left.acknowledged ? -1 : 1;
    return left.name.localeCompare(right.name);
  })) {
    if (report.afterBytes <= capBytes) break;
    unlinkSync(file.path);
    report.afterBytes -= file.bytes;
    if (file.acknowledged) {
      report.acknowledgedFilesRemoved += 1;
      unlinkSync(acknowledgementPath(directory, file.name));
    } else {
      report.unacknowledgedFilesRemoved += 1;
      report.droppedBytes += file.bytes;
    }
  }
  if (report.unacknowledgedFilesRemoved > 0)
    writeTelemetryGap(directory, report);
  return report;
}

function appendedEventExists(
  path: string,
  offset: number,
  operationId: string,
): boolean {
  if (!existsSync(path)) return false;
  const size = statSync(path).size;
  if (size <= offset) return false;
  const bytes = Buffer.alloc(size - offset);
  const fd = openSync(path, constants.O_RDONLY);
  try {
    readSync(fd, bytes, 0, bytes.length, offset);
  } finally {
    closeSync(fd);
  }
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.includes(operationId)) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.operationId === operationId) return true;
    } catch {}
  }
  return false;
}

function terminalOperationIds(directory: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(directory)) return ids;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".jsonl")) continue;
    const raw = readFileSync(join(directory, name), "utf8");
    for (const line of raw.split("\n"))
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (typeof event.operationId === "string") ids.add(event.operationId);
      } catch {}
  }
  return ids;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

function claimOwner(name: string): number | undefined {
  const match = name.match(/\.json\.claim-(\d+)-[0-9a-f-]+$/);
  return match?.[1] ? Number(match[1]) : undefined;
}

function claimPath(directory: string, operationId: string): string {
  return `${markerPath(directory, operationId)}.claim-${process.pid}-${randomUUID()}`;
}

/**
 * stale markers are claimed by rename because pi cli and extension processes
 * may discover the same interrupted operation concurrently.
 */
function reconcileInterrupted(directory: string): void {
  const pending = markerDirectory(directory);
  if (!existsSync(pending)) return;
  let names: string[];
  try {
    names = readdirSync(pending);
  } catch (error) {
    reportFailure("cannot inspect interrupted operations", error);
    return;
  }
  names = names.filter((name) =>
    /\.json(?:\.claim-\d+-[0-9a-f-]+)?$/.test(name),
  );
  if (names.length === 0) return;
  let terminalIds: Set<string>;
  try {
    terminalIds = terminalOperationIds(directory);
  } catch (error) {
    reportFailure("cannot index terminal operations", error);
    return;
  }
  for (const name of names) {
    const owner = claimOwner(name);
    if (owner !== undefined && processExists(owner)) continue;
    const source = join(pending, name);
    let claimed: string | undefined;
    try {
      const marker = JSON.parse(
        readFileSync(source, "utf8"),
      ) as PendingOperation;
      if (processExists(marker.pid)) continue;
      claimed = claimPath(directory, marker.operationId);
      renameSync(source, claimed);
      if (terminalIds.has(marker.operationId)) {
        unlinkSync(claimed);
        continue;
      }
      const event = state.loggerFactory!({
        schemaVersion: 1,
        service: marker.service,
        operation: marker.operation,
        operationId: marker.operationId,
        correlation: marker.correlation,
        process: { pid: marker.pid },
        startedAt: marker.startedAt,
        outcome: { status: "interrupted" },
      });
      event.setLevel("warn");
      event.emit({ _forceKeep: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        continue;
      reportFailure("cannot recover interrupted operation", error);
    }
  }
}

function localDrain(directory: string): LogDrain {
  const drain = createFsDrain({ dir: directory, pretty: false });
  let previous = Promise.resolve();
  return (context) => {
    const work = previous.then(async () => {
      const beforePath = currentLogPath(directory);
      const offset = existsSync(beforePath) ? statSync(beforePath).size : 0;
      await drain(context);
      try {
        secureCurrentLog(directory);
        const afterPath = currentLogPath(directory);
        const operationId = context.event.operationId;
        if (
          typeof operationId === "string" &&
          (appendedEventExists(beforePath, offset, operationId) ||
            (afterPath !== beforePath &&
              appendedEventExists(afterPath, 0, operationId)))
        ) {
          fsyncPath(afterPath);
          fsyncPath(directory);
          removeMarker(directory, operationId);
        }
        enforceLocalLogCap(directory);
      } catch (error) {
        reportFailure("cannot secure local logs", error);
      }
    });
    previous = work.catch(() => undefined);
    return work;
  };
}

export function initializeLogs(
  options: {
    directory?: string;
    drain?: LogDrain;
  } = {},
): string {
  if (options.drain) state.drains.add(options.drain);
  if (state.initialized) return state.directory!;

  const directory = resolve(options.directory || defaultDirectory());
  try {
    secureDirectory(directory);
    secureDirectory(markerDirectory(directory));
  } catch (error) {
    reportFailure("cannot initialize local log directory", error);
  }
  state.directory = directory;
  try {
    state.localDrain = localDrain(directory);
    state.drains.add(state.localDrain);
  } catch (error) {
    reportFailure("cannot initialize local log drain", error);
  }
  try {
    initLogger({
      env: { service: "pi", environment: "local" },
      pretty: false,
      silent: true,
      redact: {
        paths: [
          "**.authorization",
          "**.cookie",
          "**.password",
          "**.secret",
          "**.token",
          "**.*_token",
          "**.apiKey",
          "**.api_key",
          "**.client_secret",
          "**.access_key",
          "**.access_token",
          "**.privateKey",
          "**.private_key",
          "**.secret_access_key",
          "**.session_token",
        ],
        patterns: [
          /-----BEGIN [^-\n]+PRIVATE KEY-----[\s\S]*?-----END [^-\n]+PRIVATE KEY-----/gi,
          /\b(?:sk|rk|ghp|github_pat|glpat|npm|pypi|xox[baprs]|AIza)[-_A-Za-z0-9]{12,}\b/g,
          /\bBearer\s+[^\s,;]+/gi,
          /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@[^\s]+/gi,
        ],
      },
      drain: dispatch,
    });
  } catch (error) {
    reportFailure("cannot initialize logger", error);
  }
  state.loggerFactory = createLogger;
  state.initialized = true;
  try {
    reconcileInterrupted(directory);
  } catch (error) {
    reportFailure("cannot reconcile interrupted operations", error);
  }
  return directory;
}

/** adds a drain without replacing the mandatory local filesystem drain. */
export function registerLogDrain(drain: LogDrain): () => void {
  state.drains.add(drain);
  return () => state.drains.delete(drain);
}

/** bounded drains make this safe to await before a short-lived cli exits. */
export async function flushLogs(): Promise<void> {
  const timeout = Number(process.env.BDS_PI_LOG_FLUSH_TIMEOUT_MS || 5_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (state.pending.size > 0)
          await Promise.allSettled([...state.pending]);
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          reportFailure(
            "log flush timed out",
            new Error(`flush timed out after ${timeout}ms`),
          );
          resolve();
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function logDirectory(): string {
  return initializeLogs();
}

export class PiWideEvent {
  readonly id: string;
  readonly #logger: AuditableLogger | undefined;
  readonly #directory: string;
  readonly #marker: string;
  #emitted = false;

  constructor(options: {
    service: string;
    operation: string;
    operationId?: string;
    correlation?: unknown;
    fields?: Fields;
  }) {
    this.id = normalizeOperationId(options.operationId);
    this.#directory = initializeLogs();
    this.#marker = markerPath(this.#directory, this.id);
    const service = sanitizeString(options.service);
    const operation = sanitizeString(options.operation);
    const startedAt = new Date().toISOString();
    let logger: AuditableLogger | undefined;
    try {
      logger = state.loggerFactory!({
        ...consumerFields(options.fields),
        schemaVersion: 1,
        service,
        operation,
        operationId: this.id,
        correlation: safeMarkerValue(options.correlation),
        process: { pid: process.pid },
        startedAt,
      });
    } catch (error) {
      reportFailure("cannot create wide event", error);
    }
    this.#logger = logger;
    try {
      secureDirectory(markerDirectory(this.#directory));
      const marker: PendingOperation = {
        version: 1,
        service,
        operation,
        operationId: this.id,
        startedAt,
        pid: process.pid,
        ...(options.correlation === undefined
          ? {}
          : { correlation: safeMarkerValue(options.correlation) }),
      };
      const fd = openSync(
        this.#marker,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        writeFileSync(fd, `${JSON.stringify(marker)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncPath(markerDirectory(this.#directory));
    } catch (error) {
      reportFailure("cannot persist pending operation", error);
    }
  }

  set(fields: Fields): void {
    try {
      this.#logger?.set(consumerFields(fields));
    } catch (error) {
      reportFailure("cannot enrich wide event", error);
    }
  }

  error(error: unknown, fields: Fields = {}): void {
    try {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.#logger?.error(normalized, consumerFields(fields));
    } catch (logError) {
      reportFailure("cannot attach wide-event error", logError);
    }
  }

  finish(outcome: WideEventOutcome, fields: Fields = {}): void {
    if (this.#emitted) return;
    this.#emitted = true;
    try {
      this.#logger?.set({
        ...consumerFields(fields),
        outcome: { status: outcome },
      });
      if (outcome === "degraded") this.#logger?.setLevel("warn");
      if (outcome === "failure") this.#logger?.setLevel("error");
      this.#logger?.emit({ _forceKeep: true });
    } catch (error) {
      reportFailure("cannot emit wide event", error);
    }
  }
}

/**
 * creates one accumulated event for a logical operation. unfinished events
 * leave private markers that the next pi process reports as interrupted.
 */
export function createWideEvent(options: {
  service: string;
  operation: string;
  operationId?: string;
  correlation?: unknown;
  fields?: Fields;
}): PiWideEvent {
  return new PiWideEvent(options);
}

export { createError, parseError };

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  describe("local telemetry retention", () => {
    it("evicts acknowledged rotations first and records forced telemetry gaps", () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-log-retention-"));
      writeFileSync(join(directory, "2026-09-01.jsonl"), "12345678");
      writeFileSync(join(directory, "2026-09-02.jsonl"), "12345678");
      writeFileSync(join(directory, "2026-09-03.jsonl"), "12345678");
      acknowledgeLogFile(directory, "2026-09-01.jsonl");
      const report = enforceLocalLogCap(directory, 12);
      expect(report).toMatchObject({
        beforeBytes: 24,
        afterBytes: 8,
        acknowledgedFilesRemoved: 1,
        unacknowledgedFilesRemoved: 1,
        droppedBytes: 8,
      });
      expect(existsSync(join(directory, "2026-09-01.jsonl"))).toBe(false);
      expect(existsSync(join(directory, "2026-09-02.jsonl"))).toBe(false);
      expect(existsSync(join(directory, "2026-09-03.jsonl"))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(directory, "telemetry-gap.json"), "utf8")),
      ).toMatchObject({
        reason: "local-hard-cap-eviction",
        droppedFiles: 1,
        droppedBytes: 8,
      });
    });
  });
}
