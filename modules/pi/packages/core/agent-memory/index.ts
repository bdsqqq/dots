import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  auditResumeCommand,
  auditSessionDir,
  listAuditSessions,
  modelConfig,
  prepareAuditInvocation,
  type AuditKind,
  type ModelConfig,
} from "./audit.js";
import { clearConfigCache, getExtensionConfigWithSchema } from "@bds_pi/config";
import {
  renderPromptCatalog,
  scanCatalog,
  sha256,
  writeCatalog,
  type Catalog,
  type MemoryConfig,
} from "./catalog.js";
import {
  applyMemoryProposal,
  findProposal,
  listProposals,
  migrateV1,
  recoverTransactions,
  reconcileRollbackAdaptationEvents,
  reviewProposal,
  rollbackReview,
  saveProposal,
  submitManualProposal,
} from "./workflow.js";
import {
  renderMemory,
  REVIEW_REASON_CODES,
  type ReviewReasonCode,
} from "./schema.js";
import {
  diffHistory,
  initHistory,
  isHistoryInitialized,
  listHistory,
  repairHistory,
  showHistory,
  syncHistory,
  verifyHistory,
} from "./history.js";
import { buildSafeEvidence, redact, type SafeEvidence } from "./evidence.js";
import {
  canonicalTurnReceiptId,
  parseTurnReceiptObservation,
  TURN_RECEIPT_ENTRY_TYPE,
  validateTurnReceiptBinding,
} from "./receipt.js";
import {
  parseStoredPipelineInput,
  processPipelineBatches,
  reflectionAutonomyState,
} from "./pipeline.js";
import {
  buildAdaptationPrompt,
  collectTurnObservations,
  deduplicateTurnObservations,
  findShadowAdaptation,
  markShadowAdaptationLedger,
  parseAdaptationDecisions,
  promoteShadowAdaptation,
  publishShadowAdaptation,
  verifiedRollbackEvidence,
  turnObservationMatchesRefs,
  validateTurnObservationRefs,
  type TurnObservation,
} from "./adaptation.js";
import {
  analyzeCorpusMaintenance,
  assertFreshMaintenanceBasis,
  maintenanceProposals,
  scanCorpusHealth,
} from "./maintenance.js";
import {
  claimMaintenanceEvent,
  completeMaintenanceEvent,
  enqueueMaintenanceEvent,
  failMaintenanceEvent,
  listMaintenanceEvents,
  recoverMaintenanceEvents,
  retryMaintenanceEvent,
} from "./events.js";
import {
  adaptationEvaluationMetrics,
  evalReport,
  exportEvalDataset,
  FEEDBACK_REASON_CODES,
  gradeTierReplayAutomatically,
  gradeReplay,
  memoryMetrics,
  recordMemoryFeedback,
  replayDataset,
  retrievalBenchmark,
  tierShipGate,
  tierRetrievalComparison,
  tierAutomaticRollbackReasons,
  tierCanaryEvidence,
  tierCanaryGate,
  type ReplayMode,
  type FeedbackReasonCode,
} from "./evaluation.js";
import { createWideEvent, flushLogs } from "@bds_pi/log";
import {
  attachMemoryOperationError,
  observeMemoryOperation,
} from "./observability.js";
import {
  compareTierCodePoints,
  advanceTierCanaryPercent,
  commitTierTransition,
  commitAutonomousTierDecision,
  decideAutonomousTierTransition,
  deriveTierState,
  parseTierClassifierOutput,
  parseTierCriticOutput,
  publishTierManifest,
  planTierTransition,
  rollbackTierManifest,
  setTierAutonomy,
  selectSystemSet,
  SYSTEM_PROMPT_MAX_MEMORIES,
  tierAutonomyEnabled,
  tierCanaryBaseline,
  tierCanaryPercent,
  tierStateDigest,
  tierStatus,
  resetTierCanaryPercent,
  tierTargetKey,
  type TierAssignment,
  type TierClassifierOutput,
} from "./tiering.js";

process.umask(0o077);

export { renderPromptCatalog } from "./catalog.js";
export * from "./events.js";
export * from "./tiering.js";

type Entry = {
  type: string;
  id: string;
  parentId: string | null;
  [key: string]: unknown;
};
type Header = {
  type: "session";
  id: string;
  cwd: string;
  [key: string]: unknown;
};
type Snapshot = {
  source: string;
  header: Header;
  entries: Entry[];
  chains: Entry[][];
};
type Job = {
  version: 1;
  sessionId: string;
  checkpointEntryId: string;
  sourcePath: string;
  projectionPath: string;
  workspace: string;
};

const HOME = homedir();
const envPath = (name: string, fallback: string): string =>
  resolve((process.env[name] || fallback).replace(/^~(?=$|\/)/, HOME));
type PiMemoryExtConfig = { sessionsDirs: string[] };
const PI_MEMORY_CONFIG_DEFAULTS: PiMemoryExtConfig = {
  sessionsDirs: [join(HOME, ".pi/agent/sessions")],
};
const isPiMemoryExtConfig = (
  value: Record<string, unknown>,
): value is PiMemoryExtConfig =>
  Array.isArray(value.sessionsDirs) &&
  value.sessionsDirs.length > 0 &&
  value.sessionsDirs.every(
    (sessionsDir) =>
      typeof sessionsDir === "string" && sessionsDir.trim().length > 0,
  );
const config = (): MemoryConfig & { sessions: string[] } => {
  const configured = getExtensionConfigWithSchema(
    "@bds_pi/pi-memory",
    PI_MEMORY_CONFIG_DEFAULTS,
    { schema: { validate: isPiMemoryExtConfig } },
  );
  const sessions = process.env.PI_CODING_AGENT_SESSION_DIR
    ? [envPath("PI_CODING_AGENT_SESSION_DIR", "")]
    : configured.sessionsDirs.map((sessionsDir) =>
        resolve(sessionsDir.replace(/^~(?=$|\/)/, HOME)),
      );
  return {
    sessions: [...new Set(sessions)],
    state: envPath("PI_MEMORY_STATE_DIR", join(HOME, ".local/state/pi-memory")),
    data: envPath("PI_MEMORY_DATA_DIR", join(HOME, ".local/share/pi-memory")),
    root: envPath(
      "PI_MEMORY_ROOT",
      join(HOME, "commonplace/01_files/_utilities/agent-memories"),
    ),
    skillsRoot: envPath(
      "PI_MEMORY_SKILLS_ROOT",
      join(HOME, "commonplace/01_files/nix/modules/agents/skills"),
    ),
  };
};
const MAX_SOURCE = 128 * 1024 * 1024;
const MAX_PROJECTION = 64 * 1024;
const CONSOLIDATION_SKIP_RECEIPT_VERSION = 2;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contained(root: string, target: string): string {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`path escapes ${rootPath}`);
  return targetPath;
}

function secureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomic(path: string, value: string): void {
  secureDir(dirname(path));
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.tmp`,
  );
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, value);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function walkJsonl(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = contained(root, join(root, item.name));
    if (item.isDirectory()) found.push(...walkJsonl(path));
    else if (item.isFile() && item.name.endsWith(".jsonl")) found.push(path);
  }
  return found.sort();
}

function parseStableSnapshot(source: string): Snapshot {
  const before = statSync(source);
  if (before.size > MAX_SOURCE) throw new Error("source exceeds size cap");
  const raw = readFileSync(source, "utf8");
  const after = statSync(source);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino
  )
    throw new Error("unstable read");
  const records: unknown[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      if (i === lines.length - 1 && !raw.endsWith("\n"))
        throw new Error("incomplete final jsonl record");
      throw new Error(`malformed jsonl line ${i + 1}`);
    }
  }
  const first = records[0];
  if (
    !object(first) ||
    first.type !== "session" ||
    typeof first.id !== "string" ||
    !first.id ||
    typeof first.cwd !== "string"
  )
    throw new Error("invalid session header");
  if (
    records
      .slice(1)
      .some((record) => object(record) && record.type === "session")
  )
    throw new Error("duplicate session header");
  const entries: Entry[] = [];
  const byId = new Map<string, Entry>();
  for (const record of records.slice(1)) {
    if (
      !object(record) ||
      typeof record.type !== "string" ||
      typeof record.id !== "string" ||
      !(record.parentId === null || typeof record.parentId === "string")
    )
      throw new Error("invalid entry shape");
    const entry = record as Entry;
    if (byId.has(entry.id)) throw new Error(`duplicate entry ${entry.id}`);
    byId.set(entry.id, entry);
    entries.push(entry);
  }
  for (const entry of entries)
    if (entry.parentId !== null && !byId.has(entry.parentId))
      throw new Error(`dangling parent ${entry.parentId}`);
  for (const entry of entries) {
    const seen = new Set<string>();
    let current: Entry | undefined = entry;
    while (current) {
      if (seen.has(current.id)) throw new Error(`cycle at ${current.id}`);
      seen.add(current.id);
      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  const parentIds = new Set(
    entries
      .map((entry) => entry.parentId)
      .filter((id): id is string => id !== null),
  );
  const leaves = entries
    .filter((entry) => !parentIds.has(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const chains = leaves.map((leaf) => {
    const seen = new Set<string>();
    const chain: Entry[] = [];
    let current: Entry | undefined = leaf;
    while (current) {
      if (seen.has(current.id)) throw new Error(`cycle at ${current.id}`);
      seen.add(current.id);
      chain.unshift(current);
      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return chain;
  });
  if (entries.length > 0 && chains.length === 0)
    throw new Error("cyclic graph");
  return { source, header: first as Header, entries, chains };
}

function customData(
  entry: Entry,
  customType: string,
): Record<string, unknown> | undefined {
  if (
    entry.type !== "custom" ||
    entry.customType !== customType ||
    !object(entry.data)
  )
    return undefined;
  return entry.data;
}

type Checkpoint = {
  version: 2;
  sessionId: string;
  throughLeafId: string;
  acceptedUserTurns: number;
};

function checkpoint(entry: Entry): Checkpoint | undefined {
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
    ? (data as Checkpoint)
    : undefined;
}

function acceptedUserTurns(entries: Entry[], throughLeafId: string): number {
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

function visible(entry: Entry): string {
  if (entry.type !== "message" || !object(entry.message)) return "";
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return "";
  const content = entry.message.content;
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
  return text.trim() ? `### ${role}\n\n${text.trim()}` : "";
}

function latestSummary(
  chain: Entry[],
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

export function renderSnapshot(
  snapshot: Snapshot,
  observationCatalog?: Catalog,
): {
  markdown: string;
  jobs: Job[];
} {
  for (const entry of snapshot.entries) {
    const data = customData(entry, TURN_RECEIPT_ENTRY_TYPE);
    if (data === undefined) continue;
    const observed = parseTurnReceiptObservation(data);
    const stale = observationCatalog
      ? observed.receipt.exposures.filter(
          (exposure) =>
            !observationCatalog.entries.some(
              (candidate) =>
                candidate.memoryId === exposure.memoryId &&
                candidate.sha256 === exposure.artifactSha256,
            ),
        ).length
      : 0;
    const malformed = observed.diagnostics.reduce(
      (sum, diagnostic) => sum + diagnostic.count,
      0,
    );
    if (malformed || stale)
      console.warn(
        `${snapshot.source}:${entry.id}: ignored ${malformed} malformed and ${stale} stale receipt exposure(s)`,
      );
  }
  const sections: string[] = [
    `# pi session ${snapshot.header.id}`,
    `workspace: ${snapshot.header.cwd}`,
  ];
  const jobs = new Map<string, Job>();
  for (const chain of snapshot.chains) {
    // Turn receipts are correlation observations, not evidence authentication.
    // Projection derives evidence from messages and admits checkpoints by their
    // native session origin and branch count, never by exposure claims.
    for (const entry of chain) {
      const data = customData(entry, TURN_RECEIPT_ENTRY_TYPE);
      if (data !== undefined) {
        const receipt = parseTurnReceiptObservation(data).receipt;
        validateTurnReceiptBinding(chain, entry.id, receipt, {
          sessionId: receipt.sessionId,
          workspace: receipt.workspace,
        });
      }
    }
    const leaf = chain.at(-1);
    if (!leaf) continue;
    let name = "";
    for (const entry of chain)
      if (entry.type === "session_info" && typeof entry.name === "string")
        name = entry.name;
    const checkpointEntries = chain.filter((entry, index) => {
      const data = checkpoint(entry);
      return (
        data !== undefined &&
        data.sessionId === snapshot.header.id &&
        chain
          .slice(0, index)
          .some((candidate) => candidate.id === data.throughLeafId) &&
        data.acceptedUserTurns === acceptedUserTurns(chain, data.throughLeafId)
      );
    });
    const checkpointEntry = checkpointEntries.at(-1);
    const through = checkpointEntry
      ? String(checkpoint(checkpointEntry)?.throughLeafId)
      : leaf.id;
    const throughIndex = chain.findIndex((entry) => entry.id === through);
    const summary = latestSummary(chain, through);
    const bounded = chain.slice((summary?.index ?? -1) + 1, throughIndex + 1);
    const heading = `## branch ${leaf.id}${name ? ` — ${name}` : ""}`;
    const rendered = [
      heading,
      summary ? `### summary\n\n${String(summary.data.summary)}` : "",
      ...bounded.map(visible).filter(Boolean),
    ]
      .filter(Boolean)
      .join("\n\n");
    sections.push(rendered);
    for (const checkpointEntry of checkpointEntries)
      jobs.set(checkpointEntry.id, {
        version: 1,
        sessionId: snapshot.header.id,
        checkpointEntryId: checkpointEntry.id,
        sourcePath: snapshot.source,
        projectionPath: "",
        workspace: snapshot.header.cwd,
      });
  }
  let markdown = `${sections.join("\n\n")}\n`;
  if (Buffer.byteLength(markdown) > MAX_PROJECTION) {
    const prefix = `${sections.slice(0, 2).join("\n\n")}\n\n[earlier authored text truncated]\n\n`;
    const available = MAX_PROJECTION - Buffer.byteLength(prefix) - 1;
    const suffix = Buffer.from(sections.slice(2).join("\n\n"))
      .subarray(-available)
      .toString("utf8");
    markdown = `${prefix}${suffix}\n`;
  }
  return { markdown, jobs: [...jobs.values()] };
}

async function lock<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  const { state } = config();
  secureDir(state);
  const path = contained(state, join(state, "mutating.lock"));
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = 0;
    try {
      owner = Number(readFileSync(join(path, "owner"), "utf8"));
    } catch {}
    if (owner > 0) {
      try {
        process.kill(owner, 0);
        retryMaintenanceWakeIfPresent(state);
        return undefined;
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== "ESRCH") {
          retryMaintenanceWakeIfPresent(state);
          return undefined;
        }
      }
    } else if (Date.now() - statSync(path).mtimeMs < 60_000) {
      retryMaintenanceWakeIfPresent(state);
      return undefined;
    }
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { mode: 0o700 });
  }
  writeFileSync(join(path, "owner"), `${process.pid}\n`, { mode: 0o600 });
  const acquiredAt = Date.now();
  try {
    return await observeMemoryOperation(
      {
        operation: "memory.mutation-lock",
        result: () => ({ fields: { holdMs: Date.now() - acquiredAt } }),
      },
      fn,
    );
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function projectUnlockedUnobserved(): void {
  const cfg = config();
  const observationCatalog = scanCatalog(cfg.root);
  const projectionDir = contained(cfg.data, join(cfg.data, "pi-sessions"));
  const pending = contained(cfg.data, join(cfg.data, "queue/pending"));
  const quarantine = contained(cfg.data, join(cfg.data, "quarantine"));
  [cfg.state, cfg.data, projectionDir, pending, quarantine].forEach(secureDir);
  const sources = [
    ...new Set(
      // Amp sessions are untrusted checkpoint-v2 ingress and pass through the
      // same parser, quarantine, and evidence validation as native sessions.
      [...cfg.sessions, join(cfg.data, "amp-sessions")].flatMap(walkJsonl),
    ),
  ];
  const claimedSessions = new Map<string, { source: string; digest: string }>();
  for (const source of sources) {
    try {
      const snapshot = parseStableSnapshot(source);
      const digest = createHash("sha256")
        .update(JSON.stringify([snapshot.header, snapshot.entries]))
        .digest("hex");
      const claimed = claimedSessions.get(snapshot.header.id);
      if (claimed) {
        if (claimed.digest === digest) continue;
        throw new Error(
          `session id ${snapshot.header.id} conflicts with ${claimed.source}`,
        );
      }
      claimedSessions.set(snapshot.header.id, { source, digest });
      const output = contained(
        projectionDir,
        join(projectionDir, `${snapshot.header.id}.md`),
      );
      const rendered = renderSnapshot(snapshot, observationCatalog);
      atomic(output, rendered.markdown);
      for (const job of rendered.jobs) {
        job.projectionPath = output;
        const target = contained(
          pending,
          join(pending, `${job.sessionId}--${job.checkpointEntryId}.json`),
        );
        const done = contained(
          cfg.data,
          join(cfg.data, `queue/processed/${basename(target)}`),
        );
        const failed = contained(
          cfg.data,
          join(cfg.data, `queue/failed/${basename(target)}`),
        );
        if (!existsSync(done) && !existsSync(failed)) {
          if (!existsSync(target)) atomic(target, `${JSON.stringify(job)}\n`);
          enqueueMaintenanceEvent(cfg, {
            kind: "checkpoint-ready",
            cause: `${job.sessionId}:${job.checkpointEntryId}`,
            basis: {
              sessionId: job.sessionId,
              checkpointEntryId: job.checkpointEntryId,
              workspace: job.workspace,
            },
          });
        }
      }
    } catch (error) {
      const id = createHash("sha256").update(source).digest("hex").slice(0, 16);
      atomic(
        join(quarantine, `${id}.json`),
        `${JSON.stringify({ source, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
      console.error(
        `${source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function projectUnlocked(): void {
  return observeMemoryOperation(
    { operation: "memory.checkpoint-job-publication" },
    projectUnlockedUnobserved,
  );
}

function isJob(value: unknown): value is Job {
  return (
    object(value) &&
    value.version === 1 &&
    [
      "sessionId",
      "checkpointEntryId",
      "sourcePath",
      "projectionPath",
      "workspace",
    ].every((key) => typeof value[key] === "string")
  );
}

function runAsync(
  command: string,
  args: string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: HOME,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const append = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        child.kill("SIGTERM");
        finish(new Error(`${command} output exceeded 1 MiB`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.stdin.on("error", (error) => finish(error));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0)
        finish(
          undefined,
          Buffer.concat(stdout)
            .toString("utf8")
            .slice(0, 256 * 1024),
        );
      else
        finish(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              `${command} exited ${code}`,
          ),
        );
    });
    const timer = setTimeout(
      () => {
        child.kill("SIGTERM");
        finish(new Error(`${command} timed out`));
      },
      Number(process.env.PI_MEMORY_COMMAND_TIMEOUT_MS || 120_000),
    );
    child.stdin.end(input);
  });
}

function run(
  binary: string,
  args: string[],
  input?: string,
  timeout = Number(process.env.PI_MEMORY_COMMAND_TIMEOUT_MS || 120_000),
): string {
  const result = spawnSync(binary, args, {
    cwd: HOME,
    input,
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error || result.status !== 0)
    throw (
      result.error ||
      new Error(
        `${binary} exited ${result.status}: ${result.stderr.slice(0, 2000)}`,
      )
    );
  return result.stdout.slice(0, 256 * 1024);
}

function auditedArgs(options: {
  cfg: ReturnType<typeof config>;
  kind: AuditKind;
  identity: string;
  prompt: string;
  model: ModelConfig;
  runId?: string;
  eventId?: string;
}) {
  return prepareAuditInvocation({
    data: options.cfg.data,
    kind: options.kind,
    identity: options.identity,
    prompt: options.prompt,
    model: options.model.model,
    reasoning: options.model.reasoning,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.eventId ? { eventId: options.eventId } : {}),
  });
}

async function runAuditedAsync(
  options: Parameters<typeof auditedArgs>[0],
): Promise<string> {
  const observation = createWideEvent({
    service: "pi-memory",
    operation: "memory.model-invocation",
    correlation: {
      identity: options.identity,
      runId: options.runId,
      eventId: options.eventId,
    },
    fields: {
      model: {
        kind: options.kind,
        name: options.model.model,
        reasoning: options.model.reasoning,
        promptChars: options.prompt.length,
      },
    },
  });
  try {
    const audit = auditedArgs(options);
    if (audit.recoveredOutput !== undefined) {
      observation.finish("success", {
        model: {
          recovered: true,
          outputChars: audit.recoveredOutput.length,
        },
      });
      return audit.recoveredOutput;
    }
    await runAsync(process.env.PI_BIN || "pi", audit.args, options.prompt);
    const output = audit.complete().output;
    observation.finish("success", {
      model: { recovered: false, outputChars: output.length },
    });
    return output;
  } catch (error) {
    attachMemoryOperationError(observation, error);
    observation.finish("failure");
    throw error;
  }
}

function runAudited(options: Parameters<typeof auditedArgs>[0]): string {
  const observation = createWideEvent({
    service: "pi-memory",
    operation: "memory.model-invocation",
    correlation: {
      identity: options.identity,
      runId: options.runId,
      eventId: options.eventId,
    },
    fields: {
      model: {
        kind: options.kind,
        name: options.model.model,
        reasoning: options.model.reasoning,
        promptChars: options.prompt.length,
      },
    },
  });
  try {
    const audit = auditedArgs(options);
    if (audit.recoveredOutput !== undefined) {
      observation.finish("success", {
        model: {
          recovered: true,
          outputChars: audit.recoveredOutput.length,
        },
      });
      return audit.recoveredOutput;
    }
    run(process.env.PI_BIN || "pi", audit.args, options.prompt);
    const output = audit.complete().output;
    observation.finish("success", {
      model: { recovered: false, outputChars: output.length },
    });
    return output;
  } catch (error) {
    attachMemoryOperationError(observation, error);
    observation.finish("failure");
    throw error;
  }
}

function parseAction(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw.trim());
  if (!object(value) || (value.action !== "create" && value.action !== "skip"))
    throw new Error("model returned invalid action");
  if (value.action === "skip") return { action: "skip" };
  if (
    typeof value.title !== "string" ||
    value.title.length < 1 ||
    value.title.length > 120 ||
    !["preference", "decision", "gotcha", "pattern"].includes(
      String(value.kind),
    ) ||
    !Array.isArray(value.triggers) ||
    value.triggers.length > 20 ||
    !value.triggers.every((x) => typeof x === "string") ||
    !value.triggers.every((x) => x.length > 0 && x.length <= 200) ||
    !Array.isArray(value.keywords) ||
    value.keywords.length > 30 ||
    !value.keywords.every((x) => typeof x === "string") ||
    !value.keywords.every((x) => x.length > 0 && x.length <= 100) ||
    typeof value.body !== "string" ||
    value.body.length < 1 ||
    value.body.length > 8_000
  )
    throw new Error("model returned invalid candidate");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "action,body,keywords,kind,title,triggers")
    throw new Error("model returned extra fields");
  return value;
}

type Candidate = {
  title: string;
  kind: string;
  scope: string;
  triggers: string[];
  keywords: string[];
  source: string;
  created: string;
  updated: string;
  body: string;
};

function parseCandidate(text: string): Candidate {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]+)$/.exec(text);
  if (!match) throw new Error("invalid candidate frontmatter");
  const metadata = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!field || metadata.has(field[1]!))
      throw new Error("invalid candidate metadata");
    metadata.set(field[1]!, field[2]!);
  }
  const expected = [
    "created",
    "keywords",
    "kind",
    "scope",
    "source",
    "status",
    "title",
    "triggers",
    "updated",
    "version",
  ];
  if ([...metadata.keys()].sort().join(",") !== expected.join(","))
    throw new Error("invalid candidate fields");
  let title: unknown;
  let scope: unknown;
  let triggers: unknown;
  let keywords: unknown;
  try {
    title = JSON.parse(metadata.get("title")!);
    scope = JSON.parse(metadata.get("scope")!);
    triggers = JSON.parse(metadata.get("triggers")!);
    keywords = JSON.parse(metadata.get("keywords")!);
  } catch {
    throw new Error("invalid candidate metadata json");
  }
  const source = metadata.get("source")!;
  const created = metadata.get("created")!;
  const updated = metadata.get("updated")!;
  const body = match[2]!.trim();
  parseAction(
    JSON.stringify({
      action: "create",
      title,
      kind: metadata.get("kind"),
      triggers,
      keywords,
      body,
    }),
  );
  if (
    metadata.get("version") !== "1" ||
    metadata.get("status") !== "candidate" ||
    typeof scope !== "string" ||
    scope.length < 1 ||
    scope.length > 500 ||
    !/^pi:\/\/[^/]+\/[^/]+$/.test(source) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(created) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(updated)
  )
    throw new Error("invalid candidate values");
  return {
    title: title as string,
    kind: metadata.get("kind")!,
    scope,
    triggers: triggers as string[],
    keywords: keywords as string[],
    source,
    created,
    updated,
    body,
  };
}

function validateReceipt(path: string, jobId: string): void {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "action,createdAt,jobId,version" ||
    (value.version !== 1 &&
      value.version !== CONSOLIDATION_SKIP_RECEIPT_VERSION) ||
    value.action !== "skip" ||
    value.jobId !== jobId ||
    typeof value.createdAt !== "string"
  )
    throw new Error("invalid skip receipt");
}

function scopeFor(workspace: string): string {
  const resolved = resolve(workspace);
  if (resolved === HOME) return "global";
  return resolved.startsWith(`${HOME}${sep}`)
    ? relative(HOME, resolved).split(sep).join("/")
    : "unknown";
}

function validateJob(job: Job): string {
  const snapshot = parseStableSnapshot(job.sourcePath);
  if (
    snapshot.header.id !== job.sessionId ||
    snapshot.header.cwd !== job.workspace
  )
    throw new Error("job source/header mismatch");
  const chain = snapshot.chains.find((item) =>
    item.some((entry) => entry.id === job.checkpointEntryId),
  );
  const entry = chain?.find((item) => item.id === job.checkpointEntryId);
  if (
    !chain ||
    !entry ||
    !checkpoint(entry) ||
    !chain
      .slice(
        0,
        chain.findIndex((item) => item.id === entry.id),
      )
      .some((item) => item.id === checkpoint(entry)?.throughLeafId)
  )
    throw new Error("checkpoint is not on branch ancestry");
  const checkpointIndex = chain.findIndex(
    (item) => item.id === job.checkpointEntryId,
  );
  const exactChain = chain.slice(0, checkpointIndex + 1);
  const rendered = renderSnapshot(
    {
      ...snapshot,
      entries: exactChain,
      chains: [exactChain],
    },
    scanCatalog(config().root),
  );
  if (
    !rendered.jobs.some((candidate) => candidate.checkpointEntryId === entry.id)
  )
    throw new Error("checkpoint is not linked to a valid turn receipt");
  return rendered.markdown.slice(0, MAX_PROJECTION);
}

function consolidateV1Unlocked(limit: number): boolean {
  const cfg = config();
  const dirs = {
    pending: join(cfg.data, "queue/pending"),
    processing: join(cfg.data, "queue/processing"),
    processed: join(cfg.data, "queue/processed"),
    failed: join(cfg.data, "queue/failed"),
    candidates: join(cfg.data, "candidates"),
    receipts: join(cfg.data, "receipts"),
  };
  Object.values(dirs).forEach(secureDir);
  for (const name of readdirSync(dirs.processing))
    if (
      statSync(join(dirs.processing, name)).mtimeMs <
      Date.now() - 15 * 60_000
    )
      renameSync(join(dirs.processing, name), join(dirs.pending, name));
  let externalFailure = false;
  for (const name of readdirSync(dirs.pending)
    .filter((x) => x.endsWith(".json"))
    .sort()
    .slice(0, limit)) {
    const processing = join(dirs.processing, name);
    renameSync(join(dirs.pending, name), processing);
    let externalStarted = false;
    try {
      const parsed: unknown = JSON.parse(readFileSync(processing, "utf8"));
      if (!isJob(parsed)) throw new Error("invalid job schema");
      const job = parsed;
      const key = basename(name, ".json");
      const candidatePath = join(dirs.candidates, `${key}.md`);
      const receiptPath = join(dirs.receipts, `${key}.json`);
      if (existsSync(candidatePath) && existsSync(receiptPath))
        throw new Error("candidate and skip receipt both exist");
      if (existsSync(candidatePath)) {
        const candidate = parseCandidate(readFileSync(candidatePath, "utf8"));
        if (
          candidate.source !== `pi://${job.sessionId}/${job.checkpointEntryId}`
        )
          throw new Error("candidate source does not match job");
      } else if (existsSync(receiptPath)) validateReceipt(receiptPath, key);
      else {
        const projection = validateJob(job);
        externalStarted = true;
        const qmd = process.env.QMD_BIN || "qmd";
        const search =
          process.env.PI_MEMORY_SKIP_EXTERNAL === "1"
            ? "[]"
            : run(qmd, [
                "search",
                "-c",
                "agent-memories",
                "--json",
                `${job.workspace} ${projection.slice(-1000)}`,
              ]).slice(0, 32_000);
        const prompt = `return exactly one json object. create only durable memory; otherwise skip. create schema: {"action":"create","title":"","kind":"preference|decision|gotcha|pattern","triggers":[],"keywords":[],"body":""}. skip schema: {"action":"skip"}.\n\nsession:\n${projection.slice(-48_000)}\n\nexisting bounded search:\n${search}`;
        const response =
          process.env.PI_MEMORY_SKIP_EXTERNAL === "1"
            ? '{"action":"skip"}'
            : runAudited({
                cfg,
                kind: "reflection",
                identity: key,
                prompt,
                model: modelConfig(),
                runId: key,
              });
        const action = parseAction(response);
        const now = new Date().toISOString();
        if (action.action === "skip")
          atomic(
            receiptPath,
            `${JSON.stringify({ version: CONSOLIDATION_SKIP_RECEIPT_VERSION, action: "skip", jobId: key, createdAt: now })}\n`,
          );
        else
          atomic(
            candidatePath,
            `---\nversion: 1\nstatus: candidate\ntitle: ${JSON.stringify(action.title)}\nkind: ${String(action.kind)}\nscope: ${JSON.stringify(scopeFor(job.workspace))}\ntriggers: ${JSON.stringify(action.triggers)}\nkeywords: ${JSON.stringify(action.keywords)}\nsource: pi://${job.sessionId}/${job.checkpointEntryId}\ncreated: ${now.slice(0, 10)}\nupdated: ${now.slice(0, 10)}\n---\n\n${String(action.body)}\n`,
          );
      }
      renameSync(processing, join(dirs.processed, name));
    } catch (error) {
      console.error(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (externalStarted) {
        externalFailure = true;
        renameSync(processing, join(dirs.pending, name));
      } else renameSync(processing, join(dirs.failed, name));
    }
  }
  return !externalFailure;
}

type PendingWindow = {
  evidence: SafeEvidence;
  observations: TurnObservation[];
  jobs: Array<{ job: Job; name: string }>;
};

function finalizeQueuedJobUnobserved(
  cfg: ReturnType<typeof config>,
  name: string,
  destination: "processed" | "failed",
): void {
  const source = join(cfg.data, "queue/pending", name);
  const targetDir = join(cfg.data, `queue/${destination}`);
  secureDir(targetDir);
  const target = join(targetDir, name);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") !== readFileSync(source, "utf8"))
      throw new Error(`queue destination collision ${name}`);
    rmSync(source);
  } else renameSync(source, target);
}

function finalizeQueuedJob(
  cfg: ReturnType<typeof config>,
  name: string,
  destination: "processed" | "failed",
): void {
  return observeMemoryOperation(
    {
      operation: "memory.checkpoint-job-transition",
      fields: { checkpointJob: { status: destination } },
    },
    () => finalizeQueuedJobUnobserved(cfg, name, destination),
  );
}

function failCheckpointEvent(cfg: ReturnType<typeof config>, job: Job): void {
  const ids = listMaintenanceEvents(cfg, ["pending"])
    .filter(
      ({ event }) =>
        event.kind === "checkpoint-ready" &&
        event.basis.sessionId === job.sessionId &&
        event.basis.checkpointEntryId === job.checkpointEntryId,
    )
    .map(({ event }) => event.id);
  for (const id of ids) {
    const event = claimMaintenanceEvent(cfg, {
      kinds: ["checkpoint-ready"],
      ids: [id],
    });
    if (event) failMaintenanceEvent(cfg, event.id, event.claimToken!);
  }
}

function trustedCheckpointFrontier(
  cfg: ReturnType<typeof config>,
  sessionId: string,
  checkpointEntryId: string,
  chain: Entry[],
): number | undefined {
  const path = contained(
    join(cfg.data, "v2/ledger"),
    join(cfg.data, "v2/ledger", `${sessionId}--${checkpointEntryId}.json`),
  );
  if (!existsSync(path)) return undefined;
  const ledger = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  if (
    ledger.version !== 2 ||
    typeof ledger.runId !== "string" ||
    typeof ledger.throughLeafId !== "string" ||
    typeof ledger.branchDigest !== "string"
  )
    throw new Error(`invalid checkpoint ledger ${checkpointEntryId}`);
  const input = JSON.parse(
    readFileSync(
      contained(
        join(cfg.data, "v2/runs"),
        join(cfg.data, "v2/runs", ledger.runId, "input.json"),
      ),
      "utf8",
    ),
  ) as { version?: unknown; evidence?: SafeEvidence[] };
  const frozen = input.evidence?.find(
    (item) =>
      item.window.sessionId === sessionId &&
      item.window.checkpointEntryIds.includes(checkpointEntryId),
  );
  const legacyV2 =
    input.version === 2 &&
    frozen?.checkpointFrontiers === undefined &&
    frozen?.emittedEntryIds === undefined;
  const frozenFrontier =
    frozen?.checkpointFrontiers?.[checkpointEntryId] ??
    (legacyV2 ? frozen?.window.throughLeafId : undefined);
  if (
    !frozen ||
    frozen.window.branchDigest !== ledger.branchDigest ||
    frozenFrontier !== ledger.throughLeafId ||
    (!legacyV2 && !frozen.emittedEntryIds?.includes(ledger.throughLeafId))
  )
    throw new Error(`inconsistent checkpoint ledger ${checkpointEntryId}`);
  const frontier = chain.findIndex(
    (entry) => entry.id === ledger.throughLeafId,
  );
  const marker = chain.findIndex((entry) => entry.id === checkpointEntryId);
  if (frontier < 0 || marker < 0 || frontier >= marker)
    throw new Error(
      `checkpoint ledger frontier is not on ancestry ${checkpointEntryId}`,
    );
  return frontier;
}

function pendingWindows(limit: number): PendingWindow[] {
  const cfg = config();
  const pending = join(cfg.data, "queue/pending");
  if (!existsSync(pending)) return [];
  const items: Array<{
    job: Job;
    name: string;
    chain: Entry[];
    checkpointIndex: number;
  }> = [];
  for (const name of readdirSync(pending)
    .filter((item) => item.endsWith(".json"))
    .sort()) {
    try {
      const value: unknown = JSON.parse(
        readFileSync(join(pending, name), "utf8"),
      );
      if (!isJob(value)) throw new Error(`invalid job schema ${name}`);
      const ledger = join(
        cfg.data,
        "v2/ledger",
        `${value.sessionId}--${value.checkpointEntryId}.json`,
      );
      if (existsSync(ledger)) {
        finalizeQueuedJob(cfg, name, "processed");
        continue;
      }
      const snapshot = parseStableSnapshot(value.sourcePath);
      if (
        snapshot.header.id !== value.sessionId ||
        snapshot.header.cwd !== value.workspace
      )
        throw new Error(`job source/header mismatch ${name}`);
      const chain = snapshot.chains.find((candidate) =>
        candidate.some((entry) => entry.id === value.checkpointEntryId),
      );
      const checkpointIndex =
        chain?.findIndex((entry) => entry.id === value.checkpointEntryId) ?? -1;
      const cp =
        chain && checkpointIndex >= 0
          ? checkpoint(chain[checkpointIndex]!)
          : undefined;
      const throughIndex = cp
        ? chain!.findIndex((entry) => entry.id === cp.throughLeafId)
        : -1;
      let trustedStart = 0;
      let monotonicFrontier = 0;
      if (chain)
        for (let index = 0; index < checkpointIndex; index++) {
          const entry = chain[index]!;
          const prior = checkpoint(entry);
          if (!prior) continue;
          const trusted = trustedCheckpointFrontier(
            cfg,
            value.sessionId,
            entry.id,
            chain,
          );
          if (trusted !== undefined)
            trustedStart = Math.max(trustedStart, trusted + 1);
          const priorFrontier = chain.findIndex(
            (candidate) => candidate.id === prior.throughLeafId,
          );
          if (priorFrontier >= monotonicFrontier && priorFrontier < index)
            monotonicFrontier = priorFrontier;
        }
      if (
        !chain ||
        checkpointIndex < 0 ||
        !cp ||
        throughIndex < trustedStart ||
        throughIndex < monotonicFrontier ||
        throughIndex >= checkpointIndex
      )
        throw new Error(`invalid checkpoint ancestry ${name}`);
      items.push({ job: value, name, chain, checkpointIndex });
    } catch (error) {
      console.error(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      let failedJob: unknown;
      try {
        failedJob = JSON.parse(readFileSync(join(pending, name), "utf8"));
      } catch {}
      if (isJob(failedJob)) failCheckpointEvent(cfg, failedJob);
      finalizeQueuedJob(cfg, name, "failed");
    }
  }
  const maxima = items
    .filter(
      (item) =>
        !items.some(
          (other) =>
            other !== item &&
            other.job.sessionId === item.job.sessionId &&
            other.chain
              .slice(0, other.checkpointIndex + 1)
              .some((entry) => entry.id === item.job.checkpointEntryId),
        ),
    )
    .sort((a, b) =>
      `${a.job.workspace}:${a.job.sessionId}:${a.job.checkpointEntryId}`.localeCompare(
        `${b.job.workspace}:${b.job.sessionId}:${b.job.checkpointEntryId}`,
      ),
    );
  const assigned = new Set<string>();
  const windows: PendingWindow[] = [];
  for (const maximum of maxima) {
    if (windows.length >= limit) break;
    const ancestry = new Set(
      maximum.chain
        .slice(0, maximum.checkpointIndex + 1)
        .map((entry) => entry.id),
    );
    const maximumCheckpoint = checkpoint(
      maximum.chain[maximum.checkpointIndex]!,
    )!;
    const maximumThroughIndex = maximum.chain.findIndex(
      (entry) => entry.id === maximumCheckpoint.throughLeafId,
    );
    const covered = items.filter((item) => {
      const frontier = checkpoint(
        item.chain[item.checkpointIndex]!,
      )?.throughLeafId;
      const frontierIndex = frontier
        ? maximum.chain.findIndex((entry) => entry.id === frontier)
        : -1;
      return (
        item.job.sessionId === maximum.job.sessionId &&
        ancestry.has(item.job.checkpointEntryId) &&
        frontierIndex >= 0 &&
        frontierIndex <= maximumThroughIndex &&
        !assigned.has(`${item.job.sessionId}--${item.job.checkpointEntryId}`)
      );
    });
    if (!covered.some((item) => item === maximum)) continue;
    covered.forEach((item) =>
      assigned.add(`${item.job.sessionId}--${item.job.checkpointEntryId}`),
    );
    let start = 0;
    for (let index = 0; index < maximum.checkpointIndex; index++) {
      const entry = maximum.chain[index]!;
      if (!checkpoint(entry)) continue;
      const frontier = trustedCheckpointFrontier(
        cfg,
        maximum.job.sessionId,
        entry.id,
        maximum.chain,
      );
      if (frontier !== undefined) start = Math.max(start, frontier + 1);
    }
    const cp = checkpoint(maximum.chain[maximum.checkpointIndex]!)!;
    const throughLeafId = String(cp.throughLeafId);
    const throughIndex = maximum.chain.findIndex(
      (entry) => entry.id === throughLeafId,
    );
    if (throughIndex < start)
      throw new Error(`checkpoint leaf precedes window ${maximum.name}`);
    const observationCatalog = scanCatalog(cfg.root);
    windows.push({
      evidence: buildSafeEvidence({
        sessionId: maximum.job.sessionId,
        workspace: maximum.job.workspace,
        entries: maximum.chain.slice(start, throughIndex + 1),
        checkpointEntryIds: covered.map((item) => item.job.checkpointEntryId),
        checkpointFrontiers: Object.fromEntries(
          covered.map((item) => [
            item.job.checkpointEntryId,
            String(
              checkpoint(item.chain[item.checkpointIndex]!)!.throughLeafId,
            ),
          ]),
        ),
        throughLeafId,
        branchEntryIds: maximum.chain
          .slice(0, throughIndex + 1)
          .map((entry) => entry.id),
      }),
      observations: collectTurnObservations({
        entries: maximum.chain,
        start,
        end: throughIndex,
        receiptEnd: maximum.checkpointIndex - 1,
        sessionId: maximum.job.sessionId,
        workspace: maximum.job.workspace,
        catalog: observationCatalog,
      }),
      jobs: covered.map(({ job, name }) => ({ job, name })),
    });
  }
  const seenObservations = new Set<string>();
  for (const window of windows)
    window.observations = window.observations.filter((observation) => {
      if (seenObservations.has(observation.evidenceId)) return false;
      seenObservations.add(observation.evidenceId);
      return true;
    });
  return windows;
}

function batchWindows(windows: PendingWindow[]): PendingWindow[][] {
  const batches: PendingWindow[][] = [];
  for (const window of windows) {
    const workspace = window.jobs[0]!.job.workspace;
    const sessionId = window.jobs[0]!.job.sessionId;
    const batch = batches.find(
      (candidate) =>
        candidate.length < 5 &&
        candidate[0]!.jobs[0]!.job.workspace === workspace &&
        candidate.every((item) => item.jobs[0]!.job.sessionId !== sessionId),
    );
    if (batch) batch.push(window);
    else batches.push([window]);
  }
  return batches;
}

const MAX_MAINTENANCE_EVENT_ATTEMPTS = 3;

function checkpointEventIds(
  cfg: ReturnType<typeof config>,
  windows: PendingWindow[],
): string[] {
  const checkpoints = new Set(
    windows.flatMap((window) =>
      window.jobs.map(
        ({ job }) => `${job.sessionId}--${job.checkpointEntryId}`,
      ),
    ),
  );
  return listMaintenanceEvents(cfg, ["pending"])
    .filter(
      ({ event }) =>
        event.kind === "checkpoint-ready" &&
        typeof event.basis.sessionId === "string" &&
        typeof event.basis.checkpointEntryId === "string" &&
        checkpoints.has(
          `${event.basis.sessionId}--${event.basis.checkpointEntryId}`,
        ),
    )
    .map(({ event }) => event.id);
}

function settleCheckpointClaimsUnobserved(
  cfg: ReturnType<typeof config>,
  claims: NonNullable<ReturnType<typeof claimMaintenanceEvent>>[],
  outcome: "complete" | "error",
): void {
  for (const event of claims) {
    const covered =
      typeof event.basis.sessionId === "string" &&
      typeof event.basis.checkpointEntryId === "string" &&
      existsSync(
        join(
          cfg.data,
          "v2/ledger",
          `${event.basis.sessionId}--${event.basis.checkpointEntryId}.json`,
        ),
      );
    if (outcome === "complete" || covered)
      completeMaintenanceEvent(cfg, event.id, event.claimToken!);
    else if (event.attempt >= MAX_MAINTENANCE_EVENT_ATTEMPTS) {
      failMaintenanceEvent(cfg, event.id, event.claimToken!);
      const pending = join(cfg.data, "queue/pending");
      if (existsSync(pending))
        for (const name of readdirSync(pending).filter((item) =>
          item.endsWith(".json"),
        )) {
          let value: unknown;
          try {
            value = JSON.parse(readFileSync(join(pending, name), "utf8"));
          } catch {
            continue;
          }
          if (
            isJob(value) &&
            value.sessionId === event.basis.sessionId &&
            value.checkpointEntryId === event.basis.checkpointEntryId
          )
            finalizeQueuedJob(cfg, name, "failed");
        }
    } else retryMaintenanceEvent(cfg, event.id, event.claimToken!);
  }
}

function settleCheckpointClaims(
  cfg: ReturnType<typeof config>,
  claims: NonNullable<ReturnType<typeof claimMaintenanceEvent>>[],
  outcome: "complete" | "error",
): void {
  return observeMemoryOperation(
    {
      operation: "memory.checkpoint-settlement",
      fields: { checkpoint: { claimCount: claims.length, status: outcome } },
    },
    () => settleCheckpointClaimsUnobserved(cfg, claims, outcome),
  );
}

function reconcileCoveredCheckpointEvents(
  cfg: ReturnType<typeof config>,
): void {
  const ids = listMaintenanceEvents(cfg, ["pending"])
    .filter(
      ({ event }) =>
        event.kind === "checkpoint-ready" &&
        typeof event.basis.sessionId === "string" &&
        typeof event.basis.checkpointEntryId === "string" &&
        existsSync(
          join(
            cfg.data,
            "v2/ledger",
            `${event.basis.sessionId}--${event.basis.checkpointEntryId}.json`,
          ),
        ),
    )
    .map(({ event }) => event.id);
  for (;;) {
    const event = claimMaintenanceEvent(cfg, {
      kinds: ["checkpoint-ready"],
      ids,
    });
    if (!event) return;
    completeMaintenanceEvent(cfg, event.id, event.claimToken!);
  }
}

function reconcileFailedCheckpointJobs(cfg: ReturnType<typeof config>): void {
  const failed = listMaintenanceEvents(cfg, ["failed"])
    .filter(
      ({ event }) =>
        event.kind === "checkpoint-ready" &&
        typeof event.basis.sessionId === "string" &&
        typeof event.basis.checkpointEntryId === "string",
    )
    .map(({ event }) => ({
      sessionId: event.basis.sessionId,
      checkpointEntryId: event.basis.checkpointEntryId,
    }));
  if (failed.length === 0) return;
  const pending = join(cfg.data, "queue/pending");
  if (!existsSync(pending)) return;
  for (const name of readdirSync(pending).filter((item) =>
    item.endsWith(".json"),
  )) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(pending, name), "utf8"));
    } catch {
      continue;
    }
    if (
      isJob(value) &&
      failed.some(
        (event) =>
          event.sessionId === value.sessionId &&
          event.checkpointEntryId === value.checkpointEntryId,
      )
    )
      finalizeQueuedJob(cfg, name, "failed");
  }
}

async function consolidateV2Unlocked(limit: number): Promise<boolean> {
  const cfg = config();
  const observation = createWideEvent({
    service: "pi-memory",
    operation: "memory.consolidation",
    fields: { consolidation: { limit } },
  });
  try {
    const result = await consolidateV2UnlockedObserved(limit, cfg, observation);
    observation.finish(result ? "success" : "degraded");
    return result;
  } catch (error) {
    attachMemoryOperationError(observation, error);
    observation.finish("failure");
    throw error;
  }
}

async function consolidateV2UnlockedObserved(
  limit: number,
  cfg: ReturnType<typeof config>,
  observation: ReturnType<typeof createWideEvent>,
): Promise<boolean> {
  let ok = true;
  const autonomous = listProposals(cfg, "memory").filter(
    (item) => item.provenance.autonomous === true,
  );
  const applied: string[] = [];
  const deferred: string[] = [];
  const localReview: string[] = [];
  for (const proposal of autonomous)
    try {
      if (/^[a-f0-9]{64}$/.test(proposal.provenance.runId)) {
        const autonomy = reflectionAutonomyState(
          cfg,
          proposal.provenance.runId,
          proposal.id,
        );
        if (autonomy !== "allowed") {
          localReview.push(proposal.id);
          continue;
        }
      }
      applyMemoryProposal({
        cfg,
        id: proposal.id,
        actor: "background-reflection",
      });
      applied.push(proposal.id);
    } catch (error) {
      ok = false;
      deferred.push(proposal.id);
      console.error(
        `autonomous memory application deferred for ${proposal.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  observation.set({
    proposalApplication: {
      pending: autonomous.length,
      applied,
      deferred,
      localReview,
    },
  });
  const batches = batchWindows(pendingWindows(limit));
  observation.set({
    consolidation: {
      batches: batches.length,
      windows: batches.flat().length,
      checkpoints: batches
        .flat()
        .reduce(
          (count, window) =>
            count + window.evidence.window.checkpointEntryIds.length,
          0,
        ),
      externalProcessing: process.env.PI_MEMORY_SKIP_EXTERNAL !== "1",
    },
  });
  if (process.env.PI_MEMORY_SKIP_EXTERNAL === "1") return ok;
  const claims = checkpointEventIds(cfg, batches.flat())
    .map((id) =>
      claimMaintenanceEvent(cfg, { kinds: ["checkpoint-ready"], ids: [id] }),
    )
    .filter((event): event is NonNullable<typeof event> => event !== null);
  const configuredModel = modelConfig();
  try {
    const results = await processPipelineBatches(
      batches.map((batch) => ({
        cfg,
        scope: scopeFor(batch[0]!.jobs[0]!.job.workspace),
        evidence: batch.map((window) => window.evidence),
        observations: deduplicateTurnObservations(
          batch.flatMap((window) => window.observations),
        ),
        model: configuredModel.model,
        reasoning: configuredModel.reasoning,
        skipExternal: process.env.PI_MEMORY_SKIP_EXTERNAL === "1",
        invoke: (prompt, input) =>
          runAuditedAsync({
            cfg,
            kind: "reflection",
            identity: input.runId,
            prompt,
            model: {
              model: input.model ?? configuredModel.model,
              reasoning: input.reasoning ?? configuredModel.reasoning,
            },
            runId: input.runId,
          }),
        criticInvoke: (prompt, input) =>
          runAuditedAsync({
            cfg,
            kind: "reflection-critic",
            identity: input.runId,
            prompt,
            model: {
              model: input.model,
              reasoning: input.reasoning,
            },
            runId: input.runId,
          }),
      })),
    );
    observation.set({
      reflection: {
        claims: claims.map((claim) => claim.id),
        runs: results.map((result) => ({
          runId: result.runId,
          action: result.action,
          proposalIds: result.proposalIds,
          checkpoints: result.coveredCheckpointIds.length,
        })),
      },
    });
    for (const batch of batches)
      for (const window of batch)
        for (const { name } of window.jobs)
          finalizeQueuedJob(cfg, name, "processed");
    settleCheckpointClaims(cfg, claims, "complete");
  } catch (error) {
    settleCheckpointClaims(cfg, claims, "error");
    ok = false;
    attachMemoryOperationError(observation, error);
    observation.set({
      reflection: {
        claims: claims.map((claim) => claim.id),
        status: "failed",
      },
    });
    console.error(error instanceof Error ? error.message : String(error));
  }
  return ok;
}

async function consolidateUnlocked(limit: number): Promise<boolean> {
  return process.env.PI_MEMORY_PIPELINE_VERSION === "1"
    ? consolidateV1Unlocked(limit)
    : await consolidateV2Unlocked(limit);
}

function reconcile(): void {
  const cfg = config();
  secureDir(cfg.data);
  const files = existsSync(cfg.root)
    ? readdirSync(cfg.root)
        .filter(
          (name) => name.endsWith(".md") && name.includes("source__agent"),
        )
        .sort()
    : [];
  const records = files.map((name) => {
    const text = readFileSync(
      contained(cfg.root, join(cfg.root, name)),
      "utf8",
    );
    const title = (
      /^title:\s*(.+)$/im.exec(text)?.[1] ||
      /^#\s+(.+)$/m.exec(text)?.[1] ||
      basename(name, ".md")
    )
      .trim()
      .replace(/^['"]|['"]$/g, "");
    const metadata = Object.fromEntries(
      ["title", "kind", "scope", "source", "created", "updated"].map((key) => [
        key,
        new RegExp(`^${key}:`, "im").test(text),
      ]),
    );
    return {
      file: name,
      title,
      normalizedTitle: title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim(),
      scope: /^scope:\s*(.+)$/im.exec(text)?.[1]?.trim() || "unknown",
      metadata,
    };
  });
  const duplicates = [
    ...new Set(
      records
        .map((record) => record.normalizedTitle)
        .filter(
          (title) =>
            records.filter((record) => record.normalizedTitle === title)
              .length > 1,
        ),
    ),
  ]
    .sort()
    .map((title) => ({
      title,
      files: records
        .filter((record) => record.normalizedTitle === title)
        .map((record) => record.file),
    }));
  atomic(
    join(cfg.data, "reconcile-report.json"),
    `${JSON.stringify({ version: 1, duplicates, memories: records }, null, 2)}\n`,
  );
  writeCatalog(cfg);
}

function finalizeHistorySync(
  cfg: MemoryConfig,
  sync: ReturnType<typeof syncHistory>,
): boolean {
  if (!sync.fastForwarded) return true;
  writeCatalog(cfg);
  if (process.env.PI_MEMORY_SKIP_EXTERNAL === "1") return true;
  try {
    run(process.env.QMD_BIN || "qmd", ["update"]);
    run(
      process.env.QMD_BIN || "qmd",
      ["embed", "-c", "agent-memories"],
      undefined,
      Number(process.env.PI_MEMORY_EMBED_TIMEOUT_MS || 15 * 60_000),
    );
    return true;
  } catch {
    return false;
  }
}

function applyDeterministicMaintenanceUnobserved(
  cfg: ReturnType<typeof config>,
) {
  let health = scanCorpusHealth(cfg);
  for (let cycle = 0; cycle < 100; cycle++) {
    const proposals = maintenanceProposals(health);
    if (proposals.length === 0) {
      enqueueMaintenanceEvent(cfg, {
        kind: "corpus-changed",
        cause: health.catalogSha256,
        basis: {
          catalogSha256: health.catalogSha256,
          ...(health.historyCommit
            ? { historyCommit: health.historyCommit }
            : {}),
        },
      });
      return health;
    }
    for (const proposal of proposals) {
      saveProposal(cfg, proposal);
      applyMemoryProposal({
        cfg,
        id: proposal.id,
        actor: "background-reflection",
      });
    }
    health = scanCorpusHealth(cfg);
  }
  throw new Error("deterministic corpus maintenance did not converge");
}

function applyDeterministicMaintenance(cfg: ReturnType<typeof config>) {
  return observeMemoryOperation(
    {
      operation: "memory.deterministic-maintenance",
      result: (report) => ({
        fields: { maintenance: { pathologyCount: report.pathologies.length } },
      }),
    },
    () => applyDeterministicMaintenanceUnobserved(cfg),
  );
}

function adaptationObservations(
  cfg: ReturnType<typeof config>,
  affectedRefs: Array<{ memoryId: string; artifactSha256: string }>,
): TurnObservation[] {
  const root = join(cfg.data, "v2/runs");
  if (!existsSync(root)) return [];
  const observations = readdirSync(root)
    .sort()
    .flatMap((name) => {
      const path = join(root, name, "input.json");
      if (!existsSync(path)) return [];
      const input = parseStoredPipelineInput(readFileSync(path, "utf8"));
      if (input.version === 2) return [];
      for (const observation of input.observations)
        validateTurnObservationRefs(observation, input.catalog);
      return input.observations;
    })
    .filter((observation) =>
      turnObservationMatchesRefs(observation, affectedRefs),
    );
  return [
    ...new Map(observations.map((item) => [item.evidenceId, item])).values(),
  ].slice(-100);
}

async function processAdaptationEventsUnobserved(
  cfg: ReturnType<typeof config>,
): Promise<boolean> {
  let ok = true;
  for (;;) {
    const event = claimMaintenanceEvent(cfg, { kinds: ["adaptation-ready"] });
    if (!event) return ok;
    try {
      let shadow = findShadowAdaptation(cfg, event.id);
      if (!shadow) {
        const basis = event.basis;
        if (
          typeof basis.historyCommit !== "string" ||
          typeof basis.mutationId !== "string" ||
          typeof basis.reviewId !== "string" ||
          typeof basis.proposalId !== "string"
        )
          throw new Error("invalid adaptation event basis");
        const rollback = verifiedRollbackEvidence(cfg, {
          historyCommit: basis.historyCommit,
          mutationId: basis.mutationId,
          reviewId: basis.reviewId,
          proposalId: basis.proposalId,
        });
        let tierDemoted = false;
        const tierCatalog = scanCatalog(cfg.root);
        const tierState = deriveTierState(cfg, tierCatalog);
        for (const condemned of rollback.condemnedRefs) {
          const assignment = tierState.get(
            tierTargetKey({
              memoryId: condemned.memoryId,
              path: condemned.path,
              artifactSha256: condemned.artifactSha256,
            }),
          );
          if (!assignment || assignment.tier !== "system") continue;
          const classifier: TierClassifierOutput = {
            version: 1,
            target: {
              memoryId: assignment.memoryId,
              path: assignment.path,
              artifactSha256: assignment.artifactSha256,
            },
            action: "demote",
            hierarchy: assignment.hierarchy,
            proposedScope: "project",
            durability: "durable",
            risk: "clear",
            evidenceIds: [rollback.evidenceId],
            evidenceSessionIds: [],
          };
          const result = commitAutonomousTierDecision({
            cfg,
            classifier,
            critic: {
              version: 1,
              target: classifier.target,
              agrees: true,
              entailed: true,
              scopeValid: true,
              riskClear: true,
              evidenceIds: [rollback.evidenceId],
            },
            signals: {
              artifactScope: "project",
              confidenceLowerBound: 1,
              explicitDurableUserStatement: false,
              verifiedCorrection: false,
              condemnedRollback: true,
              evaluationPassed: false,
              availableEvidenceSessionIds: [],
            },
            decidedAt: new Date().toISOString(),
          });
          if (result.status === "committed") tierDemoted = true;
        }
        if (tierDemoted || rollback.condemnedRefs.length > 0)
          publishTierManifest({ cfg, createdAt: new Date().toISOString() });
        const evidence = [
          ...adaptationObservations(cfg, rollback.affectedRefs),
          rollback,
        ];
        const catalog = scanCatalog(cfg.root);
        const configuredModel = modelConfig();
        const raw =
          process.env.PI_MEMORY_SKIP_EXTERNAL === "1"
            ? JSON.stringify({
                version: 2,
                decisions: [
                  {
                    action: "no-op",
                    evidenceIds: [rollback.evidenceId],
                    reason: "external processing disabled",
                  },
                ],
              })
            : await runAuditedAsync({
                cfg,
                kind: "adaptation",
                identity: event.id,
                prompt: buildAdaptationPrompt(cfg, catalog, evidence),
                model: configuredModel,
                eventId: event.id,
              });
        const decisions = parseAdaptationDecisions(raw, catalog, evidence);
        shadow = publishShadowAdaptation({
          cfg,
          eventId: event.id,
          model: configuredModel.model,
          reasoning: configuredModel.reasoning,
          createdAt: event.createdAt,
          catalog,
          evidence,
          decisions,
        });
      }
      promoteShadowAdaptation(cfg, shadow);
      markShadowAdaptationLedger(cfg, event.id, shadow.id);
      completeMaintenanceEvent(cfg, event.id, event.claimToken!);
    } catch (error) {
      if (event.attempt >= MAX_MAINTENANCE_EVENT_ATTEMPTS)
        failMaintenanceEvent(cfg, event.id, event.claimToken!);
      else retryMaintenanceEvent(cfg, event.id, event.claimToken!);
      ok = false;
      console.error(
        `adaptation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function processAdaptationEvents(
  cfg: ReturnType<typeof config>,
): Promise<boolean> {
  return observeMemoryOperation(
    {
      operation: "memory.adaptation-processing",
      result: (value) => ({
        outcome: value ? "success" : "degraded",
      }),
    },
    () => processAdaptationEventsUnobserved(cfg),
  );
}

export function combineMaintenanceResults(
  current: boolean,
  next: boolean,
): boolean {
  return current && next;
}

function enqueueTieringReady(cfg: ReturnType<typeof config>, cursor = 0): void {
  const catalog = scanCatalog(cfg.root);
  const state = deriveTierState(cfg, catalog);
  const catalogSha256 = sha256(JSON.stringify(catalog.entries));
  const stateSha256 = tierStateDigest(state);
  enqueueMaintenanceEvent(cfg, {
    kind: "tiering-ready",
    cause: `${catalogSha256}:${stateSha256}:${cursor}`,
    basis: { catalogSha256, stateSha256, cursor },
  });
}

function tierArtifact(
  cfg: ReturnType<typeof config>,
  assignment: TierAssignment,
): { text: string; body: string; sourceSessions: string[] } {
  const path = contained(cfg.root, join(cfg.root, assignment.path));
  const text = readFileSync(path, "utf8");
  if (sha256(text) !== assignment.artifactSha256)
    throw new Error("tier artifact changed after catalog scan");
  const frontmatter = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(text);
  if (!frontmatter) throw new Error("tier artifact has no frontmatter");
  const sourceSessions = [
    ...new Set(
      [...frontmatter[0].matchAll(/pi:\/\/([A-Za-z0-9_-]{1,200})/g)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();
  return { text, body: text.slice(frontmatter[0].length), sourceSessions };
}

function tierClassifierPrompt(
  assignment: TierAssignment,
  entry: ReturnType<typeof scanCatalog>["entries"][number],
  artifact: ReturnType<typeof tierArtifact>,
): string {
  return [
    "Classify one durable memory for autonomous prompt placement.",
    "Return ONLY strict JSON with: version=1, target, action (promote|demote|quarantine|abstain), hierarchy, proposedScope (project|global), durability (durable|situational), risk (clear|secret|prompt-integrity|harmful), evidenceIds, evidenceSessionIds.",
    "Use only the supplied source sessions. Never broaden project scope to global. Abstain when evidence is insufficient.",
    JSON.stringify({
      target: {
        memoryId: assignment.memoryId,
        path: assignment.path,
        artifactSha256: assignment.artifactSha256,
      },
      current: {
        tier: assignment.tier,
        rollout: assignment.rollout,
        hierarchy: assignment.hierarchy,
      },
      metadata: {
        title: entry.title,
        kind: entry.kind,
        scope: entry.scope,
        description: entry.description,
        sourceSessions: artifact.sourceSessions,
      },
      body: artifact.body,
    }),
  ].join("\n\n");
}

function tierCriticPrompt(
  classifier: TierClassifierOutput,
  artifact: ReturnType<typeof tierArtifact>,
): string {
  return [
    "Independently criticize this memory tier classification.",
    "Return ONLY strict JSON with: version=1, target, agrees, entailed, scopeValid, riskClear, evidenceIds.",
    "Evidence IDs must be copied from the classifier; do not invent evidence. Reject unsupported scope or unsafe prompt content.",
    JSON.stringify({ classifier, body: artifact.body }),
  ].join("\n\n");
}

function deterministicTierRisk(
  artifact: ReturnType<typeof tierArtifact>,
): TierClassifierOutput["risk"] {
  if (Object.values(redact(artifact.text).counts).some((count) => count > 0))
    return "secret";
  const compact = artifact.body
    .normalize("NFKC")
    .replace(/[\s\p{Cf}\p{Z}]+/gu, "")
    .toLowerCase();
  if (
    /ignore(?:all|any)?(?:previous|prior|system)instructions/.test(compact) ||
    /(?:reveal|print|repeat)(?:the)?systemprompt/.test(compact) ||
    /<\/?(?:system|assistant|tool)/.test(compact) ||
    /(?:bypass|disable)(?:safety|policy|approval)/.test(compact) ||
    /exfiltrat|conceal(?:the)?action/.test(compact) ||
    /(?:send|upload|publish|delete|deploy|purchase|email|message).{0,40}without(?:asking|approval)/.test(
      compact,
    )
  )
    return "prompt-integrity";
  return "clear";
}

function tierHasExplicitUserStatement(
  cfg: ReturnType<typeof config>,
  memoryId: string,
): boolean {
  return listHistory(cfg, { limit: 1_000 }).some(
    ({ receipt }) =>
      receipt.changes.some((change) => change.memoryId === memoryId) &&
      object(receipt.provenance) &&
      receipt.provenance.reviewer === "remember-skill",
  );
}

async function processTieringEvents(
  cfg: ReturnType<typeof config>,
  budget: { remaining: number; assignments: number } = {
    remaining: 1,
    assignments: 0,
  },
): Promise<boolean> {
  if (!tierAutonomyEnabled(cfg) || process.env.PI_MEMORY_SKIP_EXTERNAL === "1")
    return true;
  let ok = true;
  for (;;) {
    if (budget.remaining <= 0) return ok;
    const event = claimMaintenanceEvent(cfg, { kinds: ["tiering-ready"] });
    if (!event) return ok;
    budget.remaining -= 1;
    try {
      const catalog = scanCatalog(cfg.root);
      const state = deriveTierState(cfg, catalog);
      if (
        event.basis.catalogSha256 !== sha256(JSON.stringify(catalog.entries)) ||
        event.basis.stateSha256 !== tierStateDigest(state)
      ) {
        completeMaintenanceEvent(cfg, event.id, event.claimToken!);
        enqueueTieringReady(cfg);
        continue;
      }
      const cursor =
        typeof event.basis.cursor === "number" &&
        Number.isSafeInteger(event.basis.cursor) &&
        event.basis.cursor >= 0
          ? event.basis.cursor
          : 0;
      const limit = Math.max(
        1,
        Math.min(10, Number(process.env.PI_MEMORY_TIER_BATCH_SIZE || 3)),
      );
      const assignments = [...state.values()]
        .filter((assignment) => !assignment.quarantined)
        .sort((left, right) =>
          compareTierCodePoints(tierTargetKey(left), tierTargetKey(right)),
        );
      const batch = assignments.slice(cursor, cursor + limit);
      budget.assignments += batch.length;
      const configuredModel = modelConfig();
      let changed = false;
      for (const assignment of batch) {
        const entry = catalog.entries.find(
          (candidate) =>
            candidate.memoryId === assignment.memoryId &&
            candidate.path === assignment.path &&
            candidate.sha256 === assignment.artifactSha256,
        );
        if (!entry) throw new Error("tier assignment left current catalog");
        const artifact = tierArtifact(cfg, assignment);
        const deterministicRisk = deterministicTierRisk(artifact);
        if (deterministicRisk !== "clear") {
          const classifier: TierClassifierOutput = {
            version: 1,
            target: {
              memoryId: assignment.memoryId,
              path: assignment.path,
              artifactSha256: assignment.artifactSha256,
            },
            action: "quarantine",
            hierarchy: assignment.hierarchy,
            proposedScope: entry.scope === "global" ? "global" : "project",
            durability: "durable",
            risk: deterministicRisk,
            evidenceIds: [],
            evidenceSessionIds: [],
          };
          const result = commitAutonomousTierDecision({
            cfg,
            classifier,
            critic: {
              version: 1,
              target: classifier.target,
              agrees: true,
              entailed: true,
              scopeValid: true,
              riskClear: false,
              evidenceIds: [],
            },
            signals: {
              artifactScope: entry.scope === "global" ? "global" : "project",
              confidenceLowerBound: 1,
              explicitDurableUserStatement: false,
              verifiedCorrection: false,
              condemnedRollback: false,
              evaluationPassed: false,
              availableEvidenceSessionIds: artifact.sourceSessions,
            },
            decidedAt: new Date().toISOString(),
          });
          if (result.status === "committed") changed = true;
          continue;
        }
        const classifier = parseTierClassifierOutput(
          await runAuditedAsync({
            cfg,
            kind: "tier-classifier",
            identity: `${event.id}:${assignment.memoryId}`,
            prompt: tierClassifierPrompt(assignment, entry, artifact),
            model: configuredModel,
            eventId: event.id,
          }),
        );
        const allowedSessions = new Set(artifact.sourceSessions);
        if (
          classifier.evidenceSessionIds.some(
            (sessionId) => !allowedSessions.has(sessionId),
          )
        )
          throw new Error("tier classifier invented a source session");
        const critic = parseTierCriticOutput(
          await runAuditedAsync({
            cfg,
            kind: "tier-critic",
            identity: `${event.id}:${assignment.memoryId}`,
            prompt: tierCriticPrompt(classifier, artifact),
            model: configuredModel,
            eventId: event.id,
          }),
        );
        const classifierEvidence = new Set(classifier.evidenceIds);
        if (
          critic.evidenceIds.some(
            (evidenceId) => !classifierEvidence.has(evidenceId),
          )
        )
          throw new Error("tier critic invented evidence");
        const evidenceSessions = new Set(classifier.evidenceSessionIds).size;
        const agreement =
          critic.agrees &&
          critic.entailed &&
          critic.scopeValid &&
          critic.riskClear;
        const explicitDurableUserStatement = tierHasExplicitUserStatement(
          cfg,
          assignment.memoryId,
        );
        const confidenceLowerBound = agreement
          ? evidenceSessions >= 3 ||
            (explicitDurableUserStatement && entry.scope === "global")
            ? 0.98
            : evidenceSessions >= 2 || explicitDurableUserStatement
              ? 0.95
              : 0.9
          : 0;
        const exposure = tierCanaryEvidence(cfg, assignment);
        const signals = {
          artifactScope:
            entry.scope === "global"
              ? ("global" as const)
              : ("project" as const),
          confidenceLowerBound,
          utilityLowerBound:
            exposure.relevantTurns > 0
              ? exposure.usefulFeedback / exposure.relevantTurns
              : undefined,
          relevantOpportunities: exposure.relevantTurns,
          explicitDurableUserStatement,
          verifiedCorrection: exposure.harmfulFeedback > 0,
          condemnedRollback: false,
          evaluationPassed: false,
          availableEvidenceSessionIds: artifact.sourceSessions,
        };
        const currentState = deriveTierState(cfg);
        const currentAssignment = currentState.get(tierTargetKey(assignment));
        if (!currentAssignment)
          throw new Error("tier assignment changed during governance");
        const governed = decideAutonomousTierTransition({
          current: currentAssignment,
          classifier,
          critic,
          signals,
        });
        let result:
          | { status: "abstained"; reasonCode: string }
          | { status: "committed"; reasonCode: string };
        if (
          governed.reasonCode === "qualified-canary" &&
          [...currentState.values()].filter((item) => item.tier === "system")
            .length >= SYSTEM_PROMPT_MAX_MEMORIES
        ) {
          const candidates = [...currentState.values()]
            .filter((item) => item.tier === "system")
            .map((item) => {
              const currentArtifact = tierArtifact(cfg, item);
              return {
                target: {
                  memoryId: item.memoryId,
                  path: item.path,
                  artifactSha256: item.artifactSha256,
                },
                hierarchy: item.hierarchy,
                body: currentArtifact.body,
                score: 0.5,
                rollout: item.rollout,
                redaction: item.redaction,
                promptIntegrity: item.promptIntegrity,
              };
            });
          candidates.push({
            target: classifier.target,
            hierarchy: classifier.hierarchy,
            body: artifact.body,
            score: confidenceLowerBound,
            rollout: "canary",
            redaction: "clear",
            promptIntegrity: "trusted",
          });
          const decidedAt = new Date().toISOString();
          const selection = selectSystemSet({
            cfg,
            candidates,
            now: decidedAt,
          });
          if (
            selection.selected.some(
              (candidate) =>
                tierTargetKey(candidate.target) ===
                tierTargetKey(classifier.target),
            )
          ) {
            commitTierTransition({
              cfg,
              plan: planTierTransition({
                cfg,
                selection,
                decidedAt,
                reason: "autonomous-qualified-canary",
              }),
            });
            result = {
              status: "committed",
              reasonCode: "qualified-canary",
            };
          } else
            result = {
              status: "abstained",
              reasonCode: "replacement-policy",
            };
        } else
          result = commitAutonomousTierDecision({
            cfg,
            classifier,
            critic,
            signals,
            decidedAt: new Date().toISOString(),
          });
        if (result.status === "committed") {
          changed = true;
        }
      }
      if (changed)
        publishTierManifest({ cfg, createdAt: new Date().toISOString() });
      completeMaintenanceEvent(cfg, event.id, event.claimToken!);
      if (cursor + batch.length < assignments.length)
        enqueueTieringReady(cfg, cursor + batch.length);
    } catch (error) {
      if (event.attempt >= MAX_MAINTENANCE_EVENT_ATTEMPTS)
        failMaintenanceEvent(cfg, event.id, event.claimToken!);
      else retryMaintenanceEvent(cfg, event.id, event.claimToken!);
      ok = false;
      console.error(
        `tier governance failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function enqueueTierEvaluationEvents(cfg: ReturnType<typeof config>): void {
  const state = deriveTierState(cfg);
  const catalog = scanCatalog(cfg.root);
  const reviewed = listProposals(cfg, undefined, "reviewed").length;
  const retrievalLabels = tierRetrievalComparison(cfg).labels;
  const stateSha256 = tierStateDigest(state);
  for (const assignment of state.values()) {
    const phase =
      assignment.tier === "system" && assignment.rollout === "canary"
        ? "canary"
        : assignment.tier === "external" &&
            assignment.hierarchy !== "uncategorized" &&
            assignment.redaction === "clear" &&
            assignment.promptIntegrity === "trusted"
          ? "shadow"
          : undefined;
    if (!phase) continue;
    const entry = catalog.entries.find(
      (candidate) =>
        candidate.memoryId === assignment.memoryId &&
        candidate.path === assignment.path &&
        candidate.sha256 === assignment.artifactSha256,
    );
    if (!entry) continue;
    const canary = tierCanaryEvidence(cfg, assignment);
    const canaryPercent = tierCanaryPercent(cfg, assignment);
    const canaryBaseline = tierCanaryBaseline(cfg, assignment);
    const artifact = tierArtifact(cfg, assignment);
    const explicitDurableUserStatement = tierHasExplicitUserStatement(
      cfg,
      assignment.memoryId,
    );
    const confidenceLowerBound =
      artifact.sourceSessions.length >= 3 ||
      (explicitDurableUserStatement && entry.scope === "global")
        ? 0.98
        : artifact.sourceSessions.length >= 2 || explicitDurableUserStatement
          ? 0.95
          : 0.9;
    enqueueMaintenanceEvent(cfg, {
      kind: "tier-eval-ready",
      cause: `${phase}:${assignment.memoryId}:${assignment.artifactSha256}:${reviewed}:${retrievalLabels}:${canary.relevantTurns}:${canary.harmfulFeedback}:${canaryPercent}:${canaryBaseline}:${stateSha256}`,
      basis: {
        phase,
        memoryId: assignment.memoryId,
        path: assignment.path,
        artifactSha256: assignment.artifactSha256,
        reviewed,
        retrievalLabels,
        relevantTurns: canary.relevantTurns,
        harmfulFeedback: canary.harmfulFeedback,
        canaryPercent,
        canaryBaseline,
        hierarchy: assignment.hierarchy,
        proposedScope: entry.scope === "global" ? "global" : "project",
        evidenceSessionIds: artifact.sourceSessions,
        confidenceLowerBound,
        explicitDurableUserStatement,
        stateSha256,
      },
    });
  }
}

function reportNumber(report: Record<string, unknown>, key: string): number {
  const value = report[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`tier evaluation report lacks ${key}`);
  return value;
}

async function processTierEvaluationEvents(
  cfg: ReturnType<typeof config>,
  budget: { remaining: number; assignments: number } = {
    remaining: 1,
    assignments: 0,
  },
): Promise<boolean> {
  if (!tierAutonomyEnabled(cfg) || process.env.PI_MEMORY_SKIP_EXTERNAL === "1")
    return true;
  let ok = true;
  for (;;) {
    if (budget.remaining <= 0) return ok;
    const event = claimMaintenanceEvent(cfg, { kinds: ["tier-eval-ready"] });
    if (!event) return ok;
    budget.remaining -= 1;
    budget.assignments += 1;
    try {
      const state = deriveTierState(cfg);
      const assignment = [...state.values()].find(
        (candidate) =>
          candidate.memoryId === event.basis.memoryId &&
          candidate.path === event.basis.path &&
          candidate.artifactSha256 === event.basis.artifactSha256,
      );
      const phase = event.basis.phase;
      const expectedPlacement =
        phase === "shadow"
          ? assignment?.tier === "external" &&
            assignment.redaction === "clear" &&
            assignment.promptIntegrity === "trusted"
          : phase === "canary"
            ? assignment?.tier === "system" && assignment.rollout === "canary"
            : false;
      if (
        !assignment ||
        !expectedPlacement ||
        event.basis.stateSha256 !== tierStateDigest(state)
      ) {
        completeMaintenanceEvent(cfg, event.id, event.claimToken!);
        continue;
      }
      const immediateCanaryEvidence = tierCanaryEvidence(cfg, assignment);
      if (immediateCanaryEvidence.harmfulFeedback > 0) {
        const target = {
          memoryId: assignment.memoryId,
          path: assignment.path,
          artifactSha256: assignment.artifactSha256,
        };
        const classifier: TierClassifierOutput = {
          version: 1,
          target,
          action: "demote",
          hierarchy: assignment.hierarchy,
          proposedScope: "project",
          durability: "durable",
          risk: "clear",
          evidenceIds: ["trusted-harmful-feedback"],
          evidenceSessionIds: [],
        };
        const demoted = commitAutonomousTierDecision({
          cfg,
          classifier,
          critic: {
            version: 1,
            target,
            agrees: true,
            entailed: true,
            scopeValid: true,
            riskClear: true,
            evidenceIds: classifier.evidenceIds,
          },
          signals: {
            artifactScope: "project",
            confidenceLowerBound: 1,
            explicitDurableUserStatement: false,
            verifiedCorrection: true,
            condemnedRollback: false,
            evaluationPassed: false,
            availableEvidenceSessionIds: [],
          },
          decidedAt: new Date().toISOString(),
        });
        if (demoted.status === "committed")
          publishTierManifest({ cfg, createdAt: new Date().toISOString() });
        resetTierCanaryPercent(cfg, assignment);
        completeMaintenanceEvent(cfg, event.id, event.claimToken!);
        continue;
      }
      if (
        phase === "canary" &&
        immediateCanaryEvidence.relevantTurns -
          tierCanaryBaseline(cfg, assignment) <
          30
      ) {
        completeMaintenanceEvent(cfg, event.id, event.claimToken!);
        continue;
      }
      const dataset = contained(
        cfg.data,
        join(cfg.data, "v2/eval/tier-autonomous.jsonl"),
      );
      const exported = exportEvalDataset(cfg, dataset);
      const retrieval = tierRetrievalComparison(cfg, 5, assignment);
      if (exported.cases < 30 || retrieval.labels < 10) {
        completeMaintenanceEvent(cfg, event.id, event.claimToken!);
        continue;
      }
      const evaluatorModel = modelConfig();
      if (process.env.PI_MEMORY_TIER_EVAL_MODEL)
        evaluatorModel.model = process.env.PI_MEMORY_TIER_EVAL_MODEL;
      if (!evaluatorModel.model.includes("/"))
        throw new Error("PI_MEMORY_TIER_EVAL_MODEL must be provider/model");
      const replayId = `replay_${sha256(`tier-eval:${event.id}`).slice(0, 20)}`;
      const replay = replayDataset({
        cfg,
        dataset,
        modes: ["memory-off", "current", "tiered"],
        limit: Math.min(100, exported.cases),
        replayId,
        model: evaluatorModel.model,
        reasoning: evaluatorModel.reasoning,
        tierCandidate: assignment,
        invoke: (prompt, invocation) =>
          runAudited({
            cfg,
            kind: "eval-replay",
            identity: invocation.identity,
            prompt,
            model: evaluatorModel,
            runId: replayId,
            eventId: event.id,
          }),
      });
      const graded = gradeTierReplayAutomatically({
        cfg,
        replayId: replay.replayId,
        invoke: (prompt, identity) =>
          runAudited({
            cfg,
            kind: "tier-eval",
            identity,
            prompt,
            model: evaluatorModel,
            runId: replayId,
            eventId: event.id,
          }),
      });
      const report = evalReport(cfg, replay.replayId);
      const datasetCases = readFileSync(dataset, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) => JSON.parse(line) as { retrieval?: { targetIds?: unknown } },
        );
      const hierarchyRelevantCases = datasetCases.filter(
        (item) =>
          Array.isArray(item.retrieval?.targetIds) &&
          item.retrieval.targetIds.includes(assignment.memoryId),
      ).length;
      const gate = tierShipGate({
        pairedCases: reportNumber(report, "tieredPairedCases"),
        hierarchyRelevantCases,
        currentScore: reportNumber(report, "current"),
        memoryOffScore: reportNumber(report, "memoryOff"),
        tieredScore: reportNumber(report, "tiered"),
        tieredDelta: reportNumber(report, "tieredDelta"),
        tieredLowerBound: reportNumber(report, "tieredLowerBound"),
        retrievalLabels: retrieval.labels,
        retrievalRecallRegression: retrieval.recallRegression,
        severeSafetyFailures: graded.severeSafetyFailures,
        secretFindings: 0,
        promptBudgetViolations: 0,
        historyVerified: verifyHistory(cfg).ok,
      });
      if (phase === "shadow") {
        const target = {
          memoryId: assignment.memoryId,
          path: assignment.path,
          artifactSha256: assignment.artifactSha256,
        };
        const evalEntry = scanCatalog(cfg.root).entries.find(
          (entry) =>
            entry.memoryId === assignment.memoryId &&
            entry.path === assignment.path &&
            entry.sha256 === assignment.artifactSha256,
        );
        if (!evalEntry) throw new Error("tier evaluation target left catalog");
        const sourceSessions = tierArtifact(cfg, assignment).sourceSessions;
        const classifier = parseTierClassifierOutput({
          version: 1,
          target,
          action: graded.severeSafetyFailures > 0 ? "quarantine" : "promote",
          hierarchy: assignment.hierarchy,
          proposedScope: evalEntry.scope === "global" ? "global" : "project",
          durability: "durable",
          risk: graded.severeSafetyFailures > 0 ? "harmful" : "clear",
          evidenceIds: [`tier-eval:${replayId}`],
          evidenceSessionIds: sourceSessions,
        });
        const critic = parseTierCriticOutput({
          version: 1,
          target,
          agrees: gate.pass,
          entailed: gate.pass,
          scopeValid: true,
          riskClear: graded.severeSafetyFailures === 0,
          evidenceIds: classifier.evidenceIds,
        });
        const explicitDurableUserStatement = tierHasExplicitUserStatement(
          cfg,
          assignment.memoryId,
        );
        const confidenceLowerBound =
          sourceSessions.length >= 3 ||
          (explicitDurableUserStatement && evalEntry.scope === "global")
            ? 0.98
            : sourceSessions.length >= 2 || explicitDurableUserStatement
              ? 0.95
              : 0.9;
        let committed = false;
        if (
          gate.pass &&
          [...state.values()].filter((item) => item.tier === "system").length >=
            SYSTEM_PROMPT_MAX_MEMORIES
        ) {
          const candidates = [...state.values()]
            .filter((item) => item.tier === "system")
            .map((item) => ({
              target: {
                memoryId: item.memoryId,
                path: item.path,
                artifactSha256: item.artifactSha256,
              },
              hierarchy: item.hierarchy,
              body: tierArtifact(cfg, item).body,
              score: 0.5,
              rollout: item.rollout,
              redaction: item.redaction,
              promptIntegrity: item.promptIntegrity,
            }));
          candidates.push({
            target,
            hierarchy: classifier.hierarchy,
            body: tierArtifact(cfg, assignment).body,
            score: confidenceLowerBound,
            rollout: "canary",
            redaction: "clear",
            promptIntegrity: "trusted",
          });
          const decidedAt = new Date().toISOString();
          const selection = selectSystemSet({
            cfg,
            candidates,
            now: decidedAt,
          });
          if (
            selection.selected.some(
              (candidate) =>
                tierTargetKey(candidate.target) === tierTargetKey(target),
            )
          ) {
            commitTierTransition({
              cfg,
              plan: planTierTransition({
                cfg,
                selection,
                decidedAt,
                reason: "autonomous-shadow-gate-passed",
              }),
            });
            committed = true;
          }
        } else {
          const result = commitAutonomousTierDecision({
            cfg,
            classifier,
            critic,
            signals: {
              artifactScope:
                classifier.proposedScope === "global" ? "global" : "project",
              confidenceLowerBound,
              explicitDurableUserStatement,
              verifiedCorrection: false,
              condemnedRollback: false,
              evaluationPassed: gate.pass,
              availableEvidenceSessionIds: sourceSessions,
            },
            decidedAt: new Date().toISOString(),
          });
          committed = result.status === "committed";
        }
        if (committed)
          publishTierManifest({ cfg, createdAt: new Date().toISOString() });
        completeMaintenanceEvent(cfg, event.id, event.claimToken!);
        continue;
      }
      const canaryEvidence = tierCanaryEvidence(cfg, assignment);
      const canaryBaseline = tierCanaryBaseline(cfg, assignment);
      const stagedRelevantTurns = Math.max(
        0,
        canaryEvidence.relevantTurns - canaryBaseline,
      );
      const canaryGate = tierCanaryGate({
        relevantTurns: stagedRelevantTurns,
        taskScoreDelta:
          (canaryEvidence.usefulFeedback - canaryEvidence.harmfulFeedback) /
          Math.max(1, canaryEvidence.relevantTurns),
        correctionRateDelta: canaryEvidence.correctionRate,
        promptFailureRateDelta: 0,
        secretOrPolicyIncidents: graded.severeSafetyFailures,
      });
      const canaryPercent = tierCanaryPercent(cfg, assignment);
      if (gate.pass && canaryGate.pass && canaryPercent < 100) {
        advanceTierCanaryPercent(cfg, assignment, canaryEvidence.relevantTurns);
        completeMaintenanceEvent(cfg, event.id, event.claimToken!);
        continue;
      }
      const rollbackReasons = tierAutomaticRollbackReasons({
        secretOrPromptIntegrityIncidents: graded.severeSafetyFailures,
        malformedSnapshots: 0,
        verifiedSystemRollbacks: 0,
        harmfulCorrectionsDistinctSessions: 0,
        relevantTurns: reportNumber(report, "tieredPairedCases"),
        taskScoreDelta: reportNumber(report, "tieredDelta"),
        promptFailureRateDelta: 0,
      });
      if (canaryEvidence.harmfulFeedback > 0)
        rollbackReasons.push("verified-harmful-feedback");
      const target = {
        memoryId: assignment.memoryId,
        path: assignment.path,
        artifactSha256: assignment.artifactSha256,
      };
      const classifier: TierClassifierOutput = {
        version: 1,
        target,
        action:
          rollbackReasons.length > 0
            ? graded.severeSafetyFailures > 0
              ? "quarantine"
              : "demote"
            : "promote",
        hierarchy: assignment.hierarchy,
        proposedScope: "project",
        durability: "durable",
        risk: graded.severeSafetyFailures > 0 ? "harmful" : "clear",
        evidenceIds: [`tier-eval:${replayId}`],
        evidenceSessionIds: [],
      };
      const result = commitAutonomousTierDecision({
        cfg,
        classifier,
        critic: {
          version: 1,
          target,
          agrees: gate.pass && canaryGate.pass,
          entailed: gate.pass && canaryGate.pass,
          scopeValid: true,
          riskClear: graded.severeSafetyFailures === 0,
          evidenceIds: classifier.evidenceIds,
        },
        signals: {
          artifactScope: "project",
          confidenceLowerBound: rollbackReasons.length > 0 ? 0 : 1,
          utilityLowerBound: reportNumber(report, "tiered"),
          relevantOpportunities: reportNumber(report, "tieredPairedCases"),
          explicitDurableUserStatement: false,
          verifiedCorrection: canaryEvidence.harmfulFeedback > 0,
          condemnedRollback: false,
          evaluationPassed: gate.pass && canaryGate.pass,
          availableEvidenceSessionIds: [],
        },
        decidedAt: new Date().toISOString(),
      });
      if (result.status === "committed")
        publishTierManifest({ cfg, createdAt: new Date().toISOString() });
      if (result.status === "committed")
        resetTierCanaryPercent(cfg, assignment);
      completeMaintenanceEvent(cfg, event.id, event.claimToken!);
    } catch (error) {
      if (event.attempt >= MAX_MAINTENANCE_EVENT_ATTEMPTS)
        failMaintenanceEvent(cfg, event.id, event.claimToken!);
      else retryMaintenanceEvent(cfg, event.id, event.claimToken!);
      ok = false;
      console.error(
        `tier evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function maintainUnlocked(): Promise<boolean> {
  const cfg = config();
  const observation = createWideEvent({
    service: "pi-memory",
    operation: "memory.maintenance",
    fields: {
      maintenance: {
        limit: Number(process.env.PI_MEMORY_MAINTAIN_LIMIT || 10),
        externalProcessing: process.env.PI_MEMORY_SKIP_EXTERNAL !== "1",
      },
    },
  });
  try {
    const result = await maintainUnlockedObserved(cfg);
    observation.finish(result ? "success" : "degraded");
    return result;
  } catch (error) {
    attachMemoryOperationError(observation, error);
    observation.finish("failure");
    throw error;
  }
}

async function maintainUnlockedObserved(
  cfg: ReturnType<typeof config>,
): Promise<boolean> {
  recoverTransactions(cfg);
  recoverMaintenanceEvents(cfg);
  reconcileFailedCheckpointJobs(cfg);
  initHistory(cfg, {
    ...(process.env.PI_MEMORY_GIT_REMOTE
      ? { remote: process.env.PI_MEMORY_GIT_REMOTE }
      : {}),
  });
  reconcileRollbackAdaptationEvents(cfg);
  projectUnlocked();
  writeCatalog(cfg);
  secureDir(cfg.state);
  const gatesPath = join(cfg.state, "maintain-gates.json");
  let gates: { consolidation?: number; qmd?: number; reconcile?: number } = {};
  try {
    gates = JSON.parse(readFileSync(gatesPath, "utf8"));
  } catch {}
  const now = Date.now();
  let ok = await processAdaptationEvents(cfg);
  reconcileCoveredCheckpointEvents(cfg);
  if (pendingWindows(1).length > 0)
    ok = combineMaintenanceResults(
      ok,
      await consolidateUnlocked(
        Number(process.env.PI_MEMORY_MAINTAIN_LIMIT || 10),
      ),
    );
  reconcileCoveredCheckpointEvents(cfg);
  const health = applyDeterministicMaintenance(cfg);
  const corpusEvent =
    process.env.PI_MEMORY_SKIP_EXTERNAL === "1"
      ? null
      : claimMaintenanceEvent(cfg, { kinds: ["corpus-changed"] });
  if (corpusEvent) {
    try {
      const configuredModel = modelConfig();
      const analysis = await observeMemoryOperation(
        {
          operation: "memory.corpus-doctor-processing",
          correlation: { eventId: corpusEvent.id },
          fields: { corpusDoctor: { attempt: corpusEvent.attempt } },
          result: (result) => {
            return {
              outcome: result.proposals.length === 0 ? "degraded" : "success",
              fields: {
                corpusDoctor: {
                  proposalCount: result.proposals.length,
                  diagnosticCount: result.diagnostics.length,
                },
              },
            };
          },
        },
        () =>
          analyzeCorpusMaintenance({
            cfg,
            report: health,
            model: configuredModel.model,
            reasoning: configuredModel.reasoning,
            invoke: (prompt) =>
              runAuditedAsync({
                cfg,
                kind: "corpus-doctor",
                identity: corpusEvent.id,
                prompt,
                model: configuredModel,
                eventId: corpusEvent.id,
              }),
          }),
      );
      for (const diagnostic of analysis.diagnostics)
        console.error(
          `memory maintenance ${diagnostic.code} ${diagnostic.pathologyId}: ${diagnostic.message}`,
        );
      if (
        analysis.diagnostics.some(
          (diagnostic) => diagnostic.code === "model-skip",
        )
      ) {
        completeMaintenanceEvent(cfg, corpusEvent.id, corpusEvent.claimToken!);
      } else {
        assertFreshMaintenanceBasis(cfg, analysis.report);
        for (const proposal of analysis.proposals) {
          saveProposal(cfg, proposal);
          applyMemoryProposal({
            cfg,
            id: proposal.id,
            actor: "background-reflection",
          });
        }
        completeMaintenanceEvent(cfg, corpusEvent.id, corpusEvent.claimToken!);
      }
    } catch (error) {
      if (corpusEvent.attempt >= 3)
        failMaintenanceEvent(cfg, corpusEvent.id, corpusEvent.claimToken!);
      else retryMaintenanceEvent(cfg, corpusEvent.id, corpusEvent.claimToken!);
      ok = false;
      console.error(
        `corpus maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (process.env.PI_MEMORY_SKIP_EXTERNAL !== "1") {
    try {
      run(process.env.QMD_BIN || "qmd", ["update"]);
    } catch {
      ok = false;
    }
    if (now - (gates.qmd || 0) >= 2 * 60 * 60_000)
      try {
        const timeout = Number(
          process.env.PI_MEMORY_EMBED_TIMEOUT_MS || 15 * 60_000,
        );
        run(
          process.env.QMD_BIN || "qmd",
          ["embed", "-c", "pi-sessions"],
          undefined,
          timeout,
        );
        run(
          process.env.QMD_BIN || "qmd",
          ["embed", "-c", "agent-memories"],
          undefined,
          timeout,
        );
        gates.qmd = now;
      } catch {
        ok = false;
      }
  }
  if (now - (gates.reconcile || 0) >= 24 * 60 * 60_000) {
    reconcile();
    gates.reconcile = now;
  }
  if (isHistoryInitialized(cfg)) {
    const sync = syncHistory(cfg);
    if (!sync.ok) console.error(`memory history sync deferred: ${sync.error}`);
    if (!finalizeHistorySync(cfg, sync)) ok = false;
  }
  atomic(gatesPath, `${JSON.stringify(gates)}\n`);
  return ok;
}

type TierMaintenanceSlice = {
  ok: boolean;
  events: number;
  assignments: number;
  remaining: number;
};

async function processTierMaintenanceSlice(
  cfg: ReturnType<typeof config>,
): Promise<TierMaintenanceSlice> {
  const configured = Number(process.env.PI_MEMORY_TIER_EVENT_BUDGET || 1);
  const limit =
    Number.isSafeInteger(configured) && configured >= 1 && configured <= 100
      ? configured
      : 1;
  const budget = { remaining: limit, assignments: 0 };
  if (!tierAutonomyEnabled(cfg) || process.env.PI_MEMORY_SKIP_EXTERNAL === "1")
    return { ok: true, events: 0, assignments: 0, remaining: 0 };
  return observeMemoryOperation(
    {
      operation: "memory.tiering.maintenance-slice",
      fields: { limit },
      result: (result) => ({
        outcome: result.ok ? "success" : "degraded",
        fields: {
          events: result.events,
          assignments: result.assignments,
          remaining: result.remaining,
        },
      }),
    },
    async () => {
      enqueueTieringReady(cfg);
      let ok = await processTieringEvents(cfg, budget);
      enqueueTierEvaluationEvents(cfg);
      ok = combineMaintenanceResults(
        ok,
        await processTierEvaluationEvents(cfg, budget),
      );
      const remaining = listMaintenanceEvents(cfg, ["pending"]).filter(
        ({ event }) =>
          event.kind === "tiering-ready" || event.kind === "tier-eval-ready",
      ).length;
      return {
        ok,
        events: limit - budget.remaining,
        assignments: budget.assignments,
        remaining,
      };
    },
  );
}

function scheduleTierContinuation(cfg: ReturnType<typeof config>): boolean {
  secureDir(cfg.state);
  const wake = contained(cfg.state, join(cfg.state, "wake"));
  try {
    writeFileSync(wake, "tier-continuation\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  spawnMaintenance(["--tier-continuation"]);
  return true;
}

function retryMaintenanceWakeIfPresent(state: string): void {
  if (!existsSync(contained(state, join(state, "wake")))) return;
  setTimeout(wakeMaintenance, 1_000);
}

function wakeMaintenance(): void {
  spawnMaintenance([]);
}

function spawnMaintenance(args: string[]): void {
  const configured = process.env.PI_MEMORY_BIN;
  const executable = configured || process.execPath;
  const script = process.argv[1];
  const child = spawn(
    executable,
    configured ? ["maintain", ...args] : [script!, "maintain", ...args],
    { detached: true, stdio: "ignore" },
  );
  child.once("error", () => undefined);
  child.unref();
}

type MaintenanceWakeConfig = { state: string };

function claimMaintenanceWake(cfg: MaintenanceWakeConfig): string | undefined {
  secureDir(cfg.state);
  const wake = contained(cfg.state, join(cfg.state, "wake"));
  const claim = contained(cfg.state, join(cfg.state, "wake.claimed"));
  try {
    renameSync(wake, claim);
    return claim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return existsSync(claim) ? claim : undefined;
  }
}

async function withMaintenanceWake<T>(
  cfg: MaintenanceWakeConfig,
  runMaintenance: () => T | Promise<T>,
): Promise<T> {
  const claim = claimMaintenanceWake(cfg);
  try {
    return await runMaintenance();
  } finally {
    if (claim) rmSync(claim, { force: true });
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const indexes = args.flatMap((arg, index) => (arg === name ? [index] : []));
    if (indexes.length > 1) throw new Error(`duplicate option ${name}`);
    if (indexes.length === 0) return undefined;
    const value = args[indexes[0]! + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    return value;
  };
  let result: boolean | undefined = true;
  if (command === "project")
    result = await lock(() => {
      projectUnlocked();
      return true;
    });
  else if (command === "consolidate") {
    const index = args.indexOf("--limit");
    const limit = index >= 0 ? Number(args[index + 1]) : 10;
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000)
      throw new Error("invalid --limit");
    result = await lock(() => consolidateUnlocked(limit));
  } else if (command === "reconcile")
    result = await lock(() => {
      reconcile();
      return true;
    });
  else if (command === "maintain") {
    const cfg = config();
    const continuation = args.includes("--tier-continuation");
    if (!continuation)
      result = await lock(() => withMaintenanceWake(cfg, maintainUnlocked));
    if (result !== undefined) {
      // Model inference remains within this bounded lock slice. Releasing it
      // around inference requires a durable prepared record bound to the event
      // claim, history head, catalog/state digests, artifact hash, and prompts;
      // reacquisition must then revalidate those fields before the history CAS.
      const tier = await lock(() =>
        continuation
          ? withMaintenanceWake(cfg, () => processTierMaintenanceSlice(cfg))
          : processTierMaintenanceSlice(cfg),
      );
      if (tier === undefined) result = undefined;
      else {
        result = combineMaintenanceResults(result, tier.ok);
        if (tier.remaining > 0) scheduleTierContinuation(cfg);
        else if (existsSync(contained(cfg.state, join(cfg.state, "wake"))))
          wakeMaintenance();
      }
    }
  } else if (command === "promote")
    throw new Error(
      "promote was removed because it bypassed reversible review; run pi-memory migrate, then review the imported proposal",
    );
  else if (command === "tier") {
    const action = args[0] ?? "status";
    if (action === "status")
      console.log(JSON.stringify(tierStatus(config()), null, 2));
    else if (action === "disable")
      result = await lock(() => {
        setTierAutonomy(config(), false);
        return true;
      });
    else if (action === "enable")
      result = await lock(() => {
        const cfg = config();
        setTierAutonomy(cfg, true);
        enqueueTieringReady(cfg);
        return true;
      });
    else if (action === "rollback") {
      const targetManifestId = args[1];
      if (!targetManifestId || args.length !== 2)
        throw new Error("tier rollback requires one target manifest ID");
      const rolledBackAt = new Date().toISOString();
      const manifest = await lock(() =>
        rollbackTierManifest({
          cfg: config(),
          rollbackId: `rollback_${sha256(`${targetManifestId}:${rolledBackAt}`).slice(0, 32)}`,
          targetManifestId,
          rolledBackAt,
        }),
      );
      console.log(JSON.stringify(manifest, null, 2));
    } else
      throw new Error("tier requires status, enable, disable, or rollback");
  } else if (command === "catalog") {
    const cwdIndex = args.indexOf("--cwd");
    const cwd =
      cwdIndex >= 0 && args[cwdIndex + 1]
        ? resolve(args[cwdIndex + 1]!)
        : process.cwd();
    const catalog = scanCatalog(config().root);
    console.log(
      args.includes("--json")
        ? JSON.stringify(catalog, null, 2)
        : renderPromptCatalog(catalog, cwd),
    );
  } else if (command === "migrate")
    result = await lock(() => {
      console.log(
        JSON.stringify(
          migrateV1(config(), args.includes("--dry-run")),
          null,
          2,
        ),
      );
      return true;
    });
  else if (command === "propose") {
    const json = option("--json");
    const file = option("--file");
    const source = option("--source");
    if (json && file)
      throw new Error("propose accepts either --json or --file");
    const raw = file
      ? readFileSync(resolve(file), "utf8")
      : json
        ? json
        : readFileSync(0, "utf8");
    const submitted = await lock(() => {
      const cfg = config();
      const proposals = submitManualProposal(cfg, raw, source);
      const receipts = proposals.map((proposal) =>
        applyMemoryProposal({
          cfg,
          id: proposal.id,
          actor: "remember-skill",
        }),
      );
      return { proposals, receipts };
    });
    if (submitted) console.log(JSON.stringify(submitted, null, 2));
    else result = undefined;
  } else if (command === "events") {
    if (args.length === 0)
      console.log(JSON.stringify(listMaintenanceEvents(config()), null, 2));
    else if (args[0] === "enqueue") {
      const kind = option("--kind");
      if (kind !== "manual" || args.length !== 3 || args[1] !== "--kind")
        throw new Error("events enqueue requires --kind manual");
      const requestedAt = new Date().toISOString();
      console.log(
        JSON.stringify(
          enqueueMaintenanceEvent(
            config(),
            {
              kind,
              cause: "manual cli request",
              basis: { requestedAt },
            },
            () => requestedAt,
          ),
          null,
          2,
        ),
      );
    } else throw new Error("invalid events command");
  } else if (command === "history") {
    const cfg = config();
    const action = args[0] ?? "list";
    if (action === "init") {
      const remote = option("--remote") ?? process.env.PI_MEMORY_GIT_REMOTE;
      const report = await lock(() =>
        initHistory(cfg, {
          ...(remote ? { remote } : {}),
          dryRun: args.includes("--dry-run"),
        }),
      );
      if (report) {
        const sync =
          !report.dryRun && isHistoryInitialized(cfg)
            ? syncHistory(cfg)
            : undefined;
        console.log(JSON.stringify({ ...report, sync }, null, 2));
        if (sync && (!sync.ok || !finalizeHistorySync(cfg, sync)))
          result = false;
      } else result = undefined;
    } else if (action === "verify") {
      const report = verifyHistory(cfg);
      console.log(JSON.stringify(report, null, 2));
      result = report.ok;
    } else if (action === "sync") {
      const report = syncHistory(cfg);
      console.log(JSON.stringify(report, null, 2));
      result = report.ok && finalizeHistorySync(cfg, report);
    } else if (action === "list") {
      const memory = option("--memory");
      const limit = option("--limit");
      console.log(
        JSON.stringify(
          listHistory(cfg, {
            ...(memory ? { memory } : {}),
            ...(limit ? { limit: Number(limit) } : {}),
          }),
          null,
          2,
        ),
      );
    } else if (action === "show" && args[1]) {
      console.log(showHistory(cfg, args[1], option("--path")));
    } else if (action === "diff") {
      const from = option("--from");
      const to = option("--to");
      const memory = option("--memory");
      console.log(diffHistory(cfg, from, to ?? "HEAD", memory));
    } else throw new Error("invalid history command");
  } else if (command === "repair" && args[0]) {
    const reasonIndex = args.indexOf("--reason");
    if (reasonIndex < 0 || !args[reasonIndex + 1]?.trim())
      throw new Error("repair requires --reason");
    if (args[0] !== "adopt" && args[0] !== "discard")
      throw new Error("repair mode must be adopt or discard");
    const report = await lock(() => {
      const cfg = config();
      // Explicit history recovery must settle interrupted transactions first,
      // but catalog quality cannot be derived until repair reseeds verification.
      recoverTransactions(cfg, { publishCatalog: false });
      const repaired = repairHistory(cfg, {
        mode: args[0] as "adopt" | "discard",
        reason: args[reasonIndex + 1]!,
      });
      writeCatalog(cfg);
      return repaired;
    });
    if (report) console.log(JSON.stringify(report, null, 2));
    else result = undefined;
  } else if (command === "proposals") {
    const laneIndex = args.indexOf("--lane");
    const lane = laneIndex >= 0 ? args[laneIndex + 1] : undefined;
    if (lane !== undefined && lane !== "memory" && lane !== "skill")
      throw new Error("invalid proposal lane");
    const statusIndex = args.indexOf("--status");
    const status = statusIndex >= 0 ? args[statusIndex + 1] : "pending";
    if (status !== "pending" && status !== "reviewed")
      throw new Error("invalid proposal status");
    console.log(JSON.stringify(listProposals(config(), lane, status), null, 2));
  } else if (command === "show" && args[0])
    console.log(
      JSON.stringify(findProposal(config(), args[0]).proposal, null, 2),
    );
  else if (command === "review" && args[0] && args[1]) {
    const reasonCodeIndex = args.indexOf("--reason-code");
    const reasonIndex = args.indexOf("--reason");
    const editIndex = args.indexOf("--edit");
    const reasonCode =
      reasonCodeIndex >= 0
        ? (args[reasonCodeIndex + 1] as ReviewReasonCode | undefined)
        : undefined;
    if (!reasonCode || !REVIEW_REASON_CODES.includes(reasonCode))
      throw new Error("review requires --reason-code");
    if (reasonIndex < 0 || !args[reasonIndex + 1]?.trim())
      throw new Error("review requires --reason");
    const decision = args[1];
    if (decision !== "accept" && decision !== "reject")
      throw new Error("review decision must be accept or reject");
    const receipt = await lock(() =>
      reviewProposal({
        cfg: config(),
        id: args[0]!,
        decision,
        reasonCode,
        reason: args[reasonIndex + 1]!,
        ...(editIndex >= 0 && args[editIndex + 1]
          ? { editPath: args[editIndex + 1] }
          : {}),
      }),
    );
    if (receipt) console.log(JSON.stringify(receipt, null, 2));
    else result = undefined;
  } else if (command === "rollback" && args[0]) {
    const reasonIndex = args.indexOf("--reason");
    if (reasonIndex < 0 || !args[reasonIndex + 1]?.trim())
      throw new Error("rollback requires --reason");
    const receipt = await lock(() =>
      rollbackReview(config(), args[0]!, args[reasonIndex + 1]!),
    );
    if (receipt) {
      wakeMaintenance();
      console.log(JSON.stringify(receipt, null, 2));
    } else result = undefined;
  } else if (command === "feedback" && args[0] && args[1]) {
    const reasonIndex = args.indexOf("--reason-code");
    const queryIndex = args.indexOf("--query");
    const workspaceIndex = args.indexOf("--workspace");
    const supersedesIndex = args.indexOf("--supersedes");
    const memoriesIndex = args.indexOf("--memories");
    const outcome = args[1];
    const reasonCode =
      reasonIndex >= 0
        ? (args[reasonIndex + 1] as FeedbackReasonCode | undefined)
        : undefined;
    if (
      (outcome !== "useful" && outcome !== "harmful") ||
      !reasonCode ||
      !FEEDBACK_REASON_CODES.includes(reasonCode)
    )
      throw new Error("feedback requires useful|harmful and --reason-code");
    const receipt = await lock(() =>
      recordMemoryFeedback({
        cfg: config(),
        reference: args[0]!,
        outcome,
        reasonCode,
        ...(queryIndex >= 0 && args[queryIndex + 1]
          ? { query: args[queryIndex + 1] }
          : {}),
        ...(workspaceIndex >= 0 && args[workspaceIndex + 1]
          ? { workspace: args[workspaceIndex + 1] }
          : {}),
        ...(supersedesIndex >= 0 && args[supersedesIndex + 1]
          ? { supersedes: args[supersedesIndex + 1] }
          : {}),
        ...(memoriesIndex >= 0 && args[memoriesIndex + 1]
          ? { memoryIds: args[memoriesIndex + 1]!.split(",").filter(Boolean) }
          : {}),
      }),
    );
    if (receipt) console.log(JSON.stringify(receipt, null, 2));
    else result = undefined;
  } else if (command === "metrics")
    console.log(JSON.stringify(memoryMetrics(config()), null, 2));
  else if (command === "health")
    console.log(JSON.stringify(scanCorpusHealth(config()), null, 2));
  else if (command === "background" && args[0] === "sessions") {
    if (args.length !== 1)
      throw new Error("usage: pi-memory background sessions");
    console.log(JSON.stringify(listAuditSessions(config().data), null, 2));
  } else if (command === "background" && args[0] === "resume") {
    if (args.length !== 1)
      throw new Error("usage: pi-memory background resume");
    console.log(auditResumeCommand(config().data));
  } else if (command === "eval" && args[0] === "adaptation")
    console.log(JSON.stringify(adaptationEvaluationMetrics(config()), null, 2));
  else if (command === "eval" && args[0] === "export") {
    const outIndex = args.indexOf("--out");
    if (outIndex < 0 || !args[outIndex + 1])
      throw new Error("eval export requires --out");
    console.log(
      JSON.stringify(exportEvalDataset(config(), args[outIndex + 1]!), null, 2),
    );
  } else if (command === "eval" && args[0] === "replay") {
    const datasetIndex = args.indexOf("--dataset");
    const modesIndex = args.indexOf("--modes");
    const limitIndex = args.indexOf("--limit");
    if (datasetIndex < 0 || !args[datasetIndex + 1])
      throw new Error("eval replay requires --dataset");
    if (!args.includes("--allow-model-invocation"))
      throw new Error(
        "eval replay sends sanitized cases to the configured model; pass --allow-model-invocation to confirm",
      );
    const modes = (
      modesIndex >= 0
        ? args[modesIndex + 1] || ""
        : "memory-off,current,tiered,gold"
    ).split(",");
    if (
      !modes.every(
        (mode) =>
          mode === "memory-off" ||
          mode === "current" ||
          mode === "tiered" ||
          mode === "gold",
      )
    )
      throw new Error("invalid replay modes");
    const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("invalid replay limit");
    const configuredModel = modelConfig();
    console.log(
      JSON.stringify(
        replayDataset({
          cfg: config(),
          dataset: args[datasetIndex + 1]!,
          modes: modes as ReplayMode[],
          limit,
          model: configuredModel.model,
          reasoning: configuredModel.reasoning,
          invoke: (prompt, invocation) =>
            runAudited({
              cfg: config(),
              kind: "eval-replay",
              identity: invocation.identity,
              prompt,
              model: {
                model: invocation.model,
                reasoning: invocation.reasoning,
              },
              runId: invocation.replayId,
            }),
        }),
        null,
        2,
      ),
    );
  } else if (command === "eval" && args[0] === "report" && args[1])
    console.log(JSON.stringify(evalReport(config(), args[1]), null, 2));
  else if (command === "eval" && args[0] === "retrieval") {
    const kIndex = args.indexOf("--k");
    console.log(
      JSON.stringify(
        retrievalBenchmark(
          config(),
          kIndex >= 0 ? Number(args[kIndex + 1]) : 5,
        ),
        null,
        2,
      ),
    );
  } else if (command === "eval" && args[0] === "grade" && args[1]) {
    const caseIndex = args.indexOf("--case");
    const modeIndex = args.indexOf("--mode");
    const scoreIndex = args.indexOf("--score");
    const reasonIndex = args.indexOf("--reason");
    const mode = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
    if (
      caseIndex < 0 ||
      !args[caseIndex + 1] ||
      reasonIndex < 0 ||
      !args[reasonIndex + 1]?.trim() ||
      (mode !== "memory-off" &&
        mode !== "current" &&
        mode !== "tiered" &&
        mode !== "gold")
    )
      throw new Error("eval grade requires --case, --mode, and --reason");
    console.log(
      gradeReplay({
        cfg: config(),
        replayId: args[1],
        caseId: args[caseIndex + 1]!,
        mode,
        score: Number(args[scoreIndex + 1]),
        reason: args[reasonIndex + 1]!,
      }),
    );
  } else
    throw new Error(
      "usage: pi-memory project|consolidate [--limit N]|reconcile|maintain|tier status|enable|disable|rollback <manifest-id>|catalog [--cwd PATH] [--json]|events [enqueue --kind manual]|migrate [--dry-run]|propose --json JSON [--source URI]|proposals|show <id>|review <id> accept|reject --reason-code CODE --reason TEXT|feedback <review-or-proposal-id> useful|harmful --reason-code CODE [--query TEXT]|rollback <review-id> --reason TEXT|history init|list|show|diff|verify|sync|repair adopt|discard --reason TEXT|metrics|background sessions|resume|eval export|replay|grade|report|retrieval",
    );
  if (result === false) process.exitCode = 1;
  else if (result === undefined) process.exitCode = 75;
}

async function observedMain(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const hasSubcommand = new Set([
    "background",
    "eval",
    "events",
    "history",
    "repair",
  ]).has(command ?? "");
  const knownFlags = new Set([
    "--allow-model-invocation",
    "--case",
    "--cwd",
    "--dataset",
    "--dry-run",
    "--edit",
    "--file",
    "--from",
    "--json",
    "--k",
    "--lane",
    "--limit",
    "--memory",
    "--memories",
    "--mode",
    "--modes",
    "--out",
    "--path",
    "--query",
    "--reason",
    "--reason-code",
    "--remote",
    "--score",
    "--source",
    "--status",
    "--supersedes",
    "--to",
    "--workspace",
  ]);
  const observation = createWideEvent({
    service: "pi-memory",
    operation: "memory.cli",
    fields: {
      command: {
        name: command ?? "missing",
        subcommand:
          hasSubcommand && args[0] && !args[0].startsWith("-")
            ? args[0]
            : undefined,
        flags: [...new Set(args.filter((arg) => knownFlags.has(arg)))],
      },
    },
  });
  try {
    await main();
    const exitCode =
      typeof process.exitCode === "number" ? process.exitCode : undefined;
    observation.finish(exitCode ? "degraded" : "success", {
      command: { exitCode: exitCode ?? 0 },
    });
  } catch (error) {
    attachMemoryOperationError(observation, error);
    observation.finish("failure", { command: { exitCode: 1 } });
    throw error;
  } finally {
    await flushLogs();
  }
}

if (import.meta.main)
  observedMain().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

if (import.meta.vitest) {
  const { describe, expect, it, vi } = import.meta.vitest;
  const header = { type: "session" as const, id: "s", cwd: "/tmp" };
  const message = (
    id: string,
    parentId: string | null,
    role: string,
    content: unknown,
  ): Entry => ({ type: "message", id, parentId, message: { role, content } });
  describe("session projection invariants", () => {
    it("does not overwrite an earlier maintenance failure", () => {
      expect(combineMaintenanceResults(false, true)).toBe(false);
      expect(combineMaintenanceResults(true, false)).toBe(false);
    });

    it("keeps a newer maintenance wake published during a run", async () => {
      const state = mkdtempSync(join(tmpdir(), "pi-memory-wake-"));
      atomic(join(state, "wake"), "old\n");

      await withMaintenanceWake({ state }, () => {
        atomic(join(state, "wake"), "new\n");
      });

      expect(readFileSync(join(state, "wake"), "utf8")).toBe("new\n");
      expect(existsSync(join(state, "wake.claimed"))).toBe(false);
    });

    it("consumes a claimed wake after a failed attempt", async () => {
      const state = mkdtempSync(join(tmpdir(), "pi-memory-wake-failure-"));
      atomic(join(state, "wake"), "request\n");

      await expect(
        withMaintenanceWake({ state }, () => {
          throw new Error("maintenance failed");
        }),
      ).rejects.toThrow("maintenance failed");

      expect(existsSync(join(state, "wake"))).toBe(false);
      expect(existsSync(join(state, "wake.claimed"))).toBe(false);
    });

    it("repairs a dirty worktree with a stale checkpoint through the cli", async () => {
      const base = mkdtempSync(join(tmpdir(), "pi-memory-repair-cli-"));
      const cfg = {
        state: join(base, "state"),
        data: join(base, "data"),
        root: join(base, "memories"),
        skillsRoot: join(base, "skills"),
      };
      mkdirSync(cfg.root, { recursive: true });
      writeFileSync(join(cfg.root, "one.md"), "one\n");
      initHistory(cfg);
      expect(verifyHistory(cfg).ok).toBe(true);

      const checkpointPath = join(cfg.data, "v2/history-verification.json");
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      checkpoint.repository = `${checkpoint.repository}:stale`;
      writeFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
      chmodSync(cfg.root, 0o700);
      rmSync(join(cfg.root, "one.md"));

      const previousArgv = process.argv;
      const previous = {
        data: process.env.PI_MEMORY_DATA_DIR,
        root: process.env.PI_MEMORY_ROOT,
        sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
        state: process.env.PI_MEMORY_STATE_DIR,
        skills: process.env.PI_MEMORY_SKILLS_ROOT,
      };
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      process.argv = [
        process.execPath,
        import.meta.filename,
        "repair",
        "discard",
        "--reason",
        "restore test fixture",
      ];
      process.env.PI_MEMORY_DATA_DIR = cfg.data;
      process.env.PI_MEMORY_ROOT = cfg.root;
      process.env.PI_MEMORY_STATE_DIR = cfg.state;
      process.env.PI_MEMORY_SKILLS_ROOT = cfg.skillsRoot;
      process.env.PI_CODING_AGENT_SESSION_DIR = join(base, "sessions");
      try {
        await main();
      } finally {
        process.argv = previousArgv;
        log.mockRestore();
        for (const [key, value] of [
          ["PI_MEMORY_DATA_DIR", previous.data],
          ["PI_MEMORY_ROOT", previous.root],
          ["PI_CODING_AGENT_SESSION_DIR", previous.sessions],
          ["PI_MEMORY_STATE_DIR", previous.state],
          ["PI_MEMORY_SKILLS_ROOT", previous.skills],
        ] as const)
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }

      expect(readFileSync(join(cfg.root, "one.md"), "utf8")).toBe("one\n");
      const verification = verifyHistory(cfg);
      expect(verification).toMatchObject({ ok: true, issues: [] });
      expect(JSON.parse(readFileSync(checkpointPath, "utf8")).repository).toBe(
        verification.basis?.repository,
      );
      expect(existsSync(join(cfg.data, "catalog.json"))).toBe(true);
    });

    it("loads multiple session roots from global config", () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-memory-config-"));
      const settings = join(dir, "bds-pi.json");
      writeFileSync(
        settings,
        JSON.stringify({
          "@bds_pi/pi-memory": {
            sessionsDirs: ["~/first", "~/second"],
          },
        }),
      );
      const previousConfig = process.env.PI_BDS_CONFIG_PATH;
      const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
      process.env.PI_BDS_CONFIG_PATH = settings;
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      clearConfigCache();
      try {
        expect(config().sessions).toEqual([
          join(HOME, "first"),
          join(HOME, "second"),
        ]);
      } finally {
        if (previousConfig === undefined) delete process.env.PI_BDS_CONFIG_PATH;
        else process.env.PI_BDS_CONFIG_PATH = previousConfig;
        if (previousSessions === undefined)
          delete process.env.PI_CODING_AGENT_SESSION_DIR;
        else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
        clearConfigCache();
      }
    });

    it("keeps dedicated background sessions out of normal projection roots", () => {
      const base = mkdtempSync(join(tmpdir(), "pi-memory-audit-isolation-"));
      const data = join(base, "data");
      const sessions = join(base, "sessions");
      const audit = join(base, "audit");
      mkdirSync(sessions, { recursive: true });
      mkdirSync(audit, { recursive: true });
      writeFileSync(
        join(sessions, "normal.jsonl"),
        `${JSON.stringify({ type: "session", id: "normal", cwd: "/tmp" })}\n`,
      );
      writeFileSync(
        join(audit, "audit.jsonl"),
        `${JSON.stringify({ type: "session", id: "audit", cwd: "/tmp" })}\n`,
      );
      const previous = {
        data: process.env.PI_MEMORY_DATA_DIR,
        sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
        audit: process.env.PI_MEMORY_SESSION_DIR,
      };
      process.env.PI_MEMORY_DATA_DIR = data;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
      process.env.PI_MEMORY_SESSION_DIR = audit;
      try {
        expect(config().sessions).toEqual([sessions]);
        expect(config().sessions).not.toContain(auditSessionDir(data));
        projectUnlocked();
        expect(existsSync(join(data, "pi-sessions/normal.md"))).toBe(true);
        expect(existsSync(join(data, "pi-sessions/audit.md"))).toBe(false);
      } finally {
        for (const [key, value] of [
          ["PI_MEMORY_DATA_DIR", previous.data],
          ["PI_CODING_AGENT_SESSION_DIR", previous.sessions],
          ["PI_MEMORY_SESSION_DIR", previous.audit],
        ] as const)
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
    });

    it("projects Amp adapter sessions through the native checkpoint queue", () => {
      const base = mkdtempSync(join(tmpdir(), "pi-memory-amp-adapter-"));
      const data = join(base, "data");
      const sessions = join(base, "sessions");
      const state = join(base, "state");
      const root = join(base, "memories");
      const ampSessions = join(data, "amp-sessions");
      mkdirSync(sessions, { recursive: true });
      mkdirSync(ampSessions, { recursive: true });
      const fixture = readFileSync(
        new URL("./test-fixtures/amp-checkpoint-v2.jsonl", import.meta.url),
        "utf8",
      );
      const rows = fixture
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row)) as [Header, ...Entry[]];
      const sessionId = rows[0].id;
      const checkpointId = rows.at(-1)!.id;
      writeFileSync(join(ampSessions, `${sessionId}.jsonl`), fixture);
      const previous = {
        data: process.env.PI_MEMORY_DATA_DIR,
        root: process.env.PI_MEMORY_ROOT,
        sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
        state: process.env.PI_MEMORY_STATE_DIR,
      };
      process.env.PI_MEMORY_DATA_DIR = data;
      process.env.PI_MEMORY_ROOT = root;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
      process.env.PI_MEMORY_STATE_DIR = state;
      try {
        projectUnlocked();
        expect(
          readFileSync(join(data, `pi-sessions/${sessionId}.md`), "utf8"),
        ).toContain("remember this");
        expect(
          existsSync(
            join(data, `queue/pending/${sessionId}--${checkpointId}.json`),
          ),
        ).toBe(true);
      } finally {
        for (const [key, value] of [
          ["PI_MEMORY_DATA_DIR", previous.data],
          ["PI_MEMORY_ROOT", previous.root],
          ["PI_CODING_AGENT_SESSION_DIR", previous.sessions],
          ["PI_MEMORY_STATE_DIR", previous.state],
        ] as const)
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
    });

    it("projects only authored text", () => {
      const snapshot: Snapshot = {
        source: "/tmp/s",
        header,
        entries: [],
        chains: [
          [
            message("u", null, "user", [{ type: "text", text: "visible" }]),
            message("a", "u", "assistant", [
              { type: "thinking", thinking: "secret" },
              { type: "toolCall", name: "bash" },
              { type: "text", text: "answer" },
            ]),
            message("t", "a", "toolResult", "leak"),
          ],
        ],
      };
      expect(renderSnapshot(snapshot).markdown).toContain("visible");
      expect(renderSnapshot(snapshot).markdown).toContain("answer");
      expect(renderSnapshot(snapshot).markdown).not.toMatch(/secret|bash|leak/);
    });
    it("requires native checkpoints to match the branch user count", () => {
      const identity = {
        version: 1 as const,
        sessionId: "s",
        workspace: "/tmp",
        userEntryIds: ["u"],
        assistantEntryIds: ["a"],
        catalogSha256: "a".repeat(64),
        exposures: [],
        outcomes: [],
        redactions: {},
        recordedAt: "2026-01-01T00:00:00.000Z",
      };
      const receipt: Entry = {
        type: "custom",
        id: "r",
        parentId: "a",
        customType: TURN_RECEIPT_ENTRY_TYPE,
        data: { ...identity, receiptId: canonicalTurnReceiptId(identity) },
      };
      const checkpointEntry: Entry = {
        type: "custom",
        id: "cp",
        parentId: "r",
        customType: "@bds_pi/agent-memory/checkpoint",
        data: {
          version: 2,
          sessionId: "s",
          throughLeafId: "u",
          acceptedUserTurns: 1,
        },
      };
      const chain = [
        message("u", null, "user", "goal"),
        message("a", "u", "assistant", "answer"),
        receipt,
        checkpointEntry,
      ];
      const snapshot: Snapshot = {
        source: "/tmp/s",
        header,
        entries: chain,
        chains: [chain],
      };
      expect(renderSnapshot(snapshot).jobs).toHaveLength(1);
      (checkpointEntry.data as Record<string, unknown>).acceptedUserTurns = 2;
      expect(renderSnapshot(snapshot).jobs).toEqual([]);
    });

    it("queues only child-native checkpoints from a fork projection", () => {
      const receiptEntry = (
        id: string,
        parentId: string,
        sessionId: string,
        userEntryIds: string[],
        assistantEntryIds: string[],
      ): Entry => {
        const identity = {
          version: 1 as const,
          sessionId,
          workspace: "/tmp",
          userEntryIds,
          assistantEntryIds,
          catalogSha256: "a".repeat(64),
          exposures: [],
          outcomes: [],
          redactions: {},
          recordedAt: "2026-01-01T00:00:00.000Z",
        };
        return {
          type: "custom",
          id,
          parentId,
          customType: TURN_RECEIPT_ENTRY_TYPE,
          data: { ...identity, receiptId: canonicalTurnReceiptId(identity) },
        };
      };
      const chain: Entry[] = [
        message("parent-u", null, "user", "parent"),
        message("parent-a", "parent-u", "assistant", "parent answer"),
        receiptEntry(
          "parent-r",
          "parent-a",
          "parent-session",
          ["parent-u"],
          ["parent-a"],
        ),
        {
          type: "custom",
          id: "parent-cp",
          parentId: "parent-r",
          customType: "@bds_pi/agent-memory/checkpoint",
          data: {
            version: 2,
            sessionId: "parent-session",
            throughLeafId: "parent-a",
            acceptedUserTurns: 1,
          },
        },
        message("child-u", "parent-cp", "user", "child"),
        message("child-a", "child-u", "assistant", "child answer"),
        receiptEntry(
          "child-r",
          "child-a",
          "child-session",
          ["child-u"],
          ["child-a"],
        ),
        {
          type: "custom",
          id: "child-cp",
          parentId: "child-r",
          customType: "@bds_pi/agent-memory/checkpoint",
          data: {
            version: 2,
            sessionId: "child-session",
            throughLeafId: "child-a",
            acceptedUserTurns: 2,
          },
        },
      ];
      const projected = renderSnapshot({
        source: "/tmp/child",
        header: { ...header, id: "child-session" },
        entries: chain,
        chains: [chain],
      });
      expect(projected.jobs.map((job) => job.checkpointEntryId)).toEqual([
        "child-cp",
      ]);
      expect(projected.markdown).toContain("child answer");
    });

    it("uses checkpoint identity for deterministic jobs", () => {
      const cp: Entry = {
        type: "custom",
        customType: "@bds_pi/agent-memory/checkpoint",
        data: {
          version: 2,
          sessionId: "s",
          throughLeafId: "u",
          acceptedUserTurns: 1,
        },
        id: "cp",
        parentId: "u",
      };
      const snapshot: Snapshot = {
        source: "/tmp/s",
        header,
        entries: [],
        chains: [[message("u", null, "user", "hi"), cp]],
      };
      expect(renderSnapshot(snapshot).jobs).toEqual(
        renderSnapshot(snapshot).jobs,
      );
      expect(renderSnapshot(snapshot).jobs[0]?.checkpointEntryId).toBe("cp");
    });

    it("queues every checkpoint on a branch", () => {
      const first: Entry = {
        type: "custom",
        customType: "@bds_pi/agent-memory/checkpoint",
        data: {
          version: 2,
          sessionId: "s",
          throughLeafId: "u1",
          acceptedUserTurns: 1,
        },
        id: "cp1",
        parentId: "u1",
      };
      const second: Entry = {
        type: "custom",
        customType: "@bds_pi/agent-memory/checkpoint",
        data: {
          version: 2,
          sessionId: "s",
          throughLeafId: "u2",
          acceptedUserTurns: 2,
        },
        id: "cp2",
        parentId: "u2",
      };
      const chain = [
        message("u1", null, "user", "one"),
        first,
        message("u2", "cp1", "user", "two"),
        second,
      ];
      const snapshot: Snapshot = {
        source: "/tmp/s",
        header,
        entries: chain,
        chains: [chain],
      };
      expect(
        renderSnapshot(snapshot).jobs.map((job) => job.checkpointEntryId),
      ).toEqual(["cp1", "cp2"]);
    });

    it("keeps the newest authored text when a projection is truncated", () => {
      const chain = [
        message("u1", null, "user", `old-start ${"x".repeat(MAX_PROJECTION)}`),
        message("a1", "u1", "assistant", "newest-checkpoint-result"),
        {
          type: "custom",
          customType: "@bds_pi/agent-memory/checkpoint",
          data: {
            version: 2,
            sessionId: "s",
            throughLeafId: "a1",
            acceptedUserTurns: 1,
          },
          id: "cp",
          parentId: "a1",
        },
      ];
      const markdown = renderSnapshot({
        source: "/tmp/s",
        header,
        entries: chain,
        chains: [chain],
      }).markdown;
      expect(markdown).toContain("[earlier authored text truncated]");
      expect(markdown).toContain("newest-checkpoint-result");
      expect(markdown).not.toContain("old-start");
    });

    it("keeps sibling branches in separate reflection windows", () => {
      const base = mkdtempSync(join(tmpdir(), "memory-windows-"));
      const data = join(base, "data");
      const sessions = join(base, "sessions");
      const source = join(sessions, "session.jsonl");
      mkdirSync(join(data, "queue/pending"), { recursive: true });
      mkdirSync(sessions, { recursive: true });
      const records = [
        { type: "session", id: "forked", cwd: "/tmp/project" },
        message("u1", null, "user", "shared"),
        {
          type: "custom",
          customType: "@bds_pi/agent-memory/checkpoint",
          data: {
            version: 2,
            sessionId: "s",
            throughLeafId: "u1",
            acceptedUserTurns: 1,
          },
          id: "cp1",
          parentId: "u1",
        },
        message("a", "cp1", "assistant", "branch-a"),
        {
          type: "custom",
          customType: "@bds_pi/agent-memory/checkpoint",
          data: {
            version: 2,
            sessionId: "forked",
            throughLeafId: "a",
            acceptedUserTurns: 1,
          },
          id: "cpa",
          parentId: "a",
        },
        message("b", "cp1", "assistant", "branch-b"),
        {
          type: "custom",
          customType: "@bds_pi/agent-memory/checkpoint",
          data: {
            version: 2,
            sessionId: "forked",
            throughLeafId: "b",
            acceptedUserTurns: 1,
          },
          id: "cpb",
          parentId: "b",
        },
      ];
      writeFileSync(
        source,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
      for (const checkpointEntryId of ["cp1", "cpa", "cpb"])
        writeFileSync(
          join(data, "queue/pending", `forked--${checkpointEntryId}.json`),
          JSON.stringify({
            version: 1,
            sessionId: "forked",
            checkpointEntryId,
            sourcePath: source,
            projectionPath: "",
            workspace: "/tmp/project",
          }),
        );
      const previousData = process.env.PI_MEMORY_DATA_DIR;
      const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
      process.env.PI_MEMORY_DATA_DIR = data;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
      try {
        const windows = pendingWindows(10);
        expect(windows).toHaveLength(2);
        expect(batchWindows(windows)).toHaveLength(2);
        const serialized = windows.map((window) =>
          JSON.stringify(window.evidence),
        );
        expect(
          serialized.filter((value) => value.includes("branch-a")),
        ).toHaveLength(1);
        expect(
          serialized.filter((value) => value.includes("branch-b")),
        ).toHaveLength(1);
        expect(
          windows
            .flatMap((window) => window.jobs)
            .map((item) => item.job.checkpointEntryId)
            .sort(),
        ).toEqual(["cp1", "cpa", "cpb"]);
        mkdirSync(join(data, "v2/ledger"), { recursive: true });
        writeFileSync(join(data, "v2/ledger/forked--cpa.json"), "{}\n");
        writeFileSync(join(data, "queue/pending/bad.json"), "not json\n");
        const recovered = pendingWindows(10);
        expect(
          recovered
            .flatMap((window) => window.jobs)
            .map((item) => item.job.checkpointEntryId),
        ).not.toContain("cpa");
        expect(existsSync(join(data, "queue/processed/forked--cpa.json"))).toBe(
          true,
        );
        expect(existsSync(join(data, "queue/failed/bad.json"))).toBe(true);
      } finally {
        if (previousData === undefined) delete process.env.PI_MEMORY_DATA_DIR;
        else process.env.PI_MEMORY_DATA_DIR = previousData;
        if (previousSessions === undefined)
          delete process.env.PI_CODING_AGENT_SESSION_DIR;
        else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      }
    });

    it("uses only ledger-covered boundaries when isolating descendant checkpoints", () => {
      const base = mkdtempSync(join(tmpdir(), "memory-malformed-checkpoint-"));
      const previousData = process.env.PI_MEMORY_DATA_DIR;
      process.env.PI_MEMORY_DATA_DIR = join(base, "data");
      try {
        const cfg = config();
        const source = join(base, "session.jsonl");
        const records = [
          { type: "session", id: "session", cwd: "/tmp/project" },
          message("before-boundary", null, "user", "already reflected"),
          message(
            "marker-gap",
            "before-boundary",
            "assistant",
            "include marker gap",
          ),
          {
            type: "custom",
            customType: "@bds_pi/agent-memory/checkpoint",
            data: {
              version: 2,
              sessionId: "session",
              throughLeafId: "before-boundary",
              acceptedUserTurns: 1,
            },
            id: "trusted-checkpoint",
            parentId: "marker-gap",
          },
          message("after-boundary", "trusted-checkpoint", "user", "include me"),
          {
            type: "custom",
            customType: "@bds_pi/agent-memory/checkpoint",
            data: {
              version: 2,
              sessionId: "session",
              throughLeafId: "before-boundary",
              acceptedUserTurns: 2,
            },
            id: "bad-checkpoint",
            parentId: "after-boundary",
          },
          message(
            "omitted-after-through",
            "bad-checkpoint",
            "assistant",
            "omit me",
          ),
          {
            type: "custom",
            customType: "@bds_pi/agent-memory/checkpoint",
            data: {
              version: 2,
              sessionId: "session",
              throughLeafId: "after-boundary",
              acceptedUserTurns: 2,
            },
            id: "descendant-checkpoint",
            parentId: "omitted-after-through",
          },
          {
            type: "custom",
            customType: "@bds_pi/agent-memory/checkpoint",
            data: {
              version: 2,
              sessionId: "session",
              throughLeafId: "before-boundary",
              acceptedUserTurns: 3,
            },
            id: "rewound-checkpoint",
            parentId: "descendant-checkpoint",
          },
        ];
        writeFileSync(
          source,
          `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        );
        mkdirSync(join(cfg.data, "queue/pending"), { recursive: true });
        mkdirSync(join(cfg.data, "v2/ledger"), { recursive: true });
        mkdirSync(join(cfg.data, "v2/runs/trusted-run"), { recursive: true });
        writeFileSync(
          join(cfg.data, "v2/runs/trusted-run/input.json"),
          JSON.stringify({
            version: 2,
            evidence: [
              {
                version: 1,
                window: {
                  sessionId: "session",
                  checkpointEntryIds: ["trusted-checkpoint"],
                  throughLeafId: "before-boundary",
                  branchDigest: "trusted-branch",
                },
              },
            ],
          }),
        );
        writeFileSync(
          join(cfg.data, "v2/ledger/session--trusted-checkpoint.json"),
          JSON.stringify({
            version: 2,
            runId: "trusted-run",
            throughLeafId: "before-boundary",
            branchDigest: "trusted-branch",
          }),
        );
        for (const checkpointEntryId of [
          "bad-checkpoint",
          "descendant-checkpoint",
          "rewound-checkpoint",
        ]) {
          writeFileSync(
            join(
              cfg.data,
              "queue/pending",
              `session--${checkpointEntryId}.json`,
            ),
            JSON.stringify({
              version: 1,
              sessionId: "session",
              checkpointEntryId,
              sourcePath: source,
              projectionPath: "",
              workspace: "/tmp/project",
            }),
          );
          enqueueMaintenanceEvent(cfg, {
            kind: "checkpoint-ready",
            cause: `session:${checkpointEntryId}`,
            basis: { sessionId: "session", checkpointEntryId },
          });
        }

        const windows = pendingWindows(10);

        expect(
          windows.flatMap((window) =>
            window.jobs.map((item) => item.job.checkpointEntryId),
          ),
        ).toEqual(["descendant-checkpoint"]);
        expect(JSON.stringify(windows[0]!.evidence)).toContain("include me");
        expect(JSON.stringify(windows[0]!.evidence)).toContain(
          "include marker gap",
        );
        expect(JSON.stringify(windows[0]!.evidence)).not.toMatch(
          /already reflected|omit me/,
        );
        expect(
          existsSync(
            join(cfg.data, "queue/failed/session--bad-checkpoint.json"),
          ),
        ).toBe(true);
        expect(
          existsSync(
            join(cfg.data, "queue/failed/session--rewound-checkpoint.json"),
          ),
        ).toBe(true);
        expect(listMaintenanceEvents(cfg)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: "failed",
              event: expect.objectContaining({
                basis: expect.objectContaining({
                  checkpointEntryId: "bad-checkpoint",
                }),
              }),
            }),
            expect.objectContaining({
              status: "pending",
              event: expect.objectContaining({
                basis: expect.objectContaining({
                  checkpointEntryId: "descendant-checkpoint",
                }),
              }),
            }),
          ]),
        );
      } finally {
        if (previousData === undefined) delete process.env.PI_MEMORY_DATA_DIR;
        else process.env.PI_MEMORY_DATA_DIR = previousData;
      }
    });

    it("recovers a pending job whose malformed checkpoint event already failed", () => {
      const base = mkdtempSync(join(tmpdir(), "memory-malformed-recovery-"));
      const previousData = process.env.PI_MEMORY_DATA_DIR;
      process.env.PI_MEMORY_DATA_DIR = join(base, "data");
      try {
        const cfg = config();
        const event = enqueueMaintenanceEvent(cfg, {
          kind: "checkpoint-ready",
          cause: "session:checkpoint",
          basis: { sessionId: "session", checkpointEntryId: "checkpoint" },
        });
        const claim = claimMaintenanceEvent(cfg, {
          kinds: ["checkpoint-ready"],
          ids: [event.id],
        })!;
        failMaintenanceEvent(cfg, event.id, claim.claimToken!);
        mkdirSync(join(cfg.data, "queue/pending"), { recursive: true });
        writeFileSync(
          join(cfg.data, "queue/pending/session--checkpoint.json"),
          JSON.stringify({
            version: 1,
            sessionId: "session",
            checkpointEntryId: "checkpoint",
            sourcePath: "/missing/session.jsonl",
            projectionPath: "",
            workspace: "/tmp/project",
          }),
        );

        reconcileFailedCheckpointJobs(cfg);

        expect(
          existsSync(join(cfg.data, "queue/failed/session--checkpoint.json")),
        ).toBe(true);
        expect(
          existsSync(join(cfg.data, "queue/pending/session--checkpoint.json")),
        ).toBe(false);
      } finally {
        if (previousData === undefined) delete process.env.PI_MEMORY_DATA_DIR;
        else process.env.PI_MEMORY_DATA_DIR = previousData;
      }
    });

    it("settles ledger-covered checkpoint events without pending jobs", () => {
      const base = mkdtempSync(join(tmpdir(), "memory-covered-events-"));
      const previousData = process.env.PI_MEMORY_DATA_DIR;
      process.env.PI_MEMORY_DATA_DIR = join(base, "data");
      try {
        const cfg = config();
        const event = enqueueMaintenanceEvent(cfg, {
          kind: "checkpoint-ready",
          cause: "session:checkpoint",
          basis: { sessionId: "session", checkpointEntryId: "checkpoint" },
        });
        mkdirSync(join(cfg.data, "v2/ledger"), { recursive: true });
        writeFileSync(
          join(cfg.data, "v2/ledger/session--checkpoint.json"),
          "{}\n",
        );
        reconcileCoveredCheckpointEvents(cfg);
        expect(listMaintenanceEvents(cfg)).toEqual([
          { status: "done", event: expect.objectContaining({ id: event.id }) },
        ]);
      } finally {
        if (previousData === undefined) delete process.env.PI_MEMORY_DATA_DIR;
        else process.env.PI_MEMORY_DATA_DIR = previousData;
      }
    });

    it("retries checkpoint failures twice, then fails terminally", () => {
      const base = mkdtempSync(join(tmpdir(), "memory-bounded-events-"));
      const previousData = process.env.PI_MEMORY_DATA_DIR;
      process.env.PI_MEMORY_DATA_DIR = join(base, "data");
      try {
        const cfg = config();
        enqueueMaintenanceEvent(cfg, {
          kind: "checkpoint-ready",
          cause: "session:checkpoint",
          basis: { sessionId: "session", checkpointEntryId: "checkpoint" },
        });
        mkdirSync(join(cfg.data, "queue/pending"), { recursive: true });
        writeFileSync(
          join(cfg.data, "queue/pending/session--checkpoint.json"),
          JSON.stringify({
            version: 1,
            sessionId: "session",
            checkpointEntryId: "checkpoint",
            sourcePath: "/tmp/session.jsonl",
            projectionPath: "/tmp/session.md",
            workspace: "/tmp",
          }),
        );
        for (let attempt = 1; attempt <= 3; attempt++) {
          const claim = claimMaintenanceEvent(cfg, {
            kinds: ["checkpoint-ready"],
          })!;
          settleCheckpointClaims(cfg, [claim], "error");
          expect(listMaintenanceEvents(cfg)[0]?.status).toBe(
            attempt < 3 ? "pending" : "failed",
          );
        }
        expect(
          existsSync(join(cfg.data, "queue/failed/session--checkpoint.json")),
        ).toBe(true);
        expect(
          existsSync(join(cfg.data, "queue/pending/session--checkpoint.json")),
        ).toBe(false);
      } finally {
        if (previousData === undefined) delete process.env.PI_MEMORY_DATA_DIR;
        else process.env.PI_MEMORY_DATA_DIR = previousData;
      }
    });

    it("deduplicates three exact memories to a fixed point before enqueueing corpus basis", () => {
      const base = mkdtempSync(join(tmpdir(), "memory-fixed-point-"));
      const previousData = process.env.PI_MEMORY_DATA_DIR;
      const previousRoot = process.env.PI_MEMORY_ROOT;
      process.env.PI_MEMORY_DATA_DIR = join(base, "data");
      process.env.PI_MEMORY_ROOT = join(base, "memories");
      try {
        const cfg = config();
        mkdirSync(cfg.root, { recursive: true });
        const body =
          "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
        for (const [id, title] of [
          ["mem_aaaaaaaaaaaaaaaaaaaaaaaa", "one"],
          ["mem_bbbbbbbbbbbbbbbbbbbbbbbb", "two"],
          ["mem_cccccccccccccccccccccccc", "three"],
        ])
          writeFileSync(
            join(cfg.root, `${id}--source__agent.md`),
            renderMemory(
              {
                memoryId: id!,
                title: title!,
                kind: "pattern",
                scope: "global",
                description: title!,
                triggers: [title!],
                keywords: [],
                sources: ["pi://session/checkpoint"],
                created: "2026-07-26",
                updated: "2026-07-26",
                body,
              },
              "review_test",
            ),
          );

        const health = applyDeterministicMaintenance(cfg);

        expect(maintenanceProposals(health)).toEqual([]);
        expect(
          readdirSync(cfg.root).filter((name) => name.endsWith(".md")),
        ).toHaveLength(1);
        expect(listMaintenanceEvents(cfg, ["pending"])).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: expect.objectContaining({
                kind: "corpus-changed",
                cause: health.catalogSha256,
                basis: expect.objectContaining({
                  catalogSha256: health.catalogSha256,
                }),
              }),
            }),
            expect.objectContaining({
              event: expect.objectContaining({ kind: "tiering-ready" }),
            }),
          ]),
        );
      } finally {
        if (previousData === undefined) delete process.env.PI_MEMORY_DATA_DIR;
        else process.env.PI_MEMORY_DATA_DIR = previousData;
        if (previousRoot === undefined) delete process.env.PI_MEMORY_ROOT;
        else process.env.PI_MEMORY_ROOT = previousRoot;
      }
    });

    it("accepts legacy and current consolidation skip receipts", () => {
      const base = mkdtempSync(join(tmpdir(), "memory-skip-receipts-"));
      const path = join(base, "job.json");
      for (const version of [1, 2]) {
        writeFileSync(
          path,
          JSON.stringify({
            version,
            action: "skip",
            jobId: "job",
            createdAt: "2026-07-27T00:00:00.000Z",
          }),
        );
        expect(() => validateReceipt(path, "job")).not.toThrow();
      }
      writeFileSync(
        path,
        JSON.stringify({
          version: 3,
          action: "skip",
          jobId: "job",
          createdAt: "2026-07-27T00:00:00.000Z",
        }),
      );
      expect(() => validateReceipt(path, "job")).toThrow(
        "invalid skip receipt",
      );
    });

    it("settles production adaptation as v2 no-op when external work is disabled", async () => {
      const base = mkdtempSync(join(tmpdir(), "memory-adaptation-skip-"));
      const previousData = process.env.PI_MEMORY_DATA_DIR;
      const previousRoot = process.env.PI_MEMORY_ROOT;
      const previousSkip = process.env.PI_MEMORY_SKIP_EXTERNAL;
      process.env.PI_MEMORY_DATA_DIR = join(base, "data");
      process.env.PI_MEMORY_ROOT = join(base, "memories");
      process.env.PI_MEMORY_SKIP_EXTERNAL = "1";
      try {
        const cfg = config();
        mkdirSync(cfg.root, { recursive: true });
        initHistory(cfg);
        const proposal = submitManualProposal(
          cfg,
          JSON.stringify({
            action: "propose",
            proposals: [
              {
                lane: "memory",
                operation: {
                  type: "create",
                  artifact: {
                    title: "Adaptation skip fixture",
                    kind: "pattern",
                    scope: "global",
                    description: "Use while testing skipped adaptation",
                    triggers: ["adaptation skip"],
                    keywords: [],
                    body: "This body is rolled back.",
                  },
                },
              },
            ],
          }),
          "pi://manual/adaptation-skip",
        )[0]!;
        const accepted = applyMemoryProposal({
          cfg,
          id: proposal.id,
          actor: "remember-skill",
        });
        rollbackReview(cfg, accepted.reviewId, "test rollback");
        const event = listMaintenanceEvents(cfg, ["pending"]).find(
          ({ event }) => event.kind === "adaptation-ready",
        )!.event;

        expect(await processAdaptationEvents(cfg)).toBe(true);

        const shadow = findShadowAdaptation(cfg, event.id)!;
        expect(shadow).toMatchObject({
          version: 2,
          promptVersion: 2,
          decisions: [
            {
              action: "no-op",
              reason: "external processing disabled",
            },
          ],
        });
        expect(listMaintenanceEvents(cfg)).toContainEqual({
          status: "done",
          event: expect.objectContaining({ id: event.id }),
        });
      } finally {
        if (previousData === undefined) delete process.env.PI_MEMORY_DATA_DIR;
        else process.env.PI_MEMORY_DATA_DIR = previousData;
        if (previousRoot === undefined) delete process.env.PI_MEMORY_ROOT;
        else process.env.PI_MEMORY_ROOT = previousRoot;
        if (previousSkip === undefined)
          delete process.env.PI_MEMORY_SKIP_EXTERNAL;
        else process.env.PI_MEMORY_SKIP_EXTERNAL = previousSkip;
      }
    });

    it("strictly validates durable-memory candidates", () => {
      const candidate = `---\nversion: 1\nstatus: candidate\ntitle: "durable preference"\nkind: preference\nscope: "global"\ntriggers: ["when choosing tools"]\nkeywords: ["tools"]\nsource: pi://session/checkpoint\ncreated: 2026-07-19\nupdated: 2026-07-19\n---\n\nprefer the existing tool.\n`;
      expect(parseCandidate(candidate)).toMatchObject({
        title: "durable preference",
        source: "pi://session/checkpoint",
      });
      expect(() =>
        parseCandidate(candidate.replace("version: 1", "version: 2")),
      ).toThrow("invalid candidate values");
    });
  });
}
