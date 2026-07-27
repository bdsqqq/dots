import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import type { MemoryConfig } from "./catalog.js";

export const MAINTENANCE_EVENT_KINDS = [
  "checkpoint-ready",
  "corpus-changed",
  "history-fast-forward",
  "manual",
] as const;
export type MaintenanceEventKind = (typeof MAINTENANCE_EVENT_KINDS)[number];
export type MaintenanceEventStatus =
  | "pending"
  | "processing"
  | "done"
  | "failed";
export interface EventBasis {
  [key: string]: JsonValue;
}
type JsonValue = null | boolean | number | string | JsonValue[] | EventBasis;

export type MaintenanceEvent = {
  version: 1;
  id: string;
  kind: MaintenanceEventKind;
  cause: string;
  basis: EventBasis;
  createdAt: string;
  attempt: number;
  ownerPid?: number;
  ownerIdentity?: string;
  claimedAt?: string;
  claimToken?: string;
};

export type MaintenanceEventRecord = {
  status: MaintenanceEventStatus;
  event: MaintenanceEvent;
};

type EventConfig = Pick<MemoryConfig, "data">;
type Clock = () => string;
const STATUSES: MaintenanceEventStatus[] = [
  "pending",
  "processing",
  "done",
  "failed",
];
const EVENT_ID = /^event_[0-9a-f]{64}$/;
const LOCK_STALE_MS = 5 * 60_000;
const CLAIM_LEASE_MS = 5 * 60_000;
const now: Clock = () => new Date().toISOString();

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return object(value) && Object.values(value).every(isJson);
}

function timestamp(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(`invalid maintenance event ${name}`);
  return value;
}

function eventId(
  kind: MaintenanceEventKind,
  cause: string,
  basis: EventBasis,
): string {
  return `event_${createHash("sha256")
    .update(canonical({ kind, cause, basis }))
    .digest("hex")}`;
}

function eventRoot(cfg: EventConfig): string {
  return join(cfg.data, "v2/events");
}

function eventPath(
  cfg: EventConfig,
  status: MaintenanceEventStatus,
  id: string,
): string {
  if (!EVENT_ID.test(id)) throw new Error("invalid maintenance event id");
  return join(eventRoot(cfg), status, `${id}.json`);
}

function ensureDurableDirectory(path: string): void {
  if (existsSync(path)) return;
  const parent = dirname(path);
  if (parent !== path) ensureDurableDirectory(parent);
  mkdirSync(path, { mode: 0o700 });
  fsyncDirectory(parent);
}

function ensureQueue(cfg: EventConfig): void {
  ensureDurableDirectory(eventRoot(cfg));
  for (const status of STATUSES) {
    const directory = join(eventRoot(cfg), status);
    ensureDurableDirectory(directory);
    chmodSync(directory, 0o700);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function processIdentity(pid: number): string | undefined {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const started = result.status === 0 ? result.stdout.trim() : "";
  return started ? `${pid}:${started}` : undefined;
}

function moveSync(source: string, target: string): void {
  renameSync(source, target);
  fsyncDirectory(dirname(source));
  if (dirname(target) !== dirname(source)) fsyncDirectory(dirname(target));
}

function withQueueLock<T>(
  cfg: EventConfig,
  fn: (assertOwned: () => void) => T,
): T {
  ensureQueue(cfg);
  const path = join(eventRoot(cfg), ".lock");
  const token = randomUUID();
  const tokenPath = join(path, "token");
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(eventRoot(cfg));
      const fd = openSync(
        tokenPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            identity: processIdentity(process.pid),
            token,
          }),
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let active = false;
      try {
        const owner = JSON.parse(readFileSync(join(path, "token"), "utf8")) as {
          pid?: number;
          identity?: string;
        };
        active =
          typeof owner.pid === "number" &&
          typeof owner.identity === "string" &&
          processIdentity(owner.pid) === owner.identity;
      } catch {}
      if (active || Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS)
        throw new Error("maintenance event queue is busy");
      const stale = `${path}.stale.${process.pid}.${Date.now()}`;
      try {
        moveSync(path, stale);
        const staleToken = join(stale, "token");
        if (existsSync(staleToken)) unlinkSync(staleToken);
        fsyncDirectory(stale);
        rmdirSync(stale);
        fsyncDirectory(eventRoot(cfg));
      } catch (reclaimError) {
        if (
          (reclaimError as NodeJS.ErrnoException).code !== "ENOENT" ||
          attempt >= 2
        )
          throw reclaimError;
      }
    }
  }
  const assertOwned = (): void => {
    let current: { token?: string } = {};
    try {
      current = JSON.parse(readFileSync(tokenPath, "utf8"));
    } catch {}
    if (current.token !== token)
      throw new Error("maintenance event queue lock was reclaimed");
  };
  try {
    assertOwned();
    return fn(assertOwned);
  } finally {
    let owned = false;
    try {
      owned =
        (JSON.parse(readFileSync(tokenPath, "utf8")) as { token?: string })
          .token === token;
    } catch {}
    if (owned) {
      unlinkSync(tokenPath);
      fsyncDirectory(path);
      rmdirSync(path);
      fsyncDirectory(eventRoot(cfg));
    }
  }
}

function serialize(event: MaintenanceEvent): string {
  return `${JSON.stringify(event, null, 2)}\n`;
}

function atomicReplace(path: string, event: MaintenanceEvent): void {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, serialize(event));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    moveSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function exclusivePublish(path: string, event: MaintenanceEvent): boolean {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, serialize(event));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
    fsyncDirectory(dirname(path));
    chmodSync(path, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(temporary);
  }
}

export function parseMaintenanceEvent(raw: string): MaintenanceEvent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid maintenance event json");
  }
  if (!object(value)) throw new Error("invalid maintenance event");
  const baseFields = [
    "attempt",
    "basis",
    "cause",
    "createdAt",
    "id",
    "kind",
    "version",
  ].sort();
  const fields = Object.keys(value).sort();
  const claimedFields = [
    ...baseFields,
    "claimedAt",
    "claimToken",
    "ownerIdentity",
    "ownerPid",
  ].sort();
  if (
    fields.join(",") !== baseFields.join(",") &&
    fields.join(",") !== claimedFields.join(",")
  )
    throw new Error("invalid maintenance event fields");
  if (value.version !== 1) throw new Error("invalid maintenance event version");
  if (
    typeof value.kind !== "string" ||
    !MAINTENANCE_EVENT_KINDS.includes(value.kind as MaintenanceEventKind)
  )
    throw new Error("invalid maintenance event kind");
  if (
    typeof value.cause !== "string" ||
    !value.cause.trim() ||
    value.cause !== value.cause.trim() ||
    value.cause.length > 1024 ||
    /[\r\n]/.test(value.cause)
  )
    throw new Error("invalid maintenance event cause");
  if (!object(value.basis) || !isJson(value.basis))
    throw new Error("invalid maintenance event basis");
  if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 0)
    throw new Error("invalid maintenance event attempt");
  timestamp(value.createdAt, "createdAt");
  if (typeof value.id !== "string" || !EVENT_ID.test(value.id))
    throw new Error("invalid maintenance event id");
  const kind = value.kind as MaintenanceEventKind;
  const basis = value.basis as EventBasis;
  if (value.id !== eventId(kind, value.cause, basis))
    throw new Error("invalid maintenance event id hash");
  if (fields.includes("ownerPid")) {
    if (!Number.isSafeInteger(value.ownerPid) || Number(value.ownerPid) < 1)
      throw new Error("invalid maintenance event ownerPid");
    timestamp(value.claimedAt, "claimedAt");
    if (
      typeof value.claimToken !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.claimToken)
    )
      throw new Error("invalid maintenance event claimToken");
    if (typeof value.ownerIdentity !== "string" || !value.ownerIdentity)
      throw new Error("invalid maintenance event ownerIdentity");
  }
  return value as MaintenanceEvent;
}

export function enqueueMaintenanceEvent(
  cfg: EventConfig,
  input: { kind: MaintenanceEventKind; cause: string; basis: EventBasis },
  clock: Clock = now,
): MaintenanceEvent {
  if (!MAINTENANCE_EVENT_KINDS.includes(input.kind))
    throw new Error("invalid maintenance event kind");
  const createdAt = clock();
  const event = parseMaintenanceEvent(
    JSON.stringify({
      version: 1,
      id: eventId(input.kind, input.cause, input.basis),
      kind: input.kind,
      cause: input.cause,
      basis: input.basis,
      createdAt,
      attempt: 0,
    }),
  );
  return withQueueLock(cfg, (assertOwned) => {
    for (const status of STATUSES) {
      const existing = eventPath(cfg, status, event.id);
      if (existsSync(existing))
        return parseMaintenanceEvent(readFileSync(existing, "utf8"));
    }
    const path = eventPath(cfg, "pending", event.id);
    assertOwned();
    if (!exclusivePublish(path, event))
      return parseMaintenanceEvent(readFileSync(path, "utf8"));
    return event;
  });
}

export function listMaintenanceEvents(
  cfg: EventConfig,
  statuses: MaintenanceEventStatus[] = STATUSES,
): MaintenanceEventRecord[] {
  ensureQueue(cfg);
  return statuses
    .flatMap((status) => {
      const directory = join(eventRoot(cfg), status);
      return readdirSync(directory)
        .filter((name) => EVENT_ID.test(name.replace(/\.json$/, "")))
        .filter((name) => name.endsWith(".json"))
        .map((name) => ({
          status,
          event: parseMaintenanceEvent(
            readFileSync(join(directory, name), "utf8"),
          ),
        }));
    })
    .sort(
      (left, right) =>
        left.event.id.localeCompare(right.event.id) ||
        STATUSES.indexOf(left.status) - STATUSES.indexOf(right.status),
    );
}

export function claimMaintenanceEvent(
  cfg: EventConfig,
  options: {
    ownerPid?: number;
    clock?: Clock;
    kinds?: MaintenanceEventKind[];
    ids?: string[];
  } = {},
): MaintenanceEvent | null {
  return withQueueLock(cfg, (assertOwned) => {
    const pending = listMaintenanceEvents(cfg, ["pending"]).find(
      ({ event }) => !options.kinds || options.kinds.includes(event.kind),
    );
    const selected =
      pending && (!options.ids || options.ids.includes(pending.event.id))
        ? pending
        : listMaintenanceEvents(cfg, ["pending"]).find(
            ({ event }) =>
              (!options.kinds || options.kinds.includes(event.kind)) &&
              (!options.ids || options.ids.includes(event.id)),
          );
    if (!selected) return null;
    const source = eventPath(cfg, "pending", selected.event.id);
    const target = eventPath(cfg, "processing", selected.event.id);
    const claimed = {
      ...selected.event,
      attempt: selected.event.attempt + 1,
      ownerPid: options.ownerPid ?? process.pid,
      ownerIdentity:
        processIdentity(options.ownerPid ?? process.pid) ??
        `unresolved:${options.ownerPid ?? process.pid}`,
      claimedAt: (options.clock ?? now)(),
      claimToken: randomUUID(),
    };
    const parsed = parseMaintenanceEvent(JSON.stringify(claimed));
    assertOwned();
    atomicReplace(source, parsed);
    moveSync(source, target);
    return parsed;
  });
}

export function recoverMaintenanceEvents(
  cfg: EventConfig,
  options: { clock?: Clock; leaseMs?: number } = {},
): MaintenanceEvent[] {
  return withQueueLock(cfg, (assertOwned) => {
    const recovered: MaintenanceEvent[] = [];
    for (const record of listMaintenanceEvents(cfg, ["processing"])) {
      const claimedAt = record.event.claimedAt
        ? new Date(record.event.claimedAt).getTime()
        : 0;
      const current = new Date((options.clock ?? now)()).getTime();
      if (
        (record.event.ownerPid &&
          record.event.ownerIdentity &&
          processIdentity(record.event.ownerPid) ===
            record.event.ownerIdentity) ||
        current - claimedAt <= (options.leaseMs ?? CLAIM_LEASE_MS)
      )
        continue;
      const processing = eventPath(cfg, "processing", record.event.id);
      const pending = eventPath(cfg, "pending", record.event.id);
      const {
        ownerPid: _ownerPid,
        ownerIdentity: _ownerIdentity,
        claimedAt: _claimedAt,
        claimToken: _claimToken,
        ...event
      } = record.event;
      assertOwned();
      atomicReplace(processing, event);
      moveSync(processing, pending);
      recovered.push(event);
    }
    return recovered;
  });
}

export function completeMaintenanceEvent(
  cfg: EventConfig,
  id: string,
  claimToken: string,
): MaintenanceEvent {
  return withQueueLock(cfg, (assertOwned) => {
    const source = eventPath(cfg, "processing", id);
    const event = parseMaintenanceEvent(readFileSync(source, "utf8"));
    if (event.claimToken !== claimToken)
      throw new Error("maintenance event owner mismatch");
    assertOwned();
    moveSync(source, eventPath(cfg, "done", id));
    return event;
  });
}

export function failMaintenanceEvent(
  cfg: EventConfig,
  id: string,
  claimToken: string,
): MaintenanceEvent {
  return withQueueLock(cfg, (assertOwned) => {
    const source = eventPath(cfg, "processing", id);
    const event = parseMaintenanceEvent(readFileSync(source, "utf8"));
    if (event.claimToken !== claimToken)
      throw new Error("maintenance event owner mismatch");
    assertOwned();
    moveSync(source, eventPath(cfg, "failed", id));
    return event;
  });
}

export function retryMaintenanceEvent(
  cfg: EventConfig,
  id: string,
  claimToken: string,
): MaintenanceEvent {
  return withQueueLock(cfg, (assertOwned) => {
    const source = eventPath(cfg, "processing", id);
    const claimed = parseMaintenanceEvent(readFileSync(source, "utf8"));
    if (claimed.claimToken !== claimToken)
      throw new Error("maintenance event owner mismatch");
    const {
      ownerPid: _ownerPid,
      ownerIdentity: _ownerIdentity,
      claimedAt: _claimedAt,
      claimToken: _claimToken,
      ...event
    } = claimed;
    assertOwned();
    atomicReplace(source, event);
    moveSync(source, eventPath(cfg, "pending", id));
    return event;
  });
}
