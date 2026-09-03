import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { compareCodeUnits } from "../money.ts";
import type { IngestLedgerStore } from "./ingest.ts";
import {
  EvidenceRefV1Schema,
  QuarantineEntryV1Schema,
  TransactionV1Schema,
  TransferLinkV1Schema,
  emptyLedgerSnapshot,
  validateLedgerSnapshot,
  type EvidenceRefV1,
  type LedgerSnapshotV1,
  type QuarantineEntryV1,
  type TransactionV1,
  type TransferLinkV1,
} from "./state.ts";

const DEFAULT_MAX_LEDGER_BYTES = 16 * 1024 * 1024;

export type LedgerStoreFailureReason =
  | "unreadable"
  | "corrupt"
  | "future-version"
  | "uncommittable";

export class JsonlLedgerStoreError extends Error {
  readonly ledgerUnavailableReason: LedgerStoreFailureReason;

  constructor(reason: LedgerStoreFailureReason) {
    super("ledger storage operation failed");
    this.ledgerUnavailableReason = reason;
  }
}

export interface JsonlLedgerStoreOptions {
  readonly rootPath: string;
  readonly maxLedgerBytes?: number;
  readonly lockAttempts?: number;
  readonly lockDelayMs?: number;
}

type StoredRecord = EvidenceRefV1 | TransactionV1 | TransferLinkV1 | QuarantineEntryV1;

function mode(value: number | bigint): number {
  return Number(value) & 0o777;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function recordKey(record: StoredRecord): string {
  return `${record.kind}\0${record.id}`;
}

export function encodeCanonicalJsonl(snapshot: LedgerSnapshotV1): Buffer {
  validateLedgerSnapshot(snapshot);
  const records: StoredRecord[] = [
    ...snapshot.evidence,
    ...snapshot.transactions,
    ...snapshot.transferLinks,
    ...snapshot.quarantine,
  ];
  records.sort((left, right) => compareCodeUnits(recordKey(left), recordKey(right)));
  const text = records.map((record) => JSON.stringify(stableValue(record))).join("\n");
  return Buffer.from(text.length === 0 ? "" : `${text}\n`, "utf8");
}

function assertReferentialIntegrity(snapshot: LedgerSnapshotV1): void {
  const evidence = new Set(snapshot.evidence.map((entry) => entry.id));
  const transactions = new Set(snapshot.transactions.map((entry) => entry.id));
  for (const transaction of snapshot.transactions) {
    if (transaction.evidenceIds.some((id) => !evidence.has(id))) {
      throw new JsonlLedgerStoreError("corrupt");
    }
    if (transaction.classification.evidenceIds.some((id) => !evidence.has(id))) {
      throw new JsonlLedgerStoreError("corrupt");
    }
  }
  for (const link of snapshot.transferLinks) {
    if (
      !transactions.has(link.outgoingTransactionId) ||
      !transactions.has(link.incomingTransactionId)
    ) {
      throw new JsonlLedgerStoreError("corrupt");
    }
  }
}

function decodeRecord(value: unknown): StoredRecord {
  if (typeof value !== "object" || value === null) {
    throw new JsonlLedgerStoreError("corrupt");
  }
  const candidate = value as { kind?: unknown; version?: unknown };
  if (typeof candidate.version === "number" && candidate.version > 1) {
    throw new JsonlLedgerStoreError("future-version");
  }
  try {
    switch (candidate.kind) {
      case "company-money.evidence-ref":
        return EvidenceRefV1Schema.assert(value);
      case "company-money.transaction":
        return TransactionV1Schema.assert(value);
      case "company-money.transfer-link":
        return TransferLinkV1Schema.assert(value);
      case "company-money.quarantine-entry":
        return QuarantineEntryV1Schema.assert(value);
      default:
        throw new JsonlLedgerStoreError("corrupt");
    }
  } catch (error) {
    if (error instanceof JsonlLedgerStoreError) throw error;
    throw new JsonlLedgerStoreError("corrupt");
  }
}

export function decodeCanonicalJsonl(bytes: Buffer): LedgerSnapshotV1 {
  if (bytes.includes(0)) throw new JsonlLedgerStoreError("corrupt");
  const text = bytes.toString("utf8");
  if (text.length > 0 && !text.endsWith("\n")) {
    throw new JsonlLedgerStoreError("corrupt");
  }
  const records: StoredRecord[] = [];
  try {
    for (const line of text.split("\n").filter((entry) => entry.length > 0)) {
      records.push(decodeRecord(JSON.parse(line)));
    }
  } catch (error) {
    if (error instanceof JsonlLedgerStoreError) throw error;
    throw new JsonlLedgerStoreError("corrupt");
  }
  const keys = records.map(recordKey);
  if (new Set(keys).size !== keys.length) throw new JsonlLedgerStoreError("corrupt");
  const snapshot: LedgerSnapshotV1 = {
    kind: "company-money.ledger-snapshot",
    version: 1,
    evidence: records.filter(
      (entry): entry is EvidenceRefV1 => entry.kind === "company-money.evidence-ref",
    ),
    transactions: records.filter(
      (entry): entry is TransactionV1 => entry.kind === "company-money.transaction",
    ),
    transferLinks: records.filter(
      (entry): entry is TransferLinkV1 => entry.kind === "company-money.transfer-link",
    ),
    quarantine: records.filter(
      (entry): entry is QuarantineEntryV1 =>
        entry.kind === "company-money.quarantine-entry",
    ),
  };
  validateLedgerSnapshot(snapshot);
  assertReferentialIntegrity(snapshot);
  if (!encodeCanonicalJsonl(snapshot).equals(bytes)) {
    throw new JsonlLedgerStoreError("corrupt");
  }
  return snapshot;
}

async function pathKind(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertDirectory(path: string): Promise<void> {
  const info = await pathKind(path);
  if (!info || info.isSymbolicLink() || !info.isDirectory() || mode(info.mode) !== 0o700) {
    throw new JsonlLedgerStoreError("unreadable");
  }
}

async function assertNoGitAncestor(path: string): Promise<void> {
  let current = resolve(path);
  const root = parse(current).root;
  while (true) {
    if (await pathKind(join(current, ".git"))) {
      throw new JsonlLedgerStoreError("uncommittable");
    }
    if (current === root) return;
    current = dirname(current);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertDirectory(path);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export class JsonlLedgerStore implements IngestLedgerStore {
  readonly rootPath: string;
  readonly ledgerPath: string;
  readonly statePath: string;
  readonly exportsPath: string;
  readonly lockPath: string;
  readonly maxLedgerBytes: number;
  readonly lockAttempts: number;
  readonly lockDelayMs: number;

  constructor(options: JsonlLedgerStoreOptions) {
    this.rootPath = resolve(options.rootPath);
    this.ledgerPath = join(this.rootPath, "ledger.jsonl");
    this.statePath = join(this.rootPath, "state");
    this.exportsPath = join(this.rootPath, "exports");
    this.lockPath = join(this.statePath, "ledger.lock");
    this.maxLedgerBytes = options.maxLedgerBytes ?? DEFAULT_MAX_LEDGER_BYTES;
    this.lockAttempts = options.lockAttempts ?? 20;
    this.lockDelayMs = options.lockDelayMs ?? 25;
  }

  async read(): Promise<{ revision: string | null; snapshot: LedgerSnapshotV1 }> {
    const root = await pathKind(this.rootPath);
    if (!root) return { revision: null, snapshot: emptyLedgerSnapshot() };
    await assertDirectory(this.rootPath);
    const info = await pathKind(this.ledgerPath);
    if (!info) return { revision: null, snapshot: emptyLedgerSnapshot() };
    if (info.isSymbolicLink() || !info.isFile() || mode(info.mode) !== 0o600) {
      throw new JsonlLedgerStoreError("unreadable");
    }
    if (info.size > this.maxLedgerBytes) throw new JsonlLedgerStoreError("unreadable");
    let bytes: Buffer;
    try {
      const handle = await open(
        this.ledgerPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        bytes = await readFile(handle);
      } finally {
        await handle.close();
      }
    } catch {
      throw new JsonlLedgerStoreError("unreadable");
    }
    if (bytes.length > this.maxLedgerBytes) throw new JsonlLedgerStoreError("unreadable");
    return { revision: digest(bytes), snapshot: decodeCanonicalJsonl(bytes) };
  }

  private async acquireLock() {
    for (let attempt = 0; attempt < this.lockAttempts; attempt += 1) {
      try {
        const handle = await open(
          this.lockPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await handle.sync();
        return handle;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt + 1 < this.lockAttempts) await sleep(this.lockDelayMs);
      }
    }
    return null;
  }

  async compareAndSwap(
    expectedRevision: string | null,
    next: LedgerSnapshotV1,
  ): Promise<"committed" | "conflict"> {
    let bytes: Buffer;
    try {
      bytes = encodeCanonicalJsonl(next);
      if (bytes.length > this.maxLedgerBytes) {
        throw new JsonlLedgerStoreError("uncommittable");
      }
      await assertNoGitAncestor(this.rootPath);
      await assertDirectory(this.rootPath);
      await ensurePrivateDirectory(this.statePath);
      await ensurePrivateDirectory(this.exportsPath);
    } catch (error) {
      if (error instanceof JsonlLedgerStoreError) throw error;
      throw new JsonlLedgerStoreError("uncommittable");
    }
    const lock = await this.acquireLock();
    if (!lock) return "conflict";
    const temporaryPath = join(
      this.rootPath,
      `.ledger.jsonl.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let temporaryCreated = false;
    try {
      const current = await this.read();
      if (current.revision !== expectedRevision) return "conflict";
      const temporary = await open(
        temporaryPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      temporaryCreated = true;
      try {
        await temporary.writeFile(bytes);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await rename(temporaryPath, this.ledgerPath);
      temporaryCreated = false;
      const directory = await open(this.rootPath, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return "committed";
    } catch (error) {
      if (error instanceof JsonlLedgerStoreError) throw error;
      throw new JsonlLedgerStoreError("uncommittable");
    } finally {
      await lock.close().catch(() => undefined);
      if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined);
      await rm(this.lockPath, { force: true }).catch(() => undefined);
    }
  }
}
