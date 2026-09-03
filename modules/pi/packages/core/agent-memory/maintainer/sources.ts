import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { MemoryConfig } from "../catalog.js";
import {
  parseTurnReceiptObservation,
  TURN_RECEIPT_ENTRY_TYPE,
  validateTurnReceiptBinding,
} from "../receipt.js";
import {
  canonicalJson,
  durableCreate,
  durableWrite,
  isJsonValue,
  object,
  safeRelativePath,
  sha256,
  timestamp,
  type JsonValue,
  v3Data,
} from "./common.js";
import {
  RESOURCE_LIMITS,
  sourcePathRejected,
  type SourceKind,
  type SourcePolicy,
} from "./policy.js";
import { type ArtifactRef, type WorkflowFailure } from "./workflows.js";

export type SourceRevision = {
  device: string;
  inode: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
};

export type SourceEntry = {
  schemaVersion: 3;
  sourceId: string;
  id: string;
  parentId: string | null;
  type: string;
  customType?: string;
  sequence: number;
  rawSha256: string;
  rawArtifact: ArtifactRef;
  visible?: { role: "user" | "assistant"; text: string };
  message?: JsonValue;
  data?: JsonValue;
  name?: string;
};

export type SourceRecord = {
  schemaVersion: 3;
  sourceId: string;
  identity: {
    rootId: string;
    relativePath: string;
    kind: SourceKind;
    policyVersion: number;
  };
  session: { id: string; workspace: string };
  revision: SourceRevision;
  accepted: {
    byteCursor: number;
    completeLineCount: number;
    prefixDigest: string;
    boundaryProof: { start: number; length: number; sha256: string };
    entryFrontier: string | null;
    graphManifest: ArtifactRef;
  };
  projection: {
    sourceRevisionDigest: string;
    markdownSha256: string;
    stablePath: string;
    leafManifest: ArtifactRef;
    checkpointFrontier: ArtifactRef;
  };
  state:
    | { type: "active" }
    | { type: "missing"; firstObservedAt: string; expiresAt: string }
    | { type: "quarantined"; error: WorkflowFailure; reviewAfter: string };
};

export type SourceMetrics = {
  mode: "unchanged" | "append" | "fallback" | "missing" | "quarantined";
  bytesStatted: number;
  bytesRead: number;
  recordsParsed: number;
  filesOpened: number;
  filesCreated: number;
  filesReused: number;
  filesReplaced: number;
  wholePrefixValidated: boolean;
};

export type SourceContinuation = {
  version: 1;
  sourceId: string;
  sourceRevisionDigest: string;
  priorRecordSha256: string | null;
  mode: "append" | "fallback";
  candidateId: string;
  nextByte: number;
  nextLine: number;
  nextEntrySequence: number;
  completeLineCount: number;
  prefixDigest: string;
  boundaryTail: ArtifactRef;
  session: SourceRecord["session"] | null;
};

export type SourceCrashPoint =
  | "after-input-validation"
  | "after-entry-indexes"
  | "after-derived-artifacts"
  | "after-projection"
  | "after-source-record";

export type ReconcileSourceOutcome =
  | { type: "unchanged"; record: SourceRecord; metrics: SourceMetrics }
  | { type: "accepted"; record: SourceRecord; metrics: SourceMetrics }
  | {
      type: "suspended";
      continuation: SourceContinuation;
      metrics: SourceMetrics;
    }
  | { type: "missing"; record?: SourceRecord; metrics: SourceMetrics }
  | { type: "quarantined"; record: SourceRecord; metrics: SourceMetrics };

export interface SourceIO {
  stat(path: string): SourceRevision | undefined;
  read(path: string, start: number, length: number): Buffer;
}

const nativeSourceIO: SourceIO = {
  stat(path) {
    const info = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (!info?.isFile()) return undefined;
    return {
      device: String(info.dev),
      inode: String(info.ino),
      size: Number(info.size),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs),
    };
  },
  read(path, start, length) {
    const descriptor = openSync(path, constants.O_RDONLY);
    try {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const count = readSync(
          descriptor,
          buffer,
          offset,
          length - offset,
          start + offset,
        );
        if (count === 0) break;
        offset += count;
      }
      return buffer.subarray(0, offset);
    } finally {
      closeSync(descriptor);
    }
  },
};

type SourceRoot = Pick<MemoryConfig, "data">;
const sourceRecordPath = (cfg: SourceRoot, sourceId: string): string =>
  v3Data(cfg, "sources/records", sourceId.slice(0, 2), `${sourceId}.json`);
const artifactPath = (cfg: SourceRoot, digest: string): string =>
  v3Data(cfg, "artifacts/sha256", digest.slice(0, 2), digest);
const entryPath = (
  cfg: SourceRoot,
  sourceId: string,
  entryId: string,
): string => {
  const digest = sha256(entryId);
  return v3Data(
    cfg,
    "sources/entries",
    sourceId,
    digest.slice(0, 2),
    `${digest}.json`,
  );
};
const candidateEntryPath = (
  cfg: SourceRoot,
  candidateId: string,
  sequence: number,
): string =>
  v3Data(
    cfg,
    "sources/candidates",
    candidateId,
    "entries",
    `${String(sequence).padStart(12, "0")}.json`,
  );
const candidateIdPath = (
  cfg: SourceRoot,
  candidateId: string,
  entryId: string,
): string =>
  v3Data(
    cfg,
    "sources/candidates",
    candidateId,
    "ids",
    sha256(entryId).slice(0, 2),
    `${sha256(entryId)}.json`,
  );

class InjectedSourceCrash extends Error {}

function injectCrash(
  fault: ((point: SourceCrashPoint) => void) | undefined,
  point: SourceCrashPoint,
): void {
  if (!fault) return;
  try {
    fault(point);
  } catch (error) {
    throw new InjectedSourceCrash(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function sourceId(policy: SourcePolicy, relativePath: string): string {
  safeRelativePath(relativePath);
  return `src_${sha256(
    canonicalJson({
      rootId: policy.rootId,
      relativePath,
      kind: policy.kind,
      policyVersion: policy.version,
    }),
  ).slice(0, 32)}`;
}

function sourceRevision(value: unknown): SourceRevision {
  if (
    !object(value) ||
    typeof value.device !== "string" ||
    typeof value.inode !== "string" ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0 ||
    typeof value.mtimeNs !== "string" ||
    typeof value.ctimeNs !== "string"
  )
    throw new Error("invalid source revision");
  return value as SourceRevision;
}

function artifactRef(value: unknown): ArtifactRef {
  if (
    !object(value) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 0
  )
    throw new Error("invalid source artifact ref");
  safeRelativePath(value.relativePath);
  return value as ArtifactRef;
}

export function parseSourceRecord(value: unknown): SourceRecord {
  if (
    !object(value) ||
    value.schemaVersion !== 3 ||
    typeof value.sourceId !== "string" ||
    !/^src_[a-f0-9]{32}$/.test(value.sourceId) ||
    !object(value.identity) ||
    typeof value.identity.rootId !== "string" ||
    typeof value.identity.kind !== "string" ||
    ![
      "pi-session-jsonl",
      "amp-session-jsonl",
      "memory-markdown",
      "skill-artifact",
    ].includes(value.identity.kind) ||
    !Number.isSafeInteger(value.identity.policyVersion) ||
    Number(value.identity.policyVersion) < 1 ||
    !object(value.session) ||
    typeof value.session.id !== "string" ||
    typeof value.session.workspace !== "string" ||
    !object(value.accepted) ||
    !Number.isSafeInteger(value.accepted.byteCursor) ||
    Number(value.accepted.byteCursor) < 0 ||
    !Number.isSafeInteger(value.accepted.completeLineCount) ||
    Number(value.accepted.completeLineCount) < 1 ||
    typeof value.accepted.prefixDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.accepted.prefixDigest) ||
    !object(value.accepted.boundaryProof) ||
    !Number.isSafeInteger(value.accepted.boundaryProof.start) ||
    !Number.isSafeInteger(value.accepted.boundaryProof.length) ||
    typeof value.accepted.boundaryProof.sha256 !== "string" ||
    (value.accepted.entryFrontier !== null &&
      typeof value.accepted.entryFrontier !== "string") ||
    !object(value.projection) ||
    typeof value.projection.sourceRevisionDigest !== "string" ||
    typeof value.projection.markdownSha256 !== "string" ||
    typeof value.projection.stablePath !== "string" ||
    !object(value.state) ||
    typeof value.state.type !== "string"
  )
    throw new Error("invalid source record");
  safeRelativePath(value.identity.relativePath);
  sourceRevision(value.revision);
  artifactRef(value.accepted.graphManifest);
  artifactRef(value.projection.leafManifest);
  artifactRef(value.projection.checkpointFrontier);
  if (value.state.type === "missing") {
    timestamp(value.state.firstObservedAt, "source missing firstObservedAt");
    timestamp(value.state.expiresAt, "source missing expiresAt");
  } else if (value.state.type === "quarantined") {
    timestamp(value.state.reviewAfter, "source reviewAfter");
    if (!object(value.state.error)) throw new Error("invalid source error");
  } else if (value.state.type !== "active")
    throw new Error("invalid source state");
  return value as SourceRecord;
}

export function loadSourceRecord(
  cfg: SourceRoot,
  id: string,
): SourceRecord | undefined {
  const path = sourceRecordPath(cfg, id);
  if (!existsSync(path)) return undefined;
  return parseSourceRecord(JSON.parse(readFileSync(path, "utf8")));
}

function persistArtifact(
  cfg: SourceRoot,
  value: string | Buffer,
  metrics: SourceMetrics,
): ArtifactRef {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const digest = sha256(bytes);
  const path = artifactPath(cfg, digest);
  if (durableCreate(path, bytes)) metrics.filesCreated += 1;
  else {
    metrics.filesReused += 1;
    if (sha256(readFileSync(path)) !== digest)
      throw new Error("source artifact collision");
  }
  return {
    sha256: digest,
    relativePath: relative(v3Data(cfg), path),
    bytes: bytes.length,
  };
}

function readArtifact(cfg: SourceRoot, artifact: ArtifactRef): Buffer {
  const value = readFileSync(v3Data(cfg, artifact.relativePath));
  if (value.length !== artifact.bytes || sha256(value) !== artifact.sha256)
    throw new Error("source artifact binding changed");
  return value;
}

function visibleMessage(
  record: Record<string, unknown>,
): SourceEntry["visible"] {
  if (record.type !== "message" || !object(record.message)) return undefined;
  const role = record.message.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const content = record.message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(object)
            .filter(
              (part) => part.type === "text" && typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("\n")
        : "";
  if (!text.trim()) return undefined;
  return { role, text: text.trim() };
}

function parseLine(
  raw: Buffer,
  lineNumber: number,
  source: string,
): Record<string, unknown> {
  if (raw.length > RESOURCE_LIMITS.maxRecordBytes)
    throw new Error(`source record ${lineNumber} exceeds size cap`);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(`malformed jsonl line ${lineNumber} in ${source}`);
  }
  if (!object(value)) throw new Error(`invalid jsonl record ${lineNumber}`);
  return value;
}

function revisionEqual(left: SourceRevision, right: SourceRevision): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFilesystemIdentity(
  left: SourceRevision,
  right: SourceRevision,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function emptyMetrics(mode: SourceMetrics["mode"]): SourceMetrics {
  return {
    mode,
    bytesStatted: 1,
    bytesRead: 0,
    recordsParsed: 0,
    filesOpened: 0,
    filesCreated: 0,
    filesReused: 0,
    filesReplaced: 0,
    wholePrefixValidated: false,
  };
}

function failure(
  code: WorkflowFailure["code"],
  reason: string,
  now: Date,
): WorkflowFailure {
  return {
    code,
    step: "source-reconcile",
    observedAt: now.toISOString(),
    reason: reason.slice(0, 500),
    retryable: code === "source-unstable" || code === "source-missing",
    basisRevision: 1,
    evidence: [],
    ...(code === "unexpected" ? { fingerprint: sha256(reason) } : {}),
  };
}

type ParsedSource = {
  session: SourceRecord["session"];
  entries: SourceEntry[];
  completeLineCount: number;
  entryFrontier: string | null;
};

function parseRange(options: {
  cfg: SourceRoot;
  sourceId: string;
  sourcePath: string;
  bytes: Buffer;
  firstLine: number;
  acceptedIds: Set<string>;
  parentIds: Set<string>;
  expectedSession?: SourceRecord["session"];
  firstEntrySequence: number;
  requireKnownParent: boolean;
  metrics: SourceMetrics;
}): ParsedSource {
  if (!options.bytes.length || options.bytes.at(-1) !== 0x0a)
    throw new Error("incomplete final jsonl record");
  const lines = options.bytes.subarray(0, -1).toString("utf8").split("\n");
  let session = options.expectedSession;
  const entries: SourceEntry[] = [];
  for (const [index, text] of lines.entries()) {
    if (!text.trim()) continue;
    const lineNumber = options.firstLine + index;
    const raw = Buffer.from(text);
    const record = parseLine(raw, lineNumber, options.sourcePath);
    options.metrics.recordsParsed += 1;
    if (!session) {
      if (
        record.type !== "session" ||
        typeof record.id !== "string" ||
        !record.id ||
        typeof record.cwd !== "string"
      )
        throw new Error("invalid session header");
      session = { id: record.id, workspace: record.cwd };
      continue;
    }
    if (
      record.type === "session" ||
      typeof record.type !== "string" ||
      typeof record.id !== "string" ||
      !record.id ||
      !(record.parentId === null || typeof record.parentId === "string")
    )
      throw new Error(`invalid entry shape at line ${lineNumber}`);
    if (options.acceptedIds.has(record.id))
      throw new Error(`duplicate entry ${record.id}`);
    if (
      options.requireKnownParent &&
      record.parentId !== null &&
      !options.parentIds.has(record.parentId)
    )
      throw new Error(`dangling or forward parent ${record.parentId}`);
    const rawArtifact = persistArtifact(options.cfg, raw, options.metrics);
    const entry: SourceEntry = {
      schemaVersion: 3,
      sourceId: options.sourceId,
      id: record.id,
      parentId: record.parentId,
      type: record.type,
      ...(typeof record.customType === "string"
        ? { customType: record.customType }
        : {}),
      sequence: options.firstEntrySequence + entries.length,
      rawSha256: sha256(raw),
      rawArtifact,
      ...(visibleMessage(record) ? { visible: visibleMessage(record) } : {}),
      ...(isJsonValue(record.message) ? { message: record.message } : {}),
      ...(isJsonValue(record.data) ? { data: record.data } : {}),
      ...(typeof record.name === "string" ? { name: record.name } : {}),
    };
    options.acceptedIds.add(entry.id);
    options.parentIds.add(entry.id);
    entries.push(entry);
  }
  if (!session) throw new Error("missing session header");
  return {
    session,
    entries,
    completeLineCount: lines.filter((line) => line.trim()).length,
    entryFrontier: entries.at(-1)?.id ?? null,
  };
}

function readEntryIndex(cfg: SourceRoot, record: SourceRecord): SourceEntry[] {
  const graphPath = v3Data(cfg, record.accepted.graphManifest.relativePath);
  const graph = JSON.parse(readFileSync(graphPath, "utf8")) as Array<
    SourceEntry | { id: string }
  >;
  if (!Array.isArray(graph)) throw new Error("invalid source graph manifest");
  return graph.map((item, sequence) => {
    if (
      "schemaVersion" in item &&
      item.schemaVersion === 3 &&
      item.sourceId === record.sourceId &&
      item.sequence === sequence
    )
      return item as SourceEntry;
    const { id } = item;
    const value = JSON.parse(
      readFileSync(entryPath(cfg, record.sourceId, id), "utf8"),
    ) as SourceEntry;
    if (
      value.schemaVersion !== 3 ||
      value.sourceId !== record.sourceId ||
      value.id !== id ||
      value.sequence !== sequence
    )
      throw new Error("invalid source entry index");
    return value;
  });
}

function publishEntries(
  cfg: SourceRoot,
  sourceId: string,
  entries: SourceEntry[],
  metrics: SourceMetrics,
): void {
  for (const entry of entries) {
    const path = entryPath(cfg, sourceId, entry.id);
    const value = `${JSON.stringify(entry, null, 2)}\n`;
    if (durableCreate(path, value)) metrics.filesCreated += 1;
    else if (readFileSync(path, "utf8") === value) metrics.filesReused += 1;
    else {
      durableWrite(path, value);
      metrics.filesReplaced += 1;
    }
  }
}

function stageEntries(
  cfg: SourceRoot,
  candidateId: string,
  entries: SourceEntry[],
  metrics: SourceMetrics,
): void {
  for (const entry of entries) {
    const value = `${JSON.stringify(entry, null, 2)}\n`;
    const sequencePath = candidateEntryPath(cfg, candidateId, entry.sequence);
    if (durableCreate(sequencePath, value)) metrics.filesCreated += 1;
    else if (readFileSync(sequencePath, "utf8") !== value)
      throw new Error(`candidate sequence changed ${entry.sequence}`);
    else metrics.filesReused += 1;
    const identity = `${JSON.stringify({
      id: entry.id,
      sequence: entry.sequence,
      rawSha256: entry.rawSha256,
    })}\n`;
    const identityPath = candidateIdPath(cfg, candidateId, entry.id);
    if (durableCreate(identityPath, identity)) metrics.filesCreated += 1;
    else if (readFileSync(identityPath, "utf8") !== identity)
      throw new Error(`duplicate entry ${entry.id}`);
    else metrics.filesReused += 1;
  }
}

function stagedEntries(cfg: SourceRoot, candidateId: string): SourceEntry[] {
  const root = v3Data(cfg, "sources/candidates", candidateId, "entries");
  if (!existsSync(root)) return [];
  const result = readdirSync(root)
    .filter((name) => /^\d{12}\.json$/.test(name))
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(join(root, name), "utf8")) as SourceEntry,
    );
  const size = Buffer.byteLength(JSON.stringify(result));
  if (size > RESOURCE_LIMITS.maxBufferedBytes)
    throw new Error("source graph exceeds buffer cap");
  result.forEach((entry, sequence) => {
    if (
      entry.schemaVersion !== 3 ||
      entry.sequence !== sequence + (result[0]?.sequence ?? 0) ||
      !entry.id
    )
      throw new Error("invalid staged source entry");
  });
  return result;
}

function validateGraph(entries: SourceEntry[]): void {
  const byId = new Map<string, SourceEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error(`duplicate entry ${entry.id}`);
    byId.set(entry.id, entry);
  }
  for (const entry of entries)
    if (entry.parentId !== null && !byId.has(entry.parentId))
      throw new Error(`dangling parent ${entry.parentId}`);
  for (const entry of entries) {
    const seen = new Set<string>();
    let current: SourceEntry | undefined = entry;
    while (current) {
      if (seen.has(current.id)) throw new Error(`cycle at ${current.id}`);
      seen.add(current.id);
      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
}

type SessionProjection = {
  markdown: string;
  leaves: string[];
  checkpointIds: string[];
};

function customData(
  entry: SourceEntry,
  customType: string,
): Record<string, unknown> | undefined {
  return entry.type === "custom" &&
    entry.customType === customType &&
    object(entry.data)
    ? entry.data
    : undefined;
}

function checkpoint(entry: SourceEntry):
  | {
      version: 2;
      sessionId: string;
      throughLeafId: string;
      acceptedUserTurns: number;
    }
  | undefined {
  const data = customData(entry, "@bds_pi/agent-memory/checkpoint");
  return data?.version === 2 &&
    Object.keys(data).sort().join("\0") ===
      ["acceptedUserTurns", "sessionId", "throughLeafId", "version"].join(
        "\0",
      ) &&
    typeof data.sessionId === "string" &&
    data.sessionId.length > 0 &&
    typeof data.throughLeafId === "string" &&
    data.throughLeafId.length > 0 &&
    Number.isInteger(data.acceptedUserTurns) &&
    Number(data.acceptedUserTurns) >= 1
    ? (data as {
        version: 2;
        sessionId: string;
        throughLeafId: string;
        acceptedUserTurns: number;
      })
    : undefined;
}

function acceptedUserTurns(
  entries: SourceEntry[],
  throughLeafId: string,
): number {
  const through = entries.findIndex((entry) => entry.id === throughLeafId);
  return entries
    .slice(0, through + 1)
    .filter(
      (entry) =>
        entry.type === "message" &&
        object(entry.message) &&
        entry.message.role === "user",
    ).length;
}

function latestSummary(
  chain: SourceEntry[],
  through: string,
): { data: Record<string, unknown>; index: number } | undefined {
  let result: { data: Record<string, unknown>; index: number } | undefined;
  for (const [index, entry] of chain.entries()) {
    if (entry.id === through) break;
    const data = customData(entry, "@bds_pi/session-name/summary");
    if (
      data?.version === 1 &&
      typeof data.title === "string" &&
      typeof data.summary === "string" &&
      typeof data.throughLeafId === "string" &&
      chain.findIndex((candidate) => candidate.id === data.throughLeafId) >=
        0 &&
      chain.findIndex((candidate) => candidate.id === data.throughLeafId) <
        index
    )
      result = { data, index };
  }
  return result;
}

export function renderSessionProjection(
  session: SourceRecord["session"],
  entries: SourceEntry[],
): SessionProjection {
  validateGraph(entries);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const parentIds = new Set(
    entries
      .map((entry) => entry.parentId)
      .filter((id): id is string => id !== null),
  );
  const leaves = entries
    .filter((entry) => !parentIds.has(entry.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const sections: string[] = [
    `# pi session ${session.id}`,
    `workspace: ${session.workspace}`,
  ];
  const checkpointIds = new Set<string>();
  for (const leaf of leaves) {
    const chain: SourceEntry[] = [];
    let current: SourceEntry | undefined = leaf;
    while (current) {
      chain.unshift(current);
      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }
    for (const entry of chain) {
      const data = customData(entry, TURN_RECEIPT_ENTRY_TYPE);
      if (!data) continue;
      const receipt = parseTurnReceiptObservation(data).receipt;
      validateTurnReceiptBinding(chain, entry.id, receipt, {
        sessionId: session.id,
        workspace: session.workspace,
      });
    }
    const checkpointEntries = chain.filter((entry, index) => {
      const data = checkpoint(entry);
      return (
        data !== undefined &&
        data.sessionId === session.id &&
        chain
          .slice(0, index)
          .some((candidate) => candidate.id === data.throughLeafId) &&
        data.acceptedUserTurns === acceptedUserTurns(chain, data.throughLeafId)
      );
    });
    checkpointEntries.forEach((entry) => checkpointIds.add(entry.id));
    const through = checkpointEntries.at(-1)
      ? checkpoint(checkpointEntries.at(-1)!)!.throughLeafId
      : leaf.id;
    const throughIndex = chain.findIndex((entry) => entry.id === through);
    const summary = latestSummary(chain, through);
    const bounded = chain.slice((summary?.index ?? -1) + 1, throughIndex + 1);
    let name = "";
    for (const entry of chain)
      if (entry.type === "session_info" && entry.name) name = entry.name;
    sections.push(
      [
        `## branch ${leaf.id}${name ? ` — ${name}` : ""}`,
        summary ? `### summary\n\n${String(summary.data.summary)}` : "",
        ...bounded.flatMap((entry) =>
          entry.visible
            ? [`### ${entry.visible.role}\n\n${entry.visible.text}`]
            : [],
        ),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  let markdown = `${sections.join("\n\n")}\n`;
  const maxProjectionBytes = 64 * 1024;
  if (Buffer.byteLength(markdown) > maxProjectionBytes) {
    const prefix = `${sections.slice(0, 2).join("\n\n")}\n\n[earlier authored text truncated]\n\n`;
    const available = maxProjectionBytes - Buffer.byteLength(prefix) - 1;
    const suffix = Buffer.from(sections.slice(2).join("\n\n"))
      .subarray(-available)
      .toString("utf8");
    markdown = `${prefix}${suffix}\n`;
  }
  return {
    markdown,
    leaves: leaves.map((entry) => entry.id),
    checkpointIds: [...checkpointIds],
  };
}

function acceptedRecord(options: {
  cfg: SourceRoot;
  policy: SourcePolicy;
  relativePath: string;
  sourceId: string;
  revision: SourceRevision;
  session: SourceRecord["session"];
  completeLineCount: number;
  entryFrontier: string | null;
  prefixDigest: string;
  changedEntries: SourceEntry[];
  allEntries: SourceEntry[];
  boundary: Buffer;
  metrics: SourceMetrics;
  fault?: (point: SourceCrashPoint) => void;
}): SourceRecord {
  publishEntries(
    options.cfg,
    options.sourceId,
    options.changedEntries,
    options.metrics,
  );
  injectCrash(options.fault, "after-entry-indexes");
  const projection = renderSessionProjection(
    options.session,
    options.allEntries,
  );
  const graph = options.allEntries;
  const graphBytes = `${canonicalJson(graph as JsonValue)}\n`;
  if (Buffer.byteLength(graphBytes) > RESOURCE_LIMITS.maxBufferedBytes)
    throw new Error("source graph exceeds buffer cap");
  const graphManifest = persistArtifact(
    options.cfg,
    graphBytes,
    options.metrics,
  );
  const leafManifest = persistArtifact(
    options.cfg,
    `${canonicalJson(projection.leaves)}\n`,
    options.metrics,
  );
  const checkpointFrontier = persistArtifact(
    options.cfg,
    `${canonicalJson(projection.checkpointIds)}\n`,
    options.metrics,
  );
  injectCrash(options.fault, "after-derived-artifacts");
  const projectionDigest = sha256(projection.markdown);
  const projectionPath = v3Data(
    options.cfg,
    "projections/sessions",
    `${options.sourceId}.md`,
  );
  if (
    !existsSync(projectionPath) ||
    sha256(readFileSync(projectionPath)) !== projectionDigest
  ) {
    durableWrite(projectionPath, projection.markdown);
    options.metrics.filesReplaced += 1;
  }
  injectCrash(options.fault, "after-projection");
  const boundaryLength = options.boundary.length;
  const boundaryStart = options.revision.size - boundaryLength;
  if (boundaryLength !== Math.min(4_096, options.revision.size))
    throw new Error("could not establish source boundary proof");
  const record: SourceRecord = {
    schemaVersion: 3,
    sourceId: options.sourceId,
    identity: {
      rootId: options.policy.rootId,
      relativePath: options.relativePath,
      kind: options.policy.kind,
      policyVersion: options.policy.version,
    },
    session: options.session,
    revision: options.revision,
    accepted: {
      byteCursor: options.revision.size,
      completeLineCount: options.completeLineCount,
      prefixDigest: options.prefixDigest,
      boundaryProof: {
        start: boundaryStart,
        length: boundaryLength,
        sha256: sha256(options.boundary),
      },
      entryFrontier: options.entryFrontier,
      graphManifest,
    },
    projection: {
      sourceRevisionDigest: sha256(canonicalJson(options.revision)),
      markdownSha256: projectionDigest,
      stablePath: relative(v3Data(options.cfg), projectionPath),
      leafManifest,
      checkpointFrontier,
    },
    state: { type: "active" },
  };
  durableWrite(
    sourceRecordPath(options.cfg, options.sourceId),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  options.metrics.filesReplaced += 1;
  injectCrash(options.fault, "after-source-record");
  return record;
}

function assertSafeSourcePath(root: string, relativePath: string): string {
  const realRoot = realpathSync(root);
  const sourcePath = resolve(root, relativePath);
  const realParent = realpathSync(dirname(sourcePath));
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`))
    throw new Error("source path escapes root through a symlink");
  let cursor = realRoot;
  for (const component of relative(realRoot, sourcePath).split(sep)) {
    cursor = join(cursor, component);
    if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("source path cannot contain symlinks");
  }
  return sourcePath;
}

export function reconcileSource(options: {
  cfg: SourceRoot;
  policy: SourcePolicy;
  relativePath: string;
  io?: SourceIO;
  clock?: () => Date;
  continuation?: SourceContinuation;
  maxReadBytes?: number;
  forceFallback?: boolean;
  fault?: (point: SourceCrashPoint) => void;
}): ReconcileSourceOutcome {
  const io = options.io ?? nativeSourceIO;
  const now = (options.clock ?? (() => new Date()))();
  const relativePath = safeRelativePath(options.relativePath);
  if (!options.policy.enabled || sourcePathRejected(relativePath))
    throw new Error("source path rejected by policy");
  const id = sourceId(options.policy, relativePath);
  const prior = loadSourceRecord(options.cfg, id);
  const sourcePath = assertSafeSourcePath(options.policy.root, relativePath);
  const revision = io.stat(sourcePath);
  if (!revision) {
    const metrics = emptyMetrics("missing");
    if (!prior) return { type: "missing", metrics };
    const record: SourceRecord = {
      ...prior,
      state:
        prior.state.type === "missing"
          ? prior.state
          : {
              type: "missing",
              firstObservedAt: now.toISOString(),
              expiresAt: new Date(
                now.getTime() + 30 * 86_400_000,
              ).toISOString(),
            },
    };
    if (prior.state.type !== "missing") {
      durableWrite(
        sourceRecordPath(options.cfg, id),
        `${JSON.stringify(record, null, 2)}\n`,
      );
      metrics.filesReplaced += 1;
    }
    return { type: "missing", record, metrics };
  }
  if (
    !options.continuation &&
    prior &&
    prior.identity.policyVersion === options.policy.version &&
    revisionEqual(prior.revision, revision)
  ) {
    return {
      type: "unchanged",
      record: prior,
      metrics: emptyMetrics("unchanged"),
    };
  }

  let append =
    !options.forceFallback &&
    !!prior &&
    options.policy.trustedAppendOnly &&
    (options.policy.kind === "pi-session-jsonl" ||
      options.policy.kind === "amp-session-jsonl") &&
    sameFilesystemIdentity(prior.revision, revision) &&
    revision.size > prior.revision.size &&
    prior.identity.policyVersion === options.policy.version;
  const revisionDigest = sha256(canonicalJson(revision));
  const priorRecordSha256 = prior
    ? sha256(canonicalJson(prior as unknown as JsonValue))
    : null;
  const resumed = options.continuation;
  if (
    resumed &&
    (resumed.version !== 1 ||
      resumed.sourceId !== id ||
      resumed.sourceRevisionDigest !== revisionDigest ||
      resumed.priorRecordSha256 !== priorRecordSha256 ||
      resumed.nextByte < 0 ||
      resumed.nextByte >= revision.size ||
      resumed.nextEntrySequence < 0 ||
      resumed.completeLineCount < 0 ||
      !object(resumed.boundaryTail))
  )
    throw new Error("source continuation basis changed");
  if (resumed) append = resumed.mode === "append";
  const metrics = emptyMetrics(append ? "append" : "fallback");
  try {
    let start = resumed?.nextByte ?? 0;
    let existing: SourceEntry[] = [];
    let priorBoundary: Buffer | undefined;
    if (append && prior) {
      if (!resumed) {
        const proof = io.read(
          sourcePath,
          prior.accepted.boundaryProof.start,
          prior.accepted.boundaryProof.length,
        );
        metrics.filesOpened += 1;
        metrics.bytesRead += proof.length;
        if (
          proof.length !== prior.accepted.boundaryProof.length ||
          sha256(proof) !== prior.accepted.boundaryProof.sha256
        )
          return reconcileSource({ ...options, forceFallback: true });
        priorBoundary = proof;
        start = prior.accepted.byteCursor;
      }
      existing = readEntryIndex(options.cfg, prior);
    }
    const staged = resumed
      ? stagedEntries(options.cfg, resumed.candidateId)
      : [];
    const maxReadBytes = Math.min(
      options.maxReadBytes ?? RESOURCE_LIMITS.maxReadBytes,
      RESOURCE_LIMITS.maxReadBytes,
    );
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1)
      throw new Error("invalid source read limit");
    const length = Math.min(revision.size - start, maxReadBytes);
    const read = io.read(sourcePath, start, length);
    metrics.filesOpened += 1;
    metrics.bytesRead += read.length;
    if (read.length !== length) throw new Error("source changed while reading");
    const atEnd = start + read.length === revision.size;
    const finalNewline = read.lastIndexOf(0x0a);
    if (atEnd && finalNewline !== read.length - 1)
      throw new Error("incomplete final jsonl record");
    if (!atEnd && finalNewline < 0)
      throw new Error("source record exceeds turn read boundary");
    const bytes = atEnd ? read : read.subarray(0, finalNewline + 1);
    const after = io.stat(sourcePath);
    metrics.bytesStatted += 1;
    if (!after || !revisionEqual(revision, after))
      throw new Error("source changed while reading");
    const acceptedIds = new Set(
      [...existing, ...staged].map((entry) => entry.id),
    );
    const parentIds = new Set(acceptedIds);
    const parsed = parseRange({
      cfg: options.cfg,
      sourceId: id,
      sourcePath,
      bytes,
      firstLine:
        resumed?.nextLine ??
        (append && prior ? prior.accepted.completeLineCount + 1 : 1),
      acceptedIds,
      parentIds,
      expectedSession:
        resumed?.session ?? (append ? prior?.session : undefined),
      firstEntrySequence:
        resumed?.nextEntrySequence ?? existing.length + staged.length,
      requireKnownParent: append,
      metrics,
    });
    injectCrash(options.fault, "after-input-validation");
    const candidateId =
      resumed?.candidateId ??
      `candidate_${sha256(`${id}:${revisionDigest}:${append ? "append" : "fallback"}:${priorRecordSha256 ?? "none"}`).slice(0, 32)}`;
    if (!resumed)
      rmSync(v3Data(options.cfg, "sources/candidates", candidateId), {
        recursive: true,
        force: true,
      });
    stageEntries(options.cfg, candidateId, parsed.entries, metrics);
    const nextByte = start + bytes.length;
    const completeLineCount =
      (resumed?.completeLineCount ??
        (append && prior ? prior.accepted.completeLineCount : 0)) +
      parsed.completeLineCount;
    const prefixDigest = sha256(
      `${resumed?.prefixDigest ?? (append && prior ? prior.accepted.prefixDigest : sha256(""))}:${sha256(bytes)}`,
    );
    const boundary = Buffer.concat([
      resumed
        ? readArtifact(options.cfg, resumed.boundaryTail)
        : (priorBoundary ?? Buffer.alloc(0)),
      bytes,
    ]).subarray(-Math.min(4_096, nextByte));
    const boundaryTail = persistArtifact(options.cfg, boundary, metrics);
    if (nextByte < revision.size) {
      return {
        type: "suspended",
        continuation: {
          version: 1,
          sourceId: id,
          sourceRevisionDigest: revisionDigest,
          priorRecordSha256,
          mode: append ? "append" : "fallback",
          candidateId,
          nextByte,
          nextLine:
            (resumed?.nextLine ??
              (append && prior ? prior.accepted.completeLineCount + 1 : 1)) +
            bytes.toString("utf8").split("\n").length -
            1,
          nextEntrySequence:
            (resumed?.nextEntrySequence ?? existing.length + staged.length) +
            parsed.entries.length,
          completeLineCount,
          prefixDigest,
          boundaryTail,
          session: parsed.session,
        },
        metrics,
      };
    }
    const changedEntries = stagedEntries(options.cfg, candidateId);
    const allEntries = [...existing, ...changedEntries];
    validateGraph(allEntries);
    metrics.wholePrefixValidated = !append;
    const record = acceptedRecord({
      cfg: options.cfg,
      policy: options.policy,
      relativePath,
      sourceId: id,
      revision,
      session: parsed.session,
      completeLineCount,
      entryFrontier:
        allEntries.at(-1)?.id ?? prior?.accepted.entryFrontier ?? null,
      prefixDigest,
      changedEntries,
      allEntries,
      boundary,
      metrics,
      fault: options.fault,
    });
    return { type: "accepted", record, metrics };
  } catch (error) {
    if (error instanceof InjectedSourceCrash) throw error;
    if (append && !options.forceFallback)
      return reconcileSource({
        ...options,
        continuation: undefined,
        forceFallback: true,
      });
    metrics.mode = "quarantined";
    const reason = error instanceof Error ? error.message : String(error);
    const record: SourceRecord = {
      ...(prior ?? {
        schemaVersion: 3 as const,
        sourceId: id,
        identity: {
          rootId: options.policy.rootId,
          relativePath,
          kind: options.policy.kind,
          policyVersion: options.policy.version,
        },
        session: { id: "unknown", workspace: "unknown" },
        revision,
        accepted: {
          byteCursor: 0,
          completeLineCount: 1,
          prefixDigest: sha256(""),
          boundaryProof: { start: 0, length: 0, sha256: sha256("") },
          entryFrontier: null,
          graphManifest: persistArtifact(options.cfg, "[]\n", metrics),
        },
        projection: {
          sourceRevisionDigest: sha256(canonicalJson(revision)),
          markdownSha256: sha256(""),
          stablePath: `projections/sessions/${id}.md`,
          leafManifest: persistArtifact(options.cfg, "[]\n", metrics),
          checkpointFrontier: persistArtifact(options.cfg, "[]\n", metrics),
        },
      }),
      revision,
      state: {
        type: "quarantined",
        error: failure(
          reason.includes("changed while reading")
            ? "source-unstable"
            : reason.includes("boundary proof")
              ? "source-replaced"
              : "source-invalid",
          reason,
          now,
        ),
        reviewAfter: new Date(now.getTime() + 86_400_000).toISOString(),
      },
    };
    durableWrite(
      sourceRecordPath(options.cfg, id),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    metrics.filesReplaced += 1;
    return { type: "quarantined", record, metrics };
  }
}

export type DiscoveryCursor = {
  schemaVersion: 3;
  rootId: string;
  after: string | null;
  completedAt: string | null;
  stack: Array<{ directory: string; afterName: string | null }>;
};

export function discoverRoot(
  cfg: SourceRoot,
  policy: SourcePolicy,
  clock: () => Date = () => new Date(),
  maxVisited: number = RESOURCE_LIMITS.maxDiscoveryEntries,
): { paths: string[]; cursor: DiscoveryCursor; complete: boolean } {
  if (!Number.isSafeInteger(maxVisited) || maxVisited < 1)
    throw new Error("invalid discovery page limit");
  const cursorPath = v3Data(cfg, "sources/discovery", `${policy.rootId}.json`);
  let prior: DiscoveryCursor = {
    schemaVersion: 3,
    rootId: policy.rootId,
    after: null,
    completedAt: null,
    stack: [{ directory: "", afterName: null }],
  };
  if (existsSync(cursorPath)) {
    prior = JSON.parse(readFileSync(cursorPath, "utf8")) as DiscoveryCursor;
    if (
      prior.schemaVersion !== 3 ||
      prior.rootId !== policy.rootId ||
      !Array.isArray(prior.stack)
    )
      throw new Error("invalid discovery cursor");
    if (prior.stack.length === 0)
      prior = {
        ...prior,
        after: null,
        stack: [{ directory: "", afterName: null }],
      };
  }
  const stack = prior.stack.map((frame) => ({ ...frame }));
  const paths: string[] = [];
  let visited = 0;
  while (stack.length > 0 && visited < maxVisited) {
    const frame = stack.at(-1)!;
    const directory = frame.directory
      ? resolve(policy.root, frame.directory)
      : resolve(policy.root);
    const next = readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) => frame.afterName === null || entry.name > frame.afterName,
      )
      .sort((left, right) => left.name.localeCompare(right.name))[0];
    if (!next) {
      stack.pop();
      continue;
    }
    frame.afterName = next.name;
    visited += 1;
    const path = join(directory, next.name);
    const relativePath = relative(policy.root, path).replaceAll("\\", "/");
    if (sourcePathRejected(relativePath) || next.isSymbolicLink()) continue;
    if (next.isDirectory()) {
      stack.push({ directory: relativePath, afterName: null });
      continue;
    }
    if (next.isFile() && next.name.endsWith(".jsonl")) paths.push(relativePath);
  }
  const complete = stack.length === 0;
  const cursor: DiscoveryCursor = {
    schemaVersion: 3,
    rootId: policy.rootId,
    after: complete ? null : (paths.at(-1) ?? prior.after),
    completedAt: complete ? clock().toISOString() : prior.completedAt,
    stack,
  };
  durableWrite(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`);
  return { paths, cursor, complete };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  function fixture() {
    const base = mkdtempSync(join(tmpdir(), "pi-memory-source-v3-"));
    const root = join(base, "sessions");
    const cfg = { data: join(base, "data") };
    const policy: SourcePolicy = {
      version: 1,
      rootId: "pi",
      root,
      kind: "pi-session-jsonl",
      trustedAppendOnly: true,
      enabled: true,
    };
    mkdirSync(root);
    const path = join(root, "session.jsonl");
    const lines = [
      { type: "session", id: "session", cwd: "/workspace" },
      {
        type: "message",
        id: "one",
        parentId: null,
        message: { role: "user", content: "remember this" },
      },
    ];
    writeFileSync(
      path,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    return { base, root, cfg, policy, path };
  }

  describe("v3 source registry", () => {
    it("reads zero source-content bytes and writes nothing when unchanged", () => {
      const test = fixture();
      const accepted = reconcileSource({
        cfg: test.cfg,
        policy: test.policy,
        relativePath: "session.jsonl",
      });
      expect(accepted.type).toBe("accepted");
      let reads = 0;
      const io: SourceIO = {
        stat: (path) => nativeSourceIO.stat(path),
        read: (...args) => {
          reads += 1;
          return nativeSourceIO.read(...args);
        },
      };
      const unchanged = reconcileSource({
        cfg: test.cfg,
        policy: test.policy,
        relativePath: "session.jsonl",
        io,
      });
      expect(unchanged).toMatchObject({
        type: "unchanged",
        metrics: { bytesRead: 0, filesReplaced: 0, filesCreated: 0 },
      });
      expect(reads).toBe(0);
    });

    it("validates only the bounded continuity proof and appended records", () => {
      const test = fixture();
      const first = reconcileSource({
        cfg: test.cfg,
        policy: test.policy,
        relativePath: "session.jsonl",
      });
      if (first.type !== "accepted") throw new Error("fixture not accepted");
      const append = `${JSON.stringify({
        type: "message",
        id: "two",
        parentId: "one",
        message: { role: "assistant", content: "stored" },
      })}\n`;
      writeFileSync(test.path, append, { flag: "a" });
      const ranges: Array<[number, number]> = [];
      const io: SourceIO = {
        stat: (path) => nativeSourceIO.stat(path),
        read: (path, start, length) => {
          ranges.push([start, length]);
          return nativeSourceIO.read(path, start, length);
        },
      };
      const second = reconcileSource({
        cfg: test.cfg,
        policy: test.policy,
        relativePath: "session.jsonl",
        io,
      });
      expect(second).toMatchObject({
        type: "accepted",
        metrics: {
          mode: "append",
          recordsParsed: 1,
          wholePrefixValidated: false,
        },
      });
      expect(ranges).toEqual([
        [
          first.record.accepted.boundaryProof.start,
          first.record.accepted.boundaryProof.length,
        ],
        [first.record.accepted.byteCursor, Buffer.byteLength(append)],
      ]);
    });

    it.each([
      [
        "untrusted producer",
        (test: ReturnType<typeof fixture>) => ({
          ...test.policy,
          trustedAppendOnly: false,
        }),
      ],
      ["truncation", (test: ReturnType<typeof fixture>) => test.policy],
      ["replacement", (test: ReturnType<typeof fixture>) => test.policy],
    ])("uses complete fallback for %s", (_name, policyFor) => {
      const test = fixture();
      reconcileSource({
        cfg: test.cfg,
        policy: test.policy,
        relativePath: "session.jsonl",
      });
      if (_name === "truncation")
        writeFileSync(
          test.path,
          `${JSON.stringify({ type: "session", id: "session", cwd: "/workspace" })}\n`,
        );
      else if (_name === "replacement") {
        const replacement = join(test.root, "replacement");
        writeFileSync(replacement, readFileSync(test.path));
        renameSync(replacement, test.path);
      } else
        writeFileSync(
          test.path,
          `${readFileSync(test.path, "utf8")}${JSON.stringify({ type: "message", id: "two", parentId: "one", message: { role: "assistant", content: "done" } })}\n`,
        );
      const result = reconcileSource({
        cfg: test.cfg,
        policy: policyFor(test),
        relativePath: "session.jsonl",
      });
      expect(result.type).toBe("accepted");
      expect(result.metrics).toMatchObject({
        mode: "fallback",
        wholePrefixValidated: true,
      });
    });

    it("quarantines malformed, unstable, and failed-boundary input", () => {
      const malformed = fixture();
      writeFileSync(malformed.path, "{bad}\n", { flag: "a" });
      expect(
        reconcileSource({
          cfg: malformed.cfg,
          policy: malformed.policy,
          relativePath: "session.jsonl",
        }),
      ).toMatchObject({
        type: "quarantined",
        record: { state: { error: { code: "source-invalid" } } },
      });

      const boundary = fixture();
      reconcileSource({
        cfg: boundary.cfg,
        policy: boundary.policy,
        relativePath: "session.jsonl",
      });
      const original = readFileSync(boundary.path);
      original[0] = original[0] === 0x7b ? 0x20 : 0x7b;
      writeFileSync(boundary.path, original);
      writeFileSync(boundary.path, "\n", { flag: "a" });
      expect(
        reconcileSource({
          cfg: boundary.cfg,
          policy: boundary.policy,
          relativePath: "session.jsonl",
        }),
      ).toMatchObject({ type: "quarantined" });
    });

    it("falls back to complete validation when append continuity changes", () => {
      const test = fixture();
      reconcileSource({
        cfg: test.cfg,
        policy: test.policy,
        relativePath: "session.jsonl",
      });
      const changed = readFileSync(test.path, "utf8").replace(
        "remember this",
        "remember that",
      );
      writeFileSync(test.path, changed);
      writeFileSync(
        test.path,
        `${JSON.stringify({
          type: "message",
          id: "two",
          parentId: "one",
          message: { role: "assistant", content: "stored" },
        })}\n`,
        { flag: "a" },
      );
      const outcome = reconcileSource({
        cfg: test.cfg,
        policy: test.policy,
        relativePath: "session.jsonl",
      });
      expect(outcome).toMatchObject({
        type: "accepted",
        metrics: { mode: "fallback", wholePrefixValidated: true },
      });
      if (outcome.type !== "accepted") return;
      expect(
        readFileSync(
          v3Data(test.cfg, outcome.record.projection.stablePath),
          "utf8",
        ),
      ).toContain("remember that");
    });

    it("uses complete validation for same-size mutation and policy changes", () => {
      const mutated = fixture();
      reconcileSource({
        cfg: mutated.cfg,
        policy: mutated.policy,
        relativePath: "session.jsonl",
      });
      writeFileSync(
        mutated.path,
        readFileSync(mutated.path, "utf8").replace(
          "remember this",
          "remember that",
        ),
      );
      expect(
        reconcileSource({
          cfg: mutated.cfg,
          policy: mutated.policy,
          relativePath: "session.jsonl",
        }),
      ).toMatchObject({
        type: "accepted",
        metrics: { mode: "fallback", wholePrefixValidated: true },
      });

      const policy = fixture();
      reconcileSource({
        cfg: policy.cfg,
        policy: policy.policy,
        relativePath: "session.jsonl",
      });
      expect(
        reconcileSource({
          cfg: policy.cfg,
          policy: { ...policy.policy, version: 2 },
          relativePath: "session.jsonl",
        }),
      ).toMatchObject({
        type: "accepted",
        metrics: { mode: "fallback", wholePrefixValidated: true },
        record: { identity: { policyVersion: 2 } },
      });
    });

    it("quarantines a source whose revision changes during a read", () => {
      const test = fixture();
      const initial = nativeSourceIO.stat(test.path)!;
      let stats = 0;
      const io: SourceIO = {
        stat: () => {
          stats += 1;
          return stats === 1
            ? initial
            : { ...initial, mtimeNs: initial.mtimeNs + 1 };
        },
        read: (path, start, length) => nativeSourceIO.read(path, start, length),
      };
      expect(
        reconcileSource({
          cfg: test.cfg,
          policy: test.policy,
          relativePath: "session.jsonl",
          io,
        }),
      ).toMatchObject({
        type: "quarantined",
        record: { state: { error: { code: "source-unstable" } } },
      });
    });

    it("suspends large valid sources at complete records and resumes durably", () => {
      const test = fixture();
      const records: Array<Record<string, unknown>> = [
        { type: "session", id: "session", cwd: "/workspace" },
      ];
      let parentId: string | null = null;
      for (let index = 0; index < 40; index += 1) {
        const id = `entry-${String(index).padStart(2, "0")}`;
        records.push({
          type: "message",
          id,
          parentId,
          message: {
            role: index % 2 ? "assistant" : "user",
            content: `bounded record ${index}`,
          },
        });
        parentId = id;
      }
      writeFileSync(
        test.path,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
      let continuation: SourceContinuation | undefined;
      let suspensions = 0;
      let accepted: ReconcileSourceOutcome | undefined;
      for (let turn = 0; turn < 100; turn += 1) {
        const outcome = reconcileSource({
          cfg: test.cfg,
          policy: test.policy,
          relativePath: "session.jsonl",
          maxReadBytes: 350,
          ...(continuation ? { continuation } : {}),
        });
        expect(outcome.metrics.bytesRead).toBeLessThanOrEqual(350);
        if (outcome.type === "suspended") {
          suspensions += 1;
          continuation = outcome.continuation;
          expect(
            loadSourceRecord(test.cfg, sourceId(test.policy, "session.jsonl")),
          ).toBe(undefined);
          continue;
        }
        accepted = outcome;
        break;
      }
      expect(suspensions).toBeGreaterThan(1);
      expect(accepted).toMatchObject({
        type: "accepted",
        metrics: { wholePrefixValidated: true },
      });
    });

    it("matches branch, summary, and checkpoint projection semantics", () => {
      const ref: ArtifactRef = {
        relativePath: "artifacts/sha256/aa/" + "a".repeat(64),
        sha256: "a".repeat(64),
        bytes: 1,
      };
      const entry = (
        sequence: number,
        value: Partial<SourceEntry> &
          Pick<SourceEntry, "id" | "parentId" | "type">,
      ): SourceEntry => ({
        schemaVersion: 3,
        sourceId: "src_" + "a".repeat(32),
        sequence,
        rawSha256: "a".repeat(64),
        rawArtifact: ref,
        ...value,
      });
      const projected = renderSessionProjection(
        { id: "session", workspace: "/workspace" },
        [
          entry(0, {
            id: "u1",
            parentId: null,
            type: "message",
            visible: { role: "user", text: "old question" },
            message: { role: "user", content: "old question" },
          }),
          entry(1, {
            id: "a1",
            parentId: "u1",
            type: "message",
            visible: { role: "assistant", text: "old answer" },
            message: { role: "assistant", content: "old answer" },
          }),
          entry(2, {
            id: "summary",
            parentId: "a1",
            type: "custom",
            customType: "@bds_pi/session-name/summary",
            data: {
              version: 1,
              title: "fixture",
              summary: "earlier work summarized",
              throughLeafId: "a1",
            },
          }),
          entry(3, {
            id: "u2",
            parentId: "summary",
            type: "message",
            visible: { role: "user", text: "new question" },
            message: { role: "user", content: "new question" },
          }),
          entry(4, {
            id: "cp",
            parentId: "u2",
            type: "custom",
            customType: "@bds_pi/agent-memory/checkpoint",
            data: {
              version: 2,
              sessionId: "session",
              throughLeafId: "u2",
              acceptedUserTurns: 2,
            },
          }),
        ],
      );
      expect(projected).toEqual({
        markdown:
          "# pi session session\n\nworkspace: /workspace\n\n## branch cp\n\n### summary\n\nearlier work summarized\n\n### user\n\nnew question\n",
        leaves: ["cp"],
        checkpointIds: ["cp"],
      });
    });

    it.each<SourceCrashPoint>([
      "after-input-validation",
      "after-entry-indexes",
      "after-derived-artifacts",
      "after-projection",
      "after-source-record",
    ])("converges after crash point %s", (crashPoint) => {
      const test = fixture();
      expect(() =>
        reconcileSource({
          cfg: test.cfg,
          policy: test.policy,
          relativePath: "session.jsonl",
          fault: (point) => {
            if (point === crashPoint) throw new Error("injected crash");
          },
        }),
      ).toThrow("injected crash");
      const recovered = reconcileSource({
        cfg: test.cfg,
        policy: test.policy,
        relativePath: "session.jsonl",
      });
      expect(["accepted", "unchanged"]).toContain(recovered.type);
      const settled = reconcileSource({
        cfg: test.cfg,
        policy: test.policy,
        relativePath: "session.jsonl",
      });
      expect(settled).toMatchObject({
        type: "unchanged",
        metrics: { bytesRead: 0, filesCreated: 0, filesReplaced: 0 },
      });
    });

    it("never discovers version, conflict, or audit paths", () => {
      const test = fixture();
      mkdirSync(join(test.root, ".stversions"));
      mkdirSync(join(test.root, ".pi-memory"));
      writeFileSync(join(test.root, ".stversions/old.jsonl"), "{}\n");
      writeFileSync(join(test.root, ".pi-memory/audit.jsonl"), "{}\n");
      writeFileSync(
        join(test.root, "x.sync-conflict-20260903-a.jsonl"),
        "{}\n",
      );
      expect(discoverRoot(test.cfg, test.policy).paths).toEqual([
        "session.jsonl",
      ]);
    });

    it("persists a bounded discovery traversal instead of materializing the corpus", () => {
      const test = fixture();
      mkdirSync(join(test.root, "nested"));
      writeFileSync(join(test.root, "a.jsonl"), "{}\n");
      writeFileSync(join(test.root, "nested/b.jsonl"), "{}\n");
      const discovered: string[] = [];
      let complete = false;
      for (let page = 0; page < 20 && !complete; page += 1) {
        const outcome = discoverRoot(
          test.cfg,
          test.policy,
          () => new Date(),
          1,
        );
        discovered.push(...outcome.paths);
        complete = outcome.complete;
        expect(outcome.paths.length).toBeLessThanOrEqual(1);
      }
      expect(complete).toBe(true);
      expect(discovered.sort()).toEqual([
        "a.jsonl",
        "nested/b.jsonl",
        "session.jsonl",
      ]);
    });
  });
}
