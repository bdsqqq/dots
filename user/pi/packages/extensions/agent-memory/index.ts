/** Captures hash-bound memory exposure before publishing settled checkpoints. */

import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  lstat as lstatAsync,
  readFile as readFileAsync,
  realpath as realpathAsync,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createWideEvent, flushLogs } from "@bds_pi/log";
import {
  deriveAdaptationQuality,
  generateHotManifest,
  renderHotManifest,
  scanCatalog,
  sha256,
  type Catalog,
  type CatalogEntry,
  type HotManifest,
} from "@bds_pi/pi-memory/catalog";
import { redact } from "@bds_pi/pi-memory/evidence";
import {
  canonicalTurnReceiptId,
  CHECKPOINT_ENTRY_TYPE,
  INJECTION_ENTRY_TYPE,
  parseInjectionReceipt,
  parseTurnReceipt,
  parseTurnReceiptObservation,
  TURN_RECEIPT_ENTRY_TYPE,
  validateTurnReceiptBinding,
  type MemoryRef,
  type RetrievalOrdering,
  type TurnReceipt,
} from "@bds_pi/pi-memory/receipt";

const HOME = homedir();
const QUERY_MAX_CHARS = 512;
const SEARCH_MAX_RESULTS = 10;
const TOOL_DETAILS_VERSION = 1;
const MAINTENANCE_IDLE_MS = 30_000;
let maintenanceWake: ChildProcess | undefined;
let maintenanceWakePending = false;

const envPath = (name: string, fallback: string): string =>
  resolve((process.env[name] || fallback).replace(/^~(?=$|\/)/, HOME));
const memoryRoot = (): string =>
  envPath(
    "PI_MEMORY_ROOT",
    join(HOME, "commonplace/01_files/_utilities/agent-memories"),
  );
const memoryData = (): string =>
  envPath("PI_MEMORY_DATA_DIR", join(HOME, ".local/share/pi-memory"));

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addCounts(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [key, count] of Object.entries(source))
    target[key] = (target[key] ?? 0) + count;
}

function parseCatalog(value: unknown): Catalog {
  if (!object(value) || value.version !== 2 || !Array.isArray(value.entries))
    throw new Error("invalid memory catalog");
  return value as Catalog;
}

function loadCatalog(): Catalog {
  return parseCatalog(
    JSON.parse(readFileSync(join(memoryData(), "catalog.json"), "utf8")),
  );
}

function catalogSha256(catalog: Catalog): string {
  return sha256(JSON.stringify(catalog.entries));
}

function currentArtifact(entry: CatalogEntry): string {
  const root = realpathSync(memoryRoot());
  const target = resolve(root, entry.path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("memory path escapes root");
  const info = lstatSync(target);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    realpathSync(target) !== target
  )
    throw new Error("unsafe memory artifact");
  const text = readFileSync(target, "utf8");
  if (sha256(text) !== entry.sha256) throw new Error("stale memory artifact");
  return text;
}

function ref(entry: CatalogEntry): MemoryRef {
  return {
    memoryId: entry.memoryId,
    path: entry.path,
    artifactSha256: entry.sha256,
  };
}

type PromptSnapshot = {
  readonly catalogSha256: string;
  readonly refs: readonly MemoryRef[];
  readonly rendered: string;
};

const EMPTY_MEMORY_CATALOG =
  "<memory_catalog>\nDurable memory catalog unavailable for this session.\n</memory_catalog>";

async function loadPromptSnapshot(cwd: string): Promise<PromptSnapshot> {
  const data = memoryData();
  const catalog = parseCatalog(
    JSON.parse(await readFileAsync(join(data, "catalog.json"), "utf8")),
  );
  const manifestPath = join(data, "v2/hot", `${sha256(resolve(cwd))}.json`);
  const value: unknown = JSON.parse(await readFileAsync(manifestPath, "utf8"));
  if (!object(value)) throw new Error("invalid hot manifest");
  const manifest = value as HotManifest;
  if (
    manifest.version !== 2 ||
    manifest.cwd !== resolve(cwd) ||
    manifest.catalogSha256 !== catalogSha256(catalog) ||
    !/^[a-f0-9]{64}$/.test(manifest.qualitySha256) ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > 20
  )
    throw new Error("invalid hot manifest");
  const root = await realpathAsync(memoryRoot());
  const refs = await Promise.all(
    manifest.entries.map(async (item) => {
      const entry = catalog.entries.find(
        (candidate) =>
          candidate.path === item.path && candidate.sha256 === item.sha256,
      );
      if (
        !entry ||
        item.title !== entry.title ||
        item.description !== entry.description ||
        JSON.stringify(item.triggers) !== JSON.stringify(entry.triggers) ||
        !Array.isArray(item.reasons) ||
        item.reasons.some((reason) => typeof reason !== "string")
      )
        throw new Error("stale hot manifest");
      const target = resolve(root, entry.path);
      const rel = relative(root, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error("memory path escapes root");
      const [info, realTarget, text] = await Promise.all([
        lstatAsync(target),
        realpathAsync(target),
        readFileAsync(target, "utf8"),
      ]);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        realTarget !== target ||
        sha256(text) !== entry.sha256
      )
        throw new Error("stale memory artifact");
      return ref(entry);
    }),
  );
  const rendered = renderHotManifest(manifest);
  if (rendered.length > 8_192) throw new Error("oversized hot manifest");
  return Object.freeze({
    catalogSha256: manifest.catalogSha256,
    refs: Object.freeze(refs),
    rendered,
  });
}

function qualityOrderedCandidates(
  shadow: MemoryRef[],
  quality: Map<string, string>,
): MemoryRef[] {
  const qualityRank = (memory: MemoryRef): number => {
    const value = quality.get(
      `${memory.memoryId}\0${memory.path}\0${memory.artifactSha256}`,
    );
    return value === "reinforced" ? 0 : value === "demoted" ? 2 : 1;
  };
  return shadow
    .map((memory, index) => ({ memory, index }))
    .sort(
      (left, right) =>
        qualityRank(left.memory) - qualityRank(right.memory) ||
        left.index - right.index,
    )
    .map(({ memory }) => memory);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(object)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

function exactCitation(text: string, value: string): boolean {
  let offset = text.indexOf(value);
  while (offset >= 0) {
    const before = offset === 0 ? "" : text[offset - 1]!;
    const after = text[offset + value.length] ?? "";
    if (!/[A-Za-z0-9_./-]/.test(before) && !/[A-Za-z0-9_./-]/.test(after))
      return true;
    offset = text.indexOf(value, offset + value.length);
  }
  return false;
}

function customData(entry: SessionEntry, customType: string): unknown {
  return entry.type === "custom" && entry.customType === customType
    ? entry.data
    : undefined;
}

function authoredIds(
  entries: SessionEntry[],
  role: "user" | "assistant",
): string[] {
  return entries
    .filter((entry) => entry.type === "message" && entry.message.role === role)
    .map((entry) => entry.id);
}

function acceptedUserTurns(
  entries: SessionEntry[],
  throughLeafId: string,
): number {
  const through = entries.findIndex((entry) => entry.id === throughLeafId);
  return entries
    .slice(0, through + 1)
    .filter(
      (entry) => entry.type === "message" && entry.message.role === "user",
    ).length;
}

type Checkpoint = {
  version: 2;
  sessionId: string;
  throughLeafId: string;
  acceptedUserTurns: number;
};

function parseCheckpoint(value: unknown): Checkpoint | undefined {
  if (
    !object(value) ||
    Object.keys(value).sort().join("\0") !==
      ["acceptedUserTurns", "sessionId", "throughLeafId", "version"].join(
        "\0",
      ) ||
    value.version !== 2 ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    typeof value.throughLeafId !== "string" ||
    !value.throughLeafId ||
    !Number.isInteger(value.acceptedUserTurns) ||
    Number(value.acceptedUserTurns) < 1
  )
    return undefined;
  return value as Checkpoint;
}

function linkedCheckpoint(
  entries: SessionEntry[],
  receiptEntryId: string,
  throughLeafId: string,
  sessionId: string,
): boolean {
  const receiptIndex = entries.findIndex(
    (entry) => entry.id === receiptEntryId,
  );
  const expectedTurns = acceptedUserTurns(entries, throughLeafId);
  return entries.some((entry, index) => {
    if (
      index <= receiptIndex ||
      entry.type !== "custom" ||
      entry.customType !== CHECKPOINT_ENTRY_TYPE
    )
      return false;
    const checkpoint = parseCheckpoint(entry.data);
    return (
      checkpoint?.sessionId === sessionId &&
      checkpoint.throughLeafId === throughLeafId &&
      checkpoint.acceptedUserTurns === expectedTurns
    );
  });
}

type ReceiptConsumption = {
  nativeSessionId: string;
  workspace: string;
  ancestryBoundaryId?: string;
  catalog: Catalog;
};

/**
 * Session receipts are untrusted observations. Shape and ancestry checks make
 * them usable for recovery correlation; stale or malformed exposure metadata
 * is diagnostic only and never authenticates evidence or evaluation gold.
 */
function receiptEntries(
  entries: SessionEntry[],
  expected: ReceiptConsumption,
): Array<{
  entry: SessionEntry;
  receipt: TurnReceipt;
  diagnostics: string[];
}> {
  return entries.flatMap((entry) => {
    const data = customData(entry, TURN_RECEIPT_ENTRY_TYPE);
    if (data === undefined) return [];
    const observed = parseTurnReceiptObservation(data);
    const receipt = observed.receipt;
    const native = receipt.sessionId === expected.nativeSessionId;
    validateTurnReceiptBinding(entries, entry.id, receipt, {
      sessionId: receipt.sessionId,
      workspace: native ? expected.workspace : receipt.workspace,
      ...(native && expected.ancestryBoundaryId
        ? { ancestryBoundaryId: expected.ancestryBoundaryId }
        : {}),
    });
    const stale = native
      ? staleReceiptExposureCount(expected.catalog, receipt)
      : 0;
    return [
      {
        entry,
        receipt,
        diagnostics: [
          ...observed.diagnostics.map(
            (diagnostic) =>
              `${diagnostic.count} malformed exposure metadata item(s)`,
          ),
          ...(stale ? [`${stale} stale exposure metadata item(s)`] : []),
        ],
      },
    ];
  });
}

function qmdCatalogEntry(
  catalog: Catalog,
  row: Record<string, unknown>,
): CatalogEntry | undefined {
  if (typeof row.title !== "string" || typeof row.body !== "string")
    return undefined;
  const path = `${row.title}.md`;
  const entry = catalog.entries.find((candidate) => candidate.path === path);
  if (
    !entry ||
    sha256(row.body) !== entry.sha256 ||
    typeof row.file !== "string"
  )
    return undefined;
  try {
    const target = realpathSync(resolve(memoryRoot(), entry.path));
    if (row.file.startsWith("qmd://agent-memories/")) {
      const indexedPath = decodeURIComponent(
        row.file.slice("qmd://agent-memories/".length),
      );
      const expected = entry.path.replace(/[^A-Za-z0-9.]+/g, "-");
      if (indexedPath !== expected) return undefined;
    } else if (realpathSync(resolve(memoryRoot(), row.file)) !== target)
      return undefined;
    currentArtifact(entry);
    return entry;
  } catch {
    return undefined;
  }
}

function validateMemoryRef(catalog: Catalog, memory: MemoryRef): CatalogEntry {
  const entry = catalog.entries.find(
    (candidate) =>
      candidate.memoryId === memory.memoryId &&
      candidate.path === memory.path &&
      candidate.sha256 === memory.artifactSha256,
  );
  if (!entry) throw new Error("memory observation is not in current catalog");
  currentArtifact(entry);
  return entry;
}

function staleReceiptExposureCount(
  catalog: Catalog,
  receipt: TurnReceipt,
): number {
  return receipt.exposures.filter(
    (exposure) =>
      !catalog.entries.some(
        (candidate) =>
          candidate.memoryId === exposure.memoryId &&
          candidate.sha256 === exposure.artifactSha256,
      ),
  ).length;
}

function parseMemoryToolDetails(value: unknown): {
  refs: MemoryRef[];
  redactions: Record<string, number>;
  retrieval?: RetrievalOrdering;
} {
  if (
    !object(value) ||
    value.version !== TOOL_DETAILS_VERSION ||
    !Array.isArray(value.refs) ||
    (value.redactions !== undefined && !object(value.redactions)) ||
    (value.retrieval !== undefined && !object(value.retrieval))
  )
    throw new Error("invalid memory tool details");
  const refs = value.refs.map((candidate) => {
    if (
      !object(candidate) ||
      typeof candidate.memoryId !== "string" ||
      typeof candidate.path !== "string" ||
      typeof candidate.artifactSha256 !== "string"
    )
      throw new Error("invalid memory tool details");
    return candidate as MemoryRef;
  });
  const redactions = (value.redactions ?? {}) as Record<string, unknown>;
  if (
    Object.values(redactions).some(
      (count) => !Number.isInteger(count) || Number(count) < 1,
    )
  )
    throw new Error("invalid memory tool details");
  const retrieval = value.retrieval as RetrievalOrdering | undefined;
  return {
    refs,
    redactions: redactions as Record<string, number>,
    ...(retrieval ? { retrieval } : {}),
  };
}

function buildTurnReceipt(options: {
  branch: SessionEntry[];
  sessionId: string;
  workspace: string;
  catalog: Catalog;
  now: () => string;
  ancestryBoundaryId?: string;
}): TurnReceipt | undefined {
  const prior = receiptEntries(options.branch, {
    nativeSessionId: options.sessionId,
    workspace: options.workspace,
    ancestryBoundaryId: options.ancestryBoundaryId,
    catalog: options.catalog,
  });
  const nativePrior = prior.filter(
    (item) => item.receipt.sessionId === options.sessionId,
  );
  const start = nativePrior.length
    ? options.branch.findIndex(
        (entry) => entry.id === nativePrior.at(-1)!.entry.id,
      ) + 1
    : options.ancestryBoundaryId
      ? options.branch.findIndex(
          (entry) => entry.id === options.ancestryBoundaryId,
        ) + 1
      : 0;
  const window = options.branch.slice(start);
  const userEntryIds = authoredIds(window, "user");
  const assistantEntryIds = authoredIds(window, "assistant");
  if (!userEntryIds.length || !assistantEntryIds.length) return undefined;

  const injections = window.flatMap((entry) => {
    const data = customData(entry, INJECTION_ENTRY_TYPE);
    return data === undefined ? [] : [parseInjectionReceipt(data)];
  });
  const injection = injections.at(-1);
  if (!injection || !userEntryIds.includes(injection.userEntryId))
    throw new Error("settled turn is missing its memory injection receipt");

  const exposures: TurnReceipt["exposures"] = [];
  const retrievals: RetrievalOrdering[] = [];
  for (const item of injections)
    for (const memory of item.refs) {
      validateMemoryRef(options.catalog, memory);
      exposures.push({
        kind: "injected",
        memoryId: memory.memoryId,
        artifactSha256: memory.artifactSha256,
      });
    }

  const calls = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  let assistantText = "";
  for (const entry of window) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    assistantText += `${contentText(entry.message.content)}\n`;
    if (!Array.isArray(entry.message.content)) continue;
    for (const part of entry.message.content.filter(object))
      if (
        part.type === "toolCall" &&
        typeof part.id === "string" &&
        typeof part.name === "string"
      )
        calls.set(part.id, {
          name: part.name,
          args: object(part.arguments) ? part.arguments : {},
        });
  }

  const outcomes: TurnReceipt["outcomes"] = [];
  const redactions: Record<string, number> = {};
  for (const entry of window) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "toolResult") continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    outcomes.push({
      toolCallId: message.toolCallId,
      resultEntryId: entry.id,
      toolName: call.name,
      result:
        object(message.details) && message.details.cancelled === true
          ? "cancelled"
          : message.isError
            ? "error"
            : "success",
    });
    if (
      !message.isError &&
      (call.name === "memory_search" || call.name === "memory_open")
    ) {
      const details = parseMemoryToolDetails(message.details);
      const refs = details.refs;
      if (call.name === "memory_search") {
        if (
          !details.retrieval ||
          details.retrieval.toolCallId !== message.toolCallId
        )
          throw new Error("memory search is missing retrieval ordering");
        retrievals.push(details.retrieval);
      }
      refs.forEach((memory) => validateMemoryRef(options.catalog, memory));
      addCounts(redactions, details.redactions);
      const kind = call.name === "memory_search" ? "searched" : "opened";
      refs.forEach((memory, index) =>
        exposures.push({
          kind,
          memoryId: memory.memoryId,
          artifactSha256: memory.artifactSha256,
          toolCallId: message.toolCallId,
          ...(kind === "searched" ? { rank: index + 1 } : {}),
        }),
      );
      if (call.name === "memory_search") {
        const query =
          typeof call.args.query === "string" ? call.args.query : "";
        const clean = redact(query.slice(0, QUERY_MAX_CHARS));
        addCounts(redactions, clean.counts);
      }
    }
  }

  for (const entry of options.catalog.entries)
    if (
      exactCitation(assistantText, entry.memoryId) ||
      exactCitation(assistantText, entry.path)
    )
      exposures.push({
        kind: "cited",
        memoryId: entry.memoryId,
        artifactSha256: entry.sha256,
      });

  const uniqueExposures = [
    ...new Map(
      exposures.map((item) => [
        `${item.kind}\0${item.memoryId}\0${item.toolCallId ?? ""}\0${item.rank ?? ""}`,
        item,
      ]),
    ).values(),
  ];
  const identity: Omit<TurnReceipt, "receiptId"> = {
    version: 1,
    sessionId: options.sessionId,
    workspace: options.workspace,
    userEntryIds,
    assistantEntryIds,
    ...(nativePrior.length
      ? { responseToReceiptId: nativePrior.at(-1)!.receipt.receiptId }
      : {}),
    catalogSha256: injection.catalogSha256,
    ...(retrievals.length ? { retrievals } : {}),
    exposures: uniqueExposures,
    outcomes,
    redactions,
    recordedAt: options.now(),
  };
  return { ...identity, receiptId: canonicalTurnReceiptId(identity) };
}

export function wakeMemoryMaintenance(
  spawnProcess: typeof spawn = spawn,
): void {
  if (maintenanceWake) {
    maintenanceWakePending = true;
    return;
  }
  const child = spawnProcess(
    process.env.PI_MEMORY_BIN || "pi-memory",
    ["maintain"],
    { detached: true, stdio: "ignore" },
  );
  maintenanceWake = child;
  const settled = () => {
    if (maintenanceWake !== child) return;
    maintenanceWake = undefined;
    if (maintenanceWakePending) {
      maintenanceWakePending = false;
      wakeMemoryMaintenance(spawnProcess);
    }
  };
  child.once("error", settled);
  child.once("exit", settled);
  child.unref();
}

export function createAgentMemoryExtension(
  deps: {
    now?: () => string;
    wake?: () => void;
    preparePrompt?: (cwd: string) => Promise<PromptSnapshot>;
    maintenanceIdleMs?: number;
  } = {},
) {
  const now = deps.now ?? (() => new Date().toISOString());
  const wake = deps.wake ?? wakeMemoryMaintenance;
  const preparePrompt = deps.preparePrompt ?? loadPromptSnapshot;
  const maintenanceIdleMs = deps.maintenanceIdleMs ?? MAINTENANCE_IDLE_MS;
  return function agentMemoryExtension(pi: ExtensionAPI): void {
    let settling = false;
    let agentActive = false;
    let maintenanceDirty = false;
    let maintenanceTimer: NodeJS.Timeout | undefined;
    let ancestryBoundaryId: string | undefined;
    let ancestryInitialized = false;
    let sessionReason: string | undefined;
    let sessionInitialLeafId: string | undefined;
    let sessionObservation: ReturnType<typeof createWideEvent> | undefined;
    let sessionStats = {
      settledRuns: 0,
      receipts: 0,
      checkpoints: 0,
      promptFailures: 0,
      settlementFailures: 0,
    };
    let promptGeneration = 0;
    let preparedPrompt: PromptSnapshot | undefined;
    let sessionPrompt: PromptSnapshot | null | undefined;
    let pending:
      | {
          boundaryId?: string;
          existingUserId?: string;
          catalogSha256: string;
          refs: MemoryRef[];
          userEntryId?: string;
        }
      | undefined;

    const cancelMaintenance = (): void => {
      if (!maintenanceTimer) return;
      clearTimeout(maintenanceTimer);
      maintenanceTimer = undefined;
    };

    const scheduleMaintenance = (): void => {
      cancelMaintenance();
      if (!maintenanceDirty || agentActive) return;
      if (maintenanceIdleMs <= 0) {
        maintenanceDirty = false;
        wake();
        return;
      }
      maintenanceTimer = setTimeout(() => {
        maintenanceTimer = undefined;
        if (agentActive || !maintenanceDirty) return;
        maintenanceDirty = false;
        wake();
      }, maintenanceIdleMs);
      maintenanceTimer.unref();
    };

    const requestMaintenance = (): void => {
      maintenanceDirty = true;
      scheduleMaintenance();
    };

    const flushMaintenance = (): void => {
      cancelMaintenance();
      if (!maintenanceDirty) return;
      maintenanceDirty = false;
      wake();
    };

    const prepareSessionPrompt = (cwd: string): void => {
      const generation = ++promptGeneration;
      preparedPrompt = undefined;
      sessionPrompt = undefined;
      void new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => preparePrompt(cwd))
        .then((snapshot) => {
          if (generation === promptGeneration) {
            preparedPrompt = Object.freeze({
              ...snapshot,
              refs: Object.freeze([...snapshot.refs]),
            });
            sessionObservation?.set(
              sessionPrompt === undefined
                ? {
                    prompt: {
                      status: "prepared",
                      catalogSha256: snapshot.catalogSha256,
                      memories: snapshot.refs.length,
                    },
                  }
                : { prompt: { preparation: "completed-late" } },
            );
          }
        })
        .catch((error) => {
          if (generation === promptGeneration) {
            preparedPrompt = undefined;
            sessionStats.promptFailures += 1;
            sessionObservation?.error(error, {
              prompt: { status: "failed" },
            });
            requestMaintenance();
          }
        });
    };

    const consumption = (ctx: {
      cwd: string;
      sessionManager: { getSessionId(): string };
    }): ReceiptConsumption => ({
      nativeSessionId: ctx.sessionManager.getSessionId(),
      workspace: ctx.cwd,
      ancestryBoundaryId,
      catalog: loadCatalog(),
    });

    const initializeAncestry = (
      branch: SessionEntry[],
      sessionId: string,
    ): void => {
      if (ancestryInitialized) return;
      const parsed = branch.flatMap((entry) => {
        const data = customData(entry, TURN_RECEIPT_ENTRY_TYPE);
        return data === undefined
          ? []
          : [{ entry, receipt: parseTurnReceiptObservation(data).receipt }];
      });
      const firstNative = parsed.find(
        (item) => item.receipt.sessionId === sessionId,
      );
      if (firstNative) {
        const firstUserIndex = branch.findIndex(
          (entry) => entry.id === firstNative.receipt.userEntryIds[0],
        );
        ancestryBoundaryId =
          firstUserIndex > 0 ? branch[firstUserIndex - 1]!.id : undefined;
      } else if (
        sessionReason === "fork" ||
        parsed.some((item) => item.receipt.sessionId !== sessionId)
      )
        ancestryBoundaryId = sessionInitialLeafId;
      else ancestryBoundaryId = undefined;
      ancestryInitialized = true;
    };

    const reconcile = (branch: SessionEntry[], ctx: any): number => {
      const native = receiptEntries(branch, consumption(ctx)).filter(
        (item) => item.receipt.sessionId === ctx.sessionManager.getSessionId(),
      );
      let appended = 0;
      for (const item of native) {
        const throughLeafId = item.receipt.assistantEntryIds.at(-1)!;
        if (
          linkedCheckpoint(
            branch,
            item.entry.id,
            throughLeafId,
            ctx.sessionManager.getSessionId(),
          )
        )
          continue;
        pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
          version: 2,
          sessionId: ctx.sessionManager.getSessionId(),
          throughLeafId,
          acceptedUserTurns: acceptedUserTurns(branch, throughLeafId),
        });
        appended += 1;
      }
      return appended;
    };

    pi.registerTool({
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search current durable agent memories. Returns only hash-bound current catalog references.",
      parameters: Type.Object(
        { query: Type.String({ minLength: 1, maxLength: QUERY_MAX_CHARS }) },
        { additionalProperties: false },
      ),
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        const clean = redact(params.query.slice(0, QUERY_MAX_CHARS));
        const observation = createWideEvent({
          service: "pi-memory",
          operation: "memory.retrieval",
          correlation: {
            sessionId: ctx?.sessionManager.getSessionId(),
            toolCallId,
          },
          fields: {
            retrieval: {
              kind: "search",
              querySha256: sha256(clean.text),
              queryChars: clean.text.length,
              redactions: clean.counts,
            },
          },
        });
        try {
          const result = await pi.exec(
            process.env.QMD_BIN || "qmd",
            [
              "search",
              "-c",
              "agent-memories",
              "--json",
              "--full",
              "--full-path",
              clean.text,
              "-n",
              String(SEARCH_MAX_RESULTS),
            ],
            { cwd: memoryRoot(), signal, timeout: 15_000 },
          );
          if (result.code !== 0) throw new Error("memory search failed");
          let rows: unknown;
          try {
            rows = JSON.parse(result.stdout);
          } catch {
            throw new Error("invalid memory search result");
          }
          if (!Array.isArray(rows))
            throw new Error("invalid memory search result");
          const catalog = loadCatalog();
          const refs = rows.flatMap((row) => {
            if (!object(row)) return [];
            const entry = qmdCatalogEntry(catalog, row);
            return entry ? [ref(entry)] : [];
          });
          const shadow = [
            ...new Map(refs.map((item) => [item.memoryId, item])).values(),
          ];
          const data = memoryData();
          const root = memoryRoot();
          const quality = deriveAdaptationQuality({
            data,
            root,
            state: data,
            skillsRoot: root,
          });
          const production = qualityOrderedCandidates(shadow, quality);
          const candidateKeys = shadow
            .map(
              (memory) =>
                `${memory.memoryId}\0${memory.path}\0${memory.artifactSha256}`,
            )
            .sort();
          const retrieval: RetrievalOrdering = {
            toolCallId,
            querySha256: sha256(clean.text),
            candidateSetSha256: sha256(JSON.stringify(candidateKeys)),
            production,
            shadow,
          };
          observation.finish("success", {
            retrieval: {
              candidates: shadow.length,
              returned: production.length,
              candidateSetSha256: retrieval.candidateSetSha256,
            },
          });
          return {
            content: [
              {
                type: "text",
                text: production.length
                  ? production
                      .map(
                        (item, index) =>
                          `${index + 1}. ${item.memoryId} | ${item.path} | sha256:${item.artifactSha256}`,
                      )
                      .join("\n")
                  : "No current catalog memories matched.",
              },
            ],
            details: {
              version: TOOL_DETAILS_VERSION,
              refs: production,
              retrieval,
            },
          };
        } catch (error) {
          observation.error(error);
          observation.finish("failure");
          throw error;
        }
      },
    });

    pi.registerTool({
      name: "memory_open",
      label: "Memory Open",
      description:
        "Open one current durable memory by exact memory ID after validating its catalog hash.",
      parameters: Type.Object(
        { memoryId: Type.String({ minLength: 1, maxLength: 256 }) },
        { additionalProperties: false },
      ),
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        const observation = createWideEvent({
          service: "pi-memory",
          operation: "memory.retrieval",
          correlation: {
            sessionId: ctx?.sessionManager.getSessionId(),
            toolCallId,
          },
          fields: {
            retrieval: {
              kind: "open",
              requestedMemoryIdSha256: sha256(redact(params.memoryId).text),
            },
          },
        });
        try {
          const catalog = loadCatalog();
          const entry = catalog.entries.find(
            (candidate) => candidate.memoryId === params.memoryId,
          );
          if (!entry) throw new Error("unknown memory ID");
          const clean = redact(currentArtifact(entry));
          observation.finish("success", {
            retrieval: {
              memoryId: entry.memoryId,
              outputChars: clean.text.length,
              redactions: clean.counts,
            },
          });
          return {
            content: [{ type: "text", text: clean.text }],
            details: {
              version: TOOL_DETAILS_VERSION,
              refs: [ref(entry)],
              redactions: clean.counts,
            },
          };
        } catch (error) {
          observation.error(error);
          observation.finish("failure");
          throw error;
        }
      },
    });

    pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "read" && event.toolName !== "grep") return;
      const root = realpathSync(memoryRoot());
      const rawPath = event.input.path;
      const candidate =
        typeof rawPath === "string" && rawPath
          ? resolve(ctx.cwd, rawPath.replace(/^@/, ""))
          : resolve(ctx.cwd);
      let target = candidate;
      try {
        target = realpathSync(candidate);
      } catch {}
      const targetInRoot =
        target === root || target.startsWith(`${root}${sep}`);
      const rootInTarget =
        root === target || root.startsWith(`${target}${sep}`);
      if (!targetInRoot && (event.toolName !== "grep" || !rootInTarget)) return;
      return {
        block: true,
        reason:
          "Generic read/grep cannot access the durable memory root. Use memory_open(memoryId) or memory_search(query).",
      };
    });

    pi.on("tool_result", (event) => {
      if (
        event.toolName !== "memory_search" &&
        event.toolName !== "memory_open"
      )
        return;
      if (!event.isError) {
        const catalog = loadCatalog();
        const details = parseMemoryToolDetails(event.details);
        details.refs.forEach((memory) => validateMemoryRef(catalog, memory));
      }
    });

    pi.on("before_agent_start", (event, ctx) => {
      agentActive = true;
      cancelMaintenance();
      if (sessionPrompt === undefined) sessionPrompt = preparedPrompt ?? null;
      sessionObservation?.set({
        prompt: {
          status: sessionPrompt ? "injected" : "unavailable",
          memories: sessionPrompt?.refs.length ?? 0,
        },
      });
      const leaf = ctx.sessionManager.getLeafEntry();
      const existingUser =
        leaf?.type === "message" && leaf.message.role === "user"
          ? leaf
          : undefined;
      const boundary =
        existingUser && existingUser.parentId
          ? ctx.sessionManager.getEntry(existingUser.parentId)
          : existingUser
            ? undefined
            : leaf;
      pending = sessionPrompt
        ? {
            ...(boundary ? { boundaryId: boundary.id } : {}),
            ...(existingUser ? { existingUserId: existingUser.id } : {}),
            catalogSha256: sessionPrompt.catalogSha256,
            refs: [...sessionPrompt.refs],
          }
        : undefined;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${
          sessionPrompt?.rendered ?? EMPTY_MEMORY_CATALOG
        }`,
      };
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (!ctx.isIdle()) {
        agentActive = true;
        return;
      }
      agentActive = false;
      if (settling) return;
      sessionStats.settledRuns += 1;
      if (!sessionPrompt) {
        sessionObservation?.set({ session: sessionStats });
        scheduleMaintenance();
        return;
      }
      settling = true;
      try {
        let receiptAppended = false;
        let branch = ctx.sessionManager.getBranch();
        initializeAncestry(branch, ctx.sessionManager.getSessionId());
        const catalog = loadCatalog();
        receiptEntries(branch, consumption(ctx));
        if (pending && !pending.userEntryId) {
          const boundary = pending.boundaryId
            ? branch.findIndex((entry) => entry.id === pending!.boundaryId)
            : -1;
          const user =
            pending.existingUserId !== undefined
              ? branch.find((entry) => entry.id === pending!.existingUserId)
              : branch
                  .slice(boundary + 1)
                  .find(
                    (entry) =>
                      entry.type === "message" && entry.message.role === "user",
                  );
          if (
            (pending.boundaryId !== undefined && boundary < 0) ||
            user?.type !== "message" ||
            user.message.role !== "user" ||
            catalogSha256(catalog) !== pending.catalogSha256
          ) {
            pending = undefined;
          } else {
            pending.refs.forEach((memory) =>
              validateMemoryRef(catalog, memory),
            );
            const existing = branch.some((entry) => {
              const data = customData(entry, INJECTION_ENTRY_TYPE);
              return (
                data !== undefined &&
                parseInjectionReceipt(data).userEntryId === user.id
              );
            });
            if (!existing)
              pi.appendEntry(INJECTION_ENTRY_TYPE, {
                version: 1,
                userEntryId: user.id,
                catalogSha256: pending.catalogSha256,
                refs: pending.refs,
              });
            pending.userEntryId = user.id;
            branch = ctx.sessionManager.getBranch();
          }
        }
        if (pending?.userEntryId) {
          const receipt = buildTurnReceipt({
            branch,
            sessionId: ctx.sessionManager.getSessionId(),
            workspace: ctx.cwd,
            catalog,
            now,
            ancestryBoundaryId,
          });
          if (receipt) {
            pi.appendEntry(TURN_RECEIPT_ENTRY_TYPE, receipt);
            receiptAppended = true;
            pending = undefined;
            branch = ctx.sessionManager.getBranch();
          }
        }
        const checkpointCount = reconcile(branch, ctx);
        if (receiptAppended) sessionStats.receipts += 1;
        sessionStats.checkpoints += checkpointCount;
        sessionObservation?.set({ session: sessionStats });
        if (receiptAppended || checkpointCount > 0) requestMaintenance();
      } catch (error) {
        sessionStats.settlementFailures += 1;
        sessionObservation?.error(error, { session: sessionStats });
        throw error;
      } finally {
        settling = false;
        scheduleMaintenance();
      }
    });

    pi.on("session_start", (event, ctx) => {
      sessionObservation?.finish("degraded", {
        session: { status: "superseded" },
      });
      sessionStats = {
        settledRuns: 0,
        receipts: 0,
        checkpoints: 0,
        promptFailures: 0,
        settlementFailures: 0,
      };
      sessionObservation = createWideEvent({
        service: "pi-memory",
        operation: "memory.extension-session",
        correlation: {
          sessionId: ctx.sessionManager.getSessionId(),
        },
        fields: {
          session: {
            reason: event.reason,
            workspace: ctx.cwd,
          },
        },
      });
      cancelMaintenance();
      agentActive = false;
      pending = undefined;
      prepareSessionPrompt(ctx.cwd);
      ancestryBoundaryId = undefined;
      ancestryInitialized = false;
      sessionReason = event.reason;
      sessionInitialLeafId = ctx.sessionManager.getLeafId() ?? undefined;
    });

    pi.on("session_shutdown", async (event) => {
      const maintenanceRequested = maintenanceDirty;
      flushMaintenance();
      promptGeneration += 1;
      sessionObservation?.finish(
        sessionStats.promptFailures || sessionStats.settlementFailures
          ? "degraded"
          : "success",
        {
          session: {
            ...sessionStats,
            shutdownReason: event.reason,
            maintenanceRequested,
          },
        },
      );
      sessionObservation = undefined;
      await flushLogs();
    });
  };
}

const agentMemoryExtension: (pi: ExtensionAPI) => void =
  createAgentMemoryExtension();
export default agentMemoryExtension;

if (import.meta.vitest) {
  const { afterAll, afterEach, beforeEach, describe, expect, it, vi } =
    import.meta.vitest;
  let testDir = "";
  let root = "";
  let data = "";
  const testLogDir = join(tmpdir(), `pi-agent-memory-test-logs-${process.pid}`);

  function user(id: string, text = "goal"): SessionEntry {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: text, timestamp: 1 },
    } as SessionEntry;
  }

  function assistant(
    id: string,
    content: Array<Record<string, unknown>> = [{ type: "text", text: "done" }],
  ): SessionEntry {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content,
        api: "test",
        provider: "test",
        model: "test",
        stopReason: "stop",
        timestamp: 2,
      },
    } as unknown as SessionEntry;
  }

  function result(
    id: string,
    toolCallId: string,
    toolName: string,
    details: unknown,
    isError = false,
  ): SessionEntry {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: "raw output is not copied" }],
        details,
        isError,
        timestamp: 3,
      },
    } as SessionEntry;
  }

  function custom(
    id: string,
    customType: string,
    value: unknown,
  ): SessionEntry {
    return {
      type: "custom",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:03.000Z",
      customType,
      data: value,
    } as SessionEntry;
  }

  function setupCatalog(extraBody = "body") {
    mkdirSync(root, { recursive: true });
    mkdirSync(data, { recursive: true });
    const path = "2026-01-01-test-memory-source__agent.md";
    writeFileSync(
      join(root, path),
      `---\nmemory_version: 2\nmemory_id: "mem_test"\ntitle: "test"\ndescription: "test memory"\nkind: "fact"\nscope: "global"\ntriggers: ["test"]\nkeywords: []\nstatus: "active"\nupdated: "2026-01-01"\n---\n\n# test\n\n${extraBody}\n`,
    );
    const catalog = scanCatalog(root, "2026-01-01T00:00:00.000Z");
    writeFileSync(join(data, "catalog.json"), JSON.stringify(catalog));
    const manifest = generateHotManifest({ data }, catalog, "/workspace");
    return { catalog, entry: catalog.entries[0]!, manifest, path };
  }

  function preparedPrompt(
    setup: ReturnType<typeof setupCatalog>,
  ): PromptSnapshot {
    return {
      catalogSha256: catalogSha256(setup.catalog),
      refs: setup.manifest.entries.map((item) => {
        const entry = setup.catalog.entries.find(
          (candidate) => candidate.path === item.path,
        )!;
        return ref(entry);
      }),
      rendered: renderHotManifest(setup.manifest),
    };
  }

  function harness(branch: SessionEntry[]) {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    const tools = new Map<string, any>();
    const actions: string[] = [];
    const exec = vi.fn();
    const pi = {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      on(event: string, handler: (event: any, ctx: any) => any) {
        handlers.set(event, handler);
      },
      appendEntry(customType: string, value: unknown) {
        actions.push(customType);
        branch.push(custom(`c${branch.length}`, customType, value));
      },
      exec,
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/workspace",
      isIdle: () => true,
      sessionManager: {
        getBranch: () => branch,
        getEntry: (id: string) => branch.find((entry) => entry.id === id),
        getLeafEntry: () => branch.at(-1),
        getLeafId: () => branch.at(-1)?.id ?? null,
        getSessionId: () => "session-1",
      },
    };
    return { pi, handlers, tools, actions, exec, ctx };
  }

  async function settlePromptPreparation(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "pi-agent-memory-test-"));
    root = join(testDir, "root");
    data = join(testDir, "data");
    process.env.PI_MEMORY_ROOT = root;
    process.env.PI_MEMORY_DATA_DIR = data;
    process.env.BDS_PI_LOG_DIR = testLogDir;
  });

  afterEach(() => {
    delete process.env.PI_MEMORY_ROOT;
    delete process.env.PI_MEMORY_DATA_DIR;
    delete process.env.PI_MEMORY_BIN;
    maintenanceWake = undefined;
    maintenanceWakePending = false;
    rmSync(testDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await flushLogs();
    delete process.env.BDS_PI_LOG_DIR;
    rmSync(testLogDir, { recursive: true, force: true });
  });

  describe("agent-memory", () => {
    it("keeps the qmd candidate set while applying deterministic quality order", () => {
      const first = {
        memoryId: "mem_first",
        path: "first.md",
        artifactSha256: "a".repeat(64),
      };
      const second = {
        memoryId: "mem_second",
        path: "second.md",
        artifactSha256: "b".repeat(64),
      };
      const quality = new Map([
        [
          `${first.memoryId}\0${first.path}\0${first.artifactSha256}`,
          "demoted",
        ],
        [
          `${second.memoryId}\0${second.path}\0${second.artifactSha256}`,
          "reinforced",
        ],
      ]);
      const shadow = [first, second];
      expect(qualityOrderedCandidates(shadow, quality)).toEqual([
        second,
        first,
      ]);
      expect(new Set(qualityOrderedCandidates(shadow, quality))).toEqual(
        new Set(shadow),
      );
    });
    it("registers the complete observation lifecycle and narrow tools", () => {
      setupCatalog();
      const h = harness([]);
      createAgentMemoryExtension({ wake: vi.fn() })(h.pi);
      expect([...h.handlers.keys()].sort()).toEqual([
        "agent_settled",
        "before_agent_start",
        "session_shutdown",
        "session_start",
        "tool_call",
        "tool_result",
      ]);
      expect([...h.tools.keys()].sort()).toEqual([
        "memory_open",
        "memory_search",
      ]);
    });

    it("does not await prompt preparation or mutate the prompt mid-session", async () => {
      const setup = setupCatalog();
      const h = harness([]);
      let resolvePrompt!: (snapshot: PromptSnapshot) => void;
      const preparePrompt = vi.fn(
        () =>
          new Promise<PromptSnapshot>((resolve) => {
            resolvePrompt = resolve;
          }),
      );
      createAgentMemoryExtension({
        wake: vi.fn(),
        preparePrompt,
      })(h.pi);
      h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await settlePromptPreparation();
      const first = h.handlers.get("before_agent_start")!(
        { systemPrompt: "base" },
        h.ctx,
      );
      expect(first.systemPrompt).toContain("catalog unavailable");
      resolvePrompt(preparedPrompt(setup));
      await settlePromptPreparation();
      const second = h.handlers.get("before_agent_start")!(
        { systemPrompt: "base" },
        h.ctx,
      );
      expect(second.systemPrompt).toBe(first.systemPrompt);
      expect(preparePrompt).toHaveBeenCalledOnce();
    });

    it("starts immediately with a stable empty catalog when preparation fails", async () => {
      setupCatalog();
      rmSync(join(data, "catalog.json"));
      const h = harness([]);
      createAgentMemoryExtension({ wake: vi.fn() })(h.pi);
      expect(() =>
        h.handlers.get("session_start")!({ reason: "startup" }, h.ctx),
      ).not.toThrow();
      const first = h.handlers.get("before_agent_start")!(
        { systemPrompt: "base" },
        h.ctx,
      );
      await settlePromptPreparation();
      const second = h.handlers.get("before_agent_start")!(
        { systemPrompt: "base" },
        h.ctx,
      );
      expect(second.systemPrompt).toBe(first.systemPrompt);
      expect(() => h.handlers.get("agent_settled")!({}, h.ctx)).not.toThrow();
      expect(h.actions).toEqual([]);
    });

    it("defers failed preparation maintenance until the active turn settles", async () => {
      setupCatalog();
      const h = harness([]);
      const wake = vi.fn();
      let rejectPrompt!: (error: Error) => void;
      createAgentMemoryExtension({
        wake,
        maintenanceIdleMs: 50,
        preparePrompt: () =>
          new Promise<PromptSnapshot>((_resolve, reject) => {
            rejectPrompt = reject;
          }),
      })(h.pi);
      h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      await new Promise<void>((resolve) => setImmediate(resolve));
      rejectPrompt(new Error("catalog unavailable"));
      await settlePromptPreparation();
      vi.useFakeTimers();
      vi.advanceTimersByTime(50);
      expect(wake).not.toHaveBeenCalled();
      h.handlers.get("agent_settled")!({}, h.ctx);
      vi.advanceTimersByTime(50);
      expect(wake).toHaveBeenCalledOnce();
    });

    it("binds a turn after Pi persists its messages", async () => {
      const setup = setupCatalog();
      const branch: SessionEntry[] = [];
      const h = harness(branch);
      const wake = vi.fn(() => h.actions.push("wake"));
      createAgentMemoryExtension({
        now: () => "2026-01-01T00:00:04.000Z",
        wake,
        preparePrompt: async () => preparedPrompt(setup),
        maintenanceIdleMs: 0,
      })(h.pi);
      h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await settlePromptPreparation();
      const injected = h.handlers.get("before_agent_start")!(
        { systemPrompt: "base" },
        h.ctx,
      );
      expect(injected.systemPrompt).toContain("<memory_catalog>");
      expect(h.actions).toEqual([]);
      expect(h.handlers.has("turn_start")).toBe(false);
      branch.push(user("u1"));
      branch.push(assistant("a1"));
      h.handlers.get("agent_settled")!({}, h.ctx);
      expect(h.actions).toEqual([
        INJECTION_ENTRY_TYPE,
        TURN_RECEIPT_ENTRY_TYPE,
        CHECKPOINT_ENTRY_TYPE,
        "wake",
      ]);
      expect(customData(branch.at(-1)!, CHECKPOINT_ENTRY_TYPE)).toEqual({
        version: 2,
        sessionId: "session-1",
        throughLeafId: "a1",
        acceptedUserTurns: 1,
      });
      expect(
        parseTurnReceipt(customData(branch.at(-2)!, TURN_RECEIPT_ENTRY_TYPE)),
      ).toMatchObject({
        userEntryIds: ["u1"],
        assistantEntryIds: ["a1"],
      });
      h.handlers.get("agent_settled")!({}, h.ctx);
      expect(wake).toHaveBeenCalledOnce();
    });

    it("runs maintenance only after the session stays idle", async () => {
      const setup = setupCatalog();
      const branch: SessionEntry[] = [];
      const h = harness(branch);
      const wake = vi.fn();
      createAgentMemoryExtension({
        wake,
        preparePrompt: async () => preparedPrompt(setup),
        maintenanceIdleMs: 50,
      })(h.pi);
      h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await settlePromptPreparation();
      vi.useFakeTimers();
      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      branch.push(user("u1"), assistant("a1"));
      h.handlers.get("agent_settled")!({}, h.ctx);
      expect(wake).not.toHaveBeenCalled();
      vi.advanceTimersByTime(49);
      expect(wake).not.toHaveBeenCalled();
      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      vi.advanceTimersByTime(50);
      expect(wake).not.toHaveBeenCalled();
      branch.push(user("u2"), assistant("a2"));
      h.handlers.get("agent_settled")!({}, h.ctx);
      vi.advanceTimersByTime(50);
      expect(wake).toHaveBeenCalledOnce();
      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      branch.push(user("u3"), assistant("a3"));
      h.handlers.get("agent_settled")!({}, h.ctx);
      h.handlers.get("session_shutdown")!({}, h.ctx);
      vi.advanceTimersByTime(50);
      expect(wake).toHaveBeenCalledTimes(2);
    });

    it("waits for a nested run to settle before publishing receipts", async () => {
      const setup = setupCatalog();
      const branch: SessionEntry[] = [];
      const h = harness(branch);
      let idle = false;
      h.ctx.isIdle = () => idle;
      createAgentMemoryExtension({
        wake: vi.fn(),
        preparePrompt: async () => preparedPrompt(setup),
        maintenanceIdleMs: 0,
      })(h.pi);
      h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await settlePromptPreparation();
      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      branch.push(user("u1"), assistant("a1"));
      h.handlers.get("agent_settled")!({}, h.ctx);
      expect(h.actions).toEqual([]);
      idle = true;
      h.handlers.get("agent_settled")!({}, h.ctx);
      expect(h.actions).toEqual([
        INJECTION_ENTRY_TYPE,
        TURN_RECEIPT_ENTRY_TYPE,
        CHECKPOINT_ENTRY_TYPE,
      ]);
    });

    it("keeps the session ancestry boundary separate from each turn cursor", async () => {
      const setup = setupCatalog();
      const branch: SessionEntry[] = [];
      const h = harness(branch);
      createAgentMemoryExtension({
        now: () => "2026-01-01T00:00:04.000Z",
        wake: vi.fn(),
        preparePrompt: async () => preparedPrompt(setup),
      })(h.pi);
      h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await settlePromptPreparation();

      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      branch.push(user("u1"), assistant("a1"));
      h.handlers.get("agent_settled")!({}, h.ctx);

      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      branch.push(user("u2"), assistant("a2"));
      expect(() => h.handlers.get("agent_settled")!({}, h.ctx)).not.toThrow();
      const receipts = branch.flatMap((entry) => {
        const data = customData(entry, TURN_RECEIPT_ENTRY_TYPE);
        return data === undefined ? [] : [parseTurnReceipt(data)];
      });
      expect(receipts).toHaveLength(2);
      expect(receipts[1]).toMatchObject({
        userEntryIds: ["u2"],
        assistantEntryIds: ["a2"],
        responseToReceiptId: receipts[0]!.receiptId,
      });
    });

    it("drops observation when a run settles without a persisted user", async () => {
      const setup = setupCatalog();
      const branch: SessionEntry[] = [];
      const h = harness(branch);
      createAgentMemoryExtension({
        wake: vi.fn(),
        preparePrompt: async () => preparedPrompt(setup),
      })(h.pi);
      h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await settlePromptPreparation();
      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      expect(() => h.handlers.get("agent_settled")!({}, h.ctx)).not.toThrow();
      expect(h.actions).toEqual([]);
    });

    it("correlates parallel results by call ID and redacts bounded queries", () => {
      const { catalog, entry } = setupCatalog();
      const injection = custom("i1", INJECTION_ENTRY_TYPE, {
        version: 1,
        userEntryId: "u1",
        catalogSha256: catalogSha256(catalog),
        refs: [ref(entry)],
      });
      const branch = [
        user("u1"),
        injection,
        assistant("a1", [
          {
            type: "toolCall",
            id: "search-call",
            name: "memory_search",
            arguments: { query: `token sk-${"a1".repeat(20)}` },
          },
          {
            type: "toolCall",
            id: "read-call",
            name: "read",
            arguments: { path: join(root, entry.path) },
          },
        ]),
        result("r-read", "read-call", "read", {}),
        result("r-search", "search-call", "memory_search", {
          version: 1,
          refs: [ref(entry)],
          retrieval: {
            toolCallId: "search-call",
            querySha256: "a".repeat(64),
            candidateSetSha256: sha256(
              JSON.stringify([
                `${entry.memoryId}\0${entry.path}\0${entry.sha256}`,
              ]),
            ),
            production: [ref(entry)],
            shadow: [ref(entry)],
          },
        }),
      ];
      const receipt = buildTurnReceipt({
        branch,
        sessionId: "session-1",
        workspace: "/workspace",
        catalog,
        now: () => "2026-01-01T00:00:04.000Z",
      })!;
      expect(receipt.outcomes).toEqual([
        {
          toolCallId: "read-call",
          resultEntryId: "r-read",
          toolName: "read",
          result: "success",
        },
        {
          toolCallId: "search-call",
          resultEntryId: "r-search",
          toolName: "memory_search",
          result: "success",
        },
      ]);
      expect(receipt.exposures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "searched",
            toolCallId: "search-call",
            rank: 1,
          }),
        ]),
      );
      expect(receipt.retrievals).toEqual([
        expect.objectContaining({
          toolCallId: "search-call",
          production: [ref(entry)],
          shadow: [ref(entry)],
        }),
      ]);
      expect(receipt.redactions["provider-token"]).toBe(1);
      expect(JSON.stringify(receipt)).not.toContain("sk-");
      expect(JSON.stringify(receipt)).not.toContain("raw output");
    });

    it("records only exact memory citations", () => {
      const { catalog, entry } = setupCatalog();
      const base = [
        user("u1"),
        custom("i1", INJECTION_ENTRY_TYPE, {
          version: 1,
          userEntryId: "u1",
          catalogSha256: catalogSha256(catalog),
          refs: [],
        }),
      ];
      const exact = buildTurnReceipt({
        branch: [
          ...base,
          assistant("a1", [{ type: "text", text: `source: ${entry.path}` }]),
        ],
        sessionId: "session-1",
        workspace: "/workspace",
        catalog,
        now: () => "2026-01-01T00:00:04.000Z",
      })!;
      const embedded = buildTurnReceipt({
        branch: [
          ...base,
          assistant("a2", [{ type: "text", text: `source: x${entry.path}` }]),
        ],
        sessionId: "session-1",
        workspace: "/workspace",
        catalog,
        now: () => "2026-01-01T00:00:04.000Z",
      })!;
      expect(exact.exposures.some((item) => item.kind === "cited")).toBe(true);
      expect(embedded.exposures.some((item) => item.kind === "cited")).toBe(
        false,
      );
    });

    it("maps qmd output only to hash-valid current catalog artifacts", async () => {
      const { entry } = setupCatalog();
      const h = harness([]);
      createAgentMemoryExtension()(h.pi);
      h.exec.mockResolvedValue({
        code: 0,
        stdout: JSON.stringify([
          {
            file: `qmd://agent-memories/${entry.path.replace(/[^A-Za-z0-9.]+/g, "-")}`,
            title: entry.path.slice(0, -3),
            body: readFileSync(join(root, entry.path), "utf8"),
          },
          { file: "qmd://other/unknown.md", title: "unknown", body: "x" },
          {
            file: `qmd://agent-memories/${entry.path}`,
            title: entry.path.slice(0, -3),
            body: "tampered",
          },
        ]),
        stderr: "",
        killed: false,
      });
      const output = await h.tools
        .get("memory_search")
        .execute("call", { query: "test" }, undefined);
      expect(output.details.refs).toEqual([ref(entry)]);
      expect(output.content[0].text).not.toContain("unknown.md");
      writeFileSync(join(root, entry.path), "changed");
      await expect(
        h.tools.get("memory_open").execute("call", {
          memoryId: entry.memoryId,
        }),
      ).rejects.toThrow("stale memory artifact");
    });

    it("emits correlated retrieval and extension-session wide events", async () => {
      setupCatalog();
      const h = harness([]);
      createAgentMemoryExtension()(h.pi);
      h.exec.mockResolvedValue({
        code: 0,
        stdout: "[]",
        stderr: "",
        killed: false,
      });
      h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
      await settlePromptPreparation();
      await h.tools
        .get("memory_search")
        .execute(
          "call-observed",
          { query: "private-observability-query" },
          undefined,
          undefined,
          h.ctx,
        );
      await h.handlers.get("session_shutdown")!({ reason: "quit" }, h.ctx);

      const raw = readFileSync(
        join(testLogDir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
        "utf8",
      );
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>);
      expect(
        events.find(
          (event) =>
            event.operation === "memory.retrieval" &&
            event.correlation?.toolCallId === "call-observed",
        ),
      ).toMatchObject({
        correlation: {
          sessionId: "session-1",
          toolCallId: "call-observed",
        },
        retrieval: {
          kind: "search",
          candidates: 0,
          returned: 0,
        },
        outcome: { status: "success" },
      });
      expect(
        [...events]
          .reverse()
          .find(
            (event) =>
              event.operation === "memory.extension-session" &&
              event.correlation?.sessionId === "session-1",
          ),
      ).toMatchObject({
        correlation: { sessionId: "session-1" },
        session: { reason: "startup", shutdownReason: "quit" },
        outcome: { status: "success" },
      });
      expect(raw).not.toContain("private-observability-query");
    });

    it("recovers only canonical settled receipts and rejects malformed ones", async () => {
      const setup = setupCatalog();
      const { catalog } = setup;
      const identity: Omit<TurnReceipt, "receiptId"> = {
        version: 1,
        sessionId: "session-1",
        workspace: "/workspace",
        userEntryIds: ["u1"],
        assistantEntryIds: ["a1"],
        catalogSha256: catalogSha256(catalog),
        exposures: [],
        outcomes: [],
        redactions: {},
        recordedAt: "2026-01-01T00:00:04.000Z",
      };
      const receipt = {
        ...identity,
        receiptId: canonicalTurnReceiptId(identity),
      };
      const branch = [
        user("u1"),
        assistant("a1"),
        custom("r1", TURN_RECEIPT_ENTRY_TYPE, receipt),
        custom("bad-cp", CHECKPOINT_ENTRY_TYPE, {
          version: 2,
          sessionId: "session-1",
          throughLeafId: "a1",
          acceptedUserTurns: 2,
        }),
      ];
      const h = harness(branch);
      const wake = vi.fn();
      createAgentMemoryExtension({
        wake,
        preparePrompt: async () => preparedPrompt(setup),
        maintenanceIdleMs: 0,
      })(h.pi);
      h.handlers.get("session_start")!({}, h.ctx);
      expect(h.actions).toEqual([]);
      await settlePromptPreparation();
      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      h.handlers.get("agent_settled")!({}, h.ctx);
      expect(h.actions).toEqual([CHECKPOINT_ENTRY_TYPE]);
      expect(customData(branch.at(-1)!, CHECKPOINT_ENTRY_TYPE)).toEqual({
        version: 2,
        sessionId: "session-1",
        throughLeafId: "a1",
        acceptedUserTurns: 1,
      });
      expect(wake).toHaveBeenCalledOnce();
      h.handlers.get("agent_settled")!({}, h.ctx);
      expect(wake).toHaveBeenCalledOnce();

      const bad = harness([
        user("u1"),
        assistant("a1"),
        custom("r1", TURN_RECEIPT_ENTRY_TYPE, { version: 1 }),
      ]);
      createAgentMemoryExtension({
        wake: vi.fn(),
        preparePrompt: async () => preparedPrompt(setup),
      })(bad.pi);
      expect(() =>
        bad.handlers.get("session_start")!({}, bad.ctx),
      ).not.toThrow();
      await settlePromptPreparation();
      bad.handlers.get("before_agent_start")!(
        { systemPrompt: "base" },
        bad.ctx,
      );
      expect(() => bad.handlers.get("agent_settled")!({}, bad.ctx)).toThrow(
        "invalid turn receipt",
      );
    });

    it("isolates stale receipt observations during recovery consumption", async () => {
      const setup = setupCatalog();
      const { catalog, entry } = setup;
      const identity: Omit<TurnReceipt, "receiptId"> = {
        version: 1,
        sessionId: "session-1",
        workspace: "/workspace",
        userEntryIds: ["u1"],
        assistantEntryIds: ["a1"],
        catalogSha256: catalogSha256(catalog),
        exposures: [
          {
            kind: "opened",
            memoryId: entry.memoryId,
            artifactSha256: "0".repeat(64),
          },
        ],
        outcomes: [],
        redactions: {},
        recordedAt: "2026-01-01T00:00:04.000Z",
      };
      const branch = [
        user("u1"),
        assistant("a1"),
        custom("r1", TURN_RECEIPT_ENTRY_TYPE, {
          ...identity,
          receiptId: canonicalTurnReceiptId(identity),
        }),
      ];
      const h = harness(branch);
      createAgentMemoryExtension({
        wake: vi.fn(),
        preparePrompt: async () => preparedPrompt(setup),
      })(h.pi);
      expect(() =>
        h.handlers.get("session_start")!({ reason: "resume" }, h.ctx),
      ).not.toThrow();
      await settlePromptPreparation();
      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      h.handlers.get("agent_settled")!({}, h.ctx);
      expect(h.actions).toEqual([CHECKPOINT_ENTRY_TYPE]);
      expect(
        receiptEntries(branch, {
          nativeSessionId: "session-1",
          workspace: "/workspace",
          catalog,
        })[0]!.diagnostics,
      ).toEqual(["1 stale exposure metadata item(s)"]);
    });

    it("isolates malformed exposure metadata without dropping correlation", async () => {
      const setup = setupCatalog();
      const { catalog } = setup;
      const rawIdentity = {
        version: 1 as const,
        sessionId: "session-1",
        workspace: "/workspace",
        userEntryIds: ["u1"],
        assistantEntryIds: ["a1"],
        catalogSha256: catalogSha256(catalog),
        exposures: [{ kind: "opened", memoryId: 42 }],
        outcomes: [],
        redactions: {},
        recordedAt: "2026-01-01T00:00:04.000Z",
      };
      const branch = [
        user("u1"),
        assistant("a1"),
        custom("r1", TURN_RECEIPT_ENTRY_TYPE, {
          ...rawIdentity,
          receiptId: canonicalTurnReceiptId(
            rawIdentity as unknown as Omit<TurnReceipt, "receiptId">,
          ),
        }),
      ];
      const h = harness(branch);
      createAgentMemoryExtension({
        wake: vi.fn(),
        preparePrompt: async () => preparedPrompt(setup),
      })(h.pi);
      expect(() =>
        h.handlers.get("session_start")!({ reason: "resume" }, h.ctx),
      ).not.toThrow();
      await settlePromptPreparation();
      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      h.handlers.get("agent_settled")!({}, h.ctx);
      expect(h.actions).toEqual([CHECKPOINT_ENTRY_TYPE]);
      expect(
        receiptEntries(branch, {
          nativeSessionId: "session-1",
          workspace: "/workspace",
          catalog,
        })[0]!.diagnostics,
      ).toEqual(["1 malformed exposure metadata item(s)"]);
    });

    it("carries memory-open redaction counts into the turn receipt", () => {
      const { catalog, entry } = setupCatalog();
      const branch = [
        user("u1"),
        custom("i1", INJECTION_ENTRY_TYPE, {
          version: 1,
          userEntryId: "u1",
          catalogSha256: catalogSha256(catalog),
          refs: [],
        }),
        assistant("a1", [
          {
            type: "toolCall",
            id: "open",
            name: "memory_open",
            arguments: { memoryId: entry.memoryId },
          },
        ]),
        result("open-r", "open", "memory_open", {
          version: 1,
          refs: [ref(entry)],
          redactions: { "provider-token": 1, "secret-field": 2 },
        }),
      ];
      expect(
        buildTurnReceipt({
          branch,
          sessionId: "session-1",
          workspace: "/workspace",
          catalog,
          now: () => "2026-01-01T00:00:04.000Z",
        })!.redactions,
      ).toEqual({ "provider-token": 1, "secret-field": 2 });
    });

    it("rebases a fork after validated inherited receipts", async () => {
      const setup = setupCatalog();
      const { catalog, entry } = setup;
      const parentBase = [
        user("parent-u"),
        custom("parent-i", INJECTION_ENTRY_TYPE, {
          version: 1,
          userEntryId: "parent-u",
          catalogSha256: catalogSha256(catalog),
          refs: [ref(entry)],
        }),
        assistant("parent-a"),
      ];
      const parentReceipt = buildTurnReceipt({
        branch: parentBase,
        sessionId: "parent-session",
        workspace: "/workspace",
        catalog,
        now: () => "2026-01-01T00:00:04.000Z",
      })!;
      const branch = [
        ...parentBase,
        custom("parent-r", TURN_RECEIPT_ENTRY_TYPE, parentReceipt),
        custom("parent-c", CHECKPOINT_ENTRY_TYPE, {
          version: 2,
          sessionId: "parent-session",
          throughLeafId: "parent-a",
          acceptedUserTurns: 1,
        }),
      ];
      const h = harness(branch);
      const wake = vi.fn();
      createAgentMemoryExtension({
        wake,
        preparePrompt: async () => preparedPrompt(setup),
      })(h.pi);
      h.handlers.get("session_start")!({ reason: "fork" }, h.ctx);
      await settlePromptPreparation();
      expect(wake).not.toHaveBeenCalled();

      h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
      branch.push(user("child-u"));
      branch.push(assistant("child-a"));
      h.handlers.get("agent_settled")!({}, h.ctx);

      const child = branch
        .flatMap((entry) => {
          const data = customData(entry, TURN_RECEIPT_ENTRY_TYPE);
          return data === undefined ? [] : [parseTurnReceipt(data)];
        })
        .find((receipt) => receipt.sessionId === "session-1")!;
      expect(child.userEntryIds).toEqual(["child-u"]);
      expect(child.assistantEntryIds).toEqual(["child-a"]);
      expect(child.responseToReceiptId).toBeUndefined();
    });

    it("blocks generic read and grep before memory-root execution", () => {
      const { entry } = setupCatalog();
      const h = harness([]);
      createAgentMemoryExtension({ wake: vi.fn() })(h.pi);
      for (const [toolName, path] of [
        ["read", join(root, entry.path)],
        ["grep", root],
        ["grep", testDir],
      ] as const) {
        const blocked = h.handlers.get("tool_call")!(
          { toolCallId: `${toolName}-${path}`, toolName, input: { path } },
          h.ctx,
        );
        expect(blocked).toEqual({
          block: true,
          reason:
            "Generic read/grep cannot access the durable memory root. Use memory_open(memoryId) or memory_search(query).",
        });
      }
      expect(
        h.handlers.get("tool_call")!(
          {
            toolCallId: "outside",
            toolName: "read",
            input: { path: "/workspace/README.md" },
          },
          h.ctx,
        ),
      ).toBeUndefined();

      const { catalog } = setupCatalog();
      const receipt = buildTurnReceipt({
        branch: [
          user("u1"),
          custom("i1", INJECTION_ENTRY_TYPE, {
            version: 1,
            userEntryId: "u1",
            catalogSha256: catalogSha256(catalog),
            refs: [],
          }),
          assistant("a1", [
            {
              type: "toolCall",
              id: "failed-read",
              name: "read",
              arguments: { path: join(root, entry.path) },
            },
          ]),
          result("failed-result", "failed-read", "read", {}, true),
        ],
        sessionId: "session-1",
        workspace: "/workspace",
        catalog,
        now: () => "2026-01-01T00:00:04.000Z",
      })!;
      expect(receipt.exposures).toEqual([]);
      expect(receipt.outcomes[0]?.result).toBe("error");
    });

    it("redacts opened memory credentials and accounts for every family", async () => {
      const { entry } = setupCatalog(
        [
          "token sk-abcdefghijklmnop",
          "Authorization: Bearer abcdefghijklmnop",
          "X-Api-Key: header-secret-value",
          "password=hunter2",
          "cookie=session-cookie-value",
        ].join("\n"),
      );
      const h = harness([]);
      createAgentMemoryExtension()(h.pi);
      const output = await h.tools
        .get("memory_open")
        .execute("open", { memoryId: entry.memoryId });
      const text = output.content[0].text;
      expect(text).not.toContain("sk-abcdefghijklmnop");
      expect(text).not.toContain("abcdefghijklmnop");
      expect(text).not.toContain("header-secret-value");
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("session-cookie-value");
      expect(output.details.redactions["provider-token"]).toBe(1);
      expect(output.details.redactions.bearer).toBe(1);
      expect(output.details.redactions["secret-field"]).toBeGreaterThanOrEqual(
        3,
      );
    });

    it.runIf(
      existsSync(
        join(HOME, "commonplace/01_files/_utilities/agent-memories"),
      ) && existsSync(join(HOME, ".local/share/pi-memory/catalog.json")),
    )("maps a result from the real qmd index to its canonical artifact", () => {
      const temporaryRoot = root;
      const temporaryData = data;
      process.env.PI_MEMORY_ROOT = join(
        HOME,
        "commonplace/01_files/_utilities/agent-memories",
      );
      process.env.PI_MEMORY_DATA_DIR = join(HOME, ".local/share/pi-memory");
      try {
        const catalog = loadCatalog();
        const query = catalog.entries.find((entry) => !entry.legacy)!.title;
        const result = spawnSync(
          process.env.QMD_BIN || "qmd",
          [
            "search",
            "-c",
            "agent-memories",
            "--json",
            "--full",
            "--full-path",
            query,
            "-n",
            "10",
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(result.status).toBe(0);
        const rows: unknown = JSON.parse(result.stdout);
        expect(Array.isArray(rows)).toBe(true);
        expect(
          (rows as unknown[]).some(
            (row) => object(row) && qmdCatalogEntry(catalog, row) !== undefined,
          ),
        ).toBe(true);
      } finally {
        process.env.PI_MEMORY_ROOT = temporaryRoot;
        process.env.PI_MEMORY_DATA_DIR = temporaryData;
      }
    });

    it("coalesces detached maintenance wakes", () => {
      const children: ChildProcess[] = [];
      const spawnProcess = vi.fn(() => {
        const child = new EventEmitter() as ChildProcess;
        child.unref = vi.fn();
        children.push(child);
        return child;
      }) as unknown as typeof spawn;
      wakeMemoryMaintenance(spawnProcess);
      wakeMemoryMaintenance(spawnProcess);
      expect(spawnProcess).toHaveBeenCalledOnce();
      children[0]!.emit("exit", 0, null);
      expect(spawnProcess).toHaveBeenCalledTimes(2);
    });
  });
}
