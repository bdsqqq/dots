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
import { clearConfigCache, getExtensionConfigWithSchema } from "@bds_pi/config";
import {
  renderPromptCatalog,
  scanCatalog,
  writeCatalog,
  type MemoryConfig,
} from "./catalog.js";
import {
  applyMemoryProposal,
  findProposal,
  listProposals,
  migrateV1,
  recoverTransactions,
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
import { buildSafeEvidence, type SafeEvidence } from "./evidence.js";
import { processPipelineBatches } from "./pipeline.js";
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
  evalReport,
  exportEvalDataset,
  FEEDBACK_REASON_CODES,
  gradeReplay,
  memoryMetrics,
  recordMemoryFeedback,
  replayDataset,
  retrievalBenchmark,
  type FeedbackReasonCode,
} from "./evaluation.js";

process.umask(0o077);

export { renderPromptCatalog } from "./catalog.js";
export * from "./events.js";

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
      join(HOME, "commonplace/01_files/nix/user/agents/skills"),
    ),
  };
};
const MAX_SOURCE = 128 * 1024 * 1024;
const MAX_PROJECTION = 64 * 1024;

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

function checkpoint(entry: Entry): Record<string, unknown> | undefined {
  const data = customData(entry, "@bds_pi/agent-memory/checkpoint");
  return data?.version === 1 &&
    typeof data.throughLeafId === "string" &&
    Number.isInteger(data.acceptedUserTurns) &&
    Number(data.acceptedUserTurns) >= 0
    ? data
    : undefined;
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

export function renderSnapshot(snapshot: Snapshot): {
  markdown: string;
  jobs: Job[];
} {
  const sections: string[] = [
    `# pi session ${snapshot.header.id}`,
    `workspace: ${snapshot.header.cwd}`,
  ];
  const jobs = new Map<string, Job>();
  for (const chain of snapshot.chains) {
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
        chain
          .slice(0, index)
          .some((candidate) => candidate.id === data.throughLeafId)
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
        return undefined;
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== "ESRCH")
          return undefined;
      }
    } else if (Date.now() - statSync(path).mtimeMs < 60_000) return undefined;
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { mode: 0o700 });
  }
  writeFileSync(join(path, "owner"), `${process.pid}\n`, { mode: 0o600 });
  try {
    return await fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function projectUnlocked(): void {
  const cfg = config();
  const projectionDir = contained(cfg.data, join(cfg.data, "pi-sessions"));
  const pending = contained(cfg.data, join(cfg.data, "queue/pending"));
  const quarantine = contained(cfg.data, join(cfg.data, "quarantine"));
  [cfg.state, cfg.data, projectionDir, pending, quarantine].forEach(secureDir);
  const sources = [...new Set(cfg.sessions.flatMap(walkJsonl))];
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
      const rendered = renderSnapshot(snapshot);
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
    value.version !== 1 ||
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
  const rendered = renderSnapshot({
    ...snapshot,
    entries: exactChain,
    chains: [exactChain],
  }).markdown;
  return rendered.slice(0, MAX_PROJECTION);
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
            : run(
                process.env.PI_BIN || "pi",
                [
                  "-p",
                  "--no-session",
                  "--no-tools",
                  "--no-extensions",
                  "--no-skills",
                  "--no-prompt-templates",
                  "--no-context-files",
                  "--model",
                  process.env.PI_MEMORY_MODEL ||
                    "openai-codex/gpt-5.6-luna:low",
                ],
                prompt,
              );
        const action = parseAction(response);
        const now = new Date().toISOString();
        if (action.action === "skip")
          atomic(
            receiptPath,
            `${JSON.stringify({ version: 1, action: "skip", jobId: key, createdAt: now })}\n`,
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
  jobs: Array<{ job: Job; name: string }>;
};

function finalizeQueuedJob(
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
      if (!chain || checkpointIndex < 0 || !checkpoint(chain[checkpointIndex]!))
        throw new Error(`invalid checkpoint job ${name}`);
      items.push({ job: value, name, chain, checkpointIndex });
    } catch (error) {
      console.error(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    const covered = items.filter(
      (item) =>
        item.job.sessionId === maximum.job.sessionId &&
        ancestry.has(item.job.checkpointEntryId) &&
        !assigned.has(`${item.job.sessionId}--${item.job.checkpointEntryId}`),
    );
    if (!covered.length) continue;
    covered.forEach((item) =>
      assigned.add(`${item.job.sessionId}--${item.job.checkpointEntryId}`),
    );
    const coveredIds = new Set(
      covered.map((item) => item.job.checkpointEntryId),
    );
    let start = 0;
    for (let index = 0; index < maximum.checkpointIndex; index++) {
      const entry = maximum.chain[index]!;
      if (checkpoint(entry) && !coveredIds.has(entry.id)) start = index + 1;
    }
    const cp = checkpoint(maximum.chain[maximum.checkpointIndex]!)!;
    const throughLeafId = String(cp.throughLeafId);
    const throughIndex = maximum.chain.findIndex(
      (entry) => entry.id === throughLeafId,
    );
    if (throughIndex < start)
      throw new Error(`checkpoint leaf precedes window ${maximum.name}`);
    windows.push({
      evidence: buildSafeEvidence({
        sessionId: maximum.job.sessionId,
        workspace: maximum.job.workspace,
        entries: maximum.chain.slice(start, throughIndex + 1),
        checkpointEntryIds: covered.map((item) => item.job.checkpointEntryId),
        throughLeafId,
        branchEntryIds: maximum.chain
          .slice(0, throughIndex + 1)
          .map((entry) => entry.id),
      }),
      jobs: covered.map(({ job, name }) => ({ job, name })),
    });
  }
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

function settleCheckpointClaims(
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
  let ok = true;
  for (const proposal of listProposals(cfg, "memory").filter(
    (item) => item.provenance.autonomous === true,
  ))
    try {
      applyMemoryProposal({
        cfg,
        id: proposal.id,
        actor: "background-reflection",
      });
    } catch (error) {
      ok = false;
      console.error(
        `autonomous memory application deferred for ${proposal.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  const batches = batchWindows(pendingWindows(limit));
  if (process.env.PI_MEMORY_SKIP_EXTERNAL === "1") return ok;
  const claims = checkpointEventIds(cfg, batches.flat())
    .map((id) =>
      claimMaintenanceEvent(cfg, { kinds: ["checkpoint-ready"], ids: [id] }),
    )
    .filter((event): event is NonNullable<typeof event> => event !== null);
  const model = process.env.PI_MEMORY_MODEL || "openai-codex/gpt-5.6-luna:low";
  try {
    await processPipelineBatches(
      batches.map((batch) => ({
        cfg,
        scope: scopeFor(batch[0]!.jobs[0]!.job.workspace),
        evidence: batch.map((window) => window.evidence),
        model,
        skipExternal: process.env.PI_MEMORY_SKIP_EXTERNAL === "1",
        invoke: (prompt: string) =>
          runAsync(
            process.env.PI_BIN || "pi",
            [
              "-p",
              "--no-session",
              "--no-tools",
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
              "--no-context-files",
              "--model",
              model,
            ],
            prompt,
          ),
      })),
    );
    for (const batch of batches)
      for (const window of batch)
        for (const { name } of window.jobs)
          finalizeQueuedJob(cfg, name, "processed");
    settleCheckpointClaims(cfg, claims, "complete");
  } catch (error) {
    settleCheckpointClaims(cfg, claims, "error");
    ok = false;
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

function applyDeterministicMaintenance(cfg: ReturnType<typeof config>) {
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

async function maintainUnlocked(): Promise<boolean> {
  const cfg = config();
  recoverTransactions(cfg);
  recoverMaintenanceEvents(cfg);
  reconcileFailedCheckpointJobs(cfg);
  initHistory(cfg, {
    ...(process.env.PI_MEMORY_GIT_REMOTE
      ? { remote: process.env.PI_MEMORY_GIT_REMOTE }
      : {}),
  });
  projectUnlocked();
  writeCatalog(cfg);
  secureDir(cfg.state);
  const gatesPath = join(cfg.state, "maintain-gates.json");
  let gates: { consolidation?: number; qmd?: number; reconcile?: number } = {};
  try {
    gates = JSON.parse(readFileSync(gatesPath, "utf8"));
  } catch {}
  const now = Date.now();
  let ok = true;
  reconcileCoveredCheckpointEvents(cfg);
  if (pendingWindows(1).length > 0)
    ok = await consolidateUnlocked(
      Number(process.env.PI_MEMORY_MAINTAIN_LIMIT || 10),
    );
  reconcileCoveredCheckpointEvents(cfg);
  const health = applyDeterministicMaintenance(cfg);
  const corpusEvent =
    process.env.PI_MEMORY_SKIP_EXTERNAL === "1"
      ? null
      : claimMaintenanceEvent(cfg, { kinds: ["corpus-changed"] });
  if (corpusEvent) {
    try {
      const model =
        process.env.PI_MEMORY_MODEL || "openai-codex/gpt-5.6-luna:low";
      const analysis = await analyzeCorpusMaintenance({
        cfg,
        report: health,
        model,
        invoke: (prompt) =>
          runAsync(
            process.env.PI_BIN || "pi",
            [
              "-p",
              "--no-session",
              "--no-tools",
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
              "--no-context-files",
              "--model",
              model,
            ],
            prompt,
          ),
      });
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
  else if (command === "maintain") result = await lock(maintainUnlocked);
  else if (command === "promote")
    throw new Error(
      "promote was removed because it bypassed reversible review; run pi-memory migrate, then review the imported proposal",
    );
  else if (command === "catalog") {
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
      recoverTransactions(cfg);
      return repairHistory(cfg, {
        mode: args[0] as "adopt" | "discard",
        reason: args[reasonIndex + 1]!,
      });
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
    if (receipt) console.log(JSON.stringify(receipt, null, 2));
    else result = undefined;
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
      modesIndex >= 0 ? args[modesIndex + 1] || "" : "memory-off,current,gold"
    ).split(",");
    if (
      !modes.every(
        (mode) =>
          mode === "memory-off" || mode === "current" || mode === "gold",
      )
    )
      throw new Error("invalid replay modes");
    const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("invalid replay limit");
    const model =
      process.env.PI_MEMORY_MODEL || "openai-codex/gpt-5.6-luna:low";
    console.log(
      JSON.stringify(
        replayDataset({
          cfg: config(),
          dataset: args[datasetIndex + 1]!,
          modes: modes as Array<"memory-off" | "current" | "gold">,
          limit,
          model,
          invoke: (prompt) =>
            run(
              process.env.PI_BIN || "pi",
              [
                "-p",
                "--no-session",
                "--no-tools",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-context-files",
                "--model",
                model,
              ],
              prompt,
            ),
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
      (mode !== "memory-off" && mode !== "current" && mode !== "gold")
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
      "usage: pi-memory project|consolidate [--limit N]|reconcile|maintain|catalog [--cwd PATH] [--json]|events [enqueue --kind manual]|migrate [--dry-run]|propose --json JSON [--source URI]|proposals|show <id>|review <id> accept|reject --reason-code CODE --reason TEXT|feedback <review-or-proposal-id> useful|harmful --reason-code CODE [--query TEXT]|rollback <review-id> --reason TEXT|history init|list|show|diff|verify|sync|repair adopt|discard --reason TEXT|metrics|eval export|replay|grade|report|retrieval",
    );
  if (result === false) process.exitCode = 1;
  else if (result === undefined) process.exitCode = 75;
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const header = { type: "session" as const, id: "s", cwd: "/tmp" };
  const message = (
    id: string,
    parentId: string | null,
    role: string,
    content: unknown,
  ): Entry => ({ type: "message", id, parentId, message: { role, content } });
  describe("session projection invariants", () => {
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
    it("uses checkpoint identity for deterministic jobs", () => {
      const cp: Entry = {
        type: "custom",
        customType: "@bds_pi/agent-memory/checkpoint",
        data: { version: 1, throughLeafId: "u", acceptedUserTurns: 1 },
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
        data: { version: 1, throughLeafId: "u1", acceptedUserTurns: 1 },
        id: "cp1",
        parentId: "u1",
      };
      const second: Entry = {
        type: "custom",
        customType: "@bds_pi/agent-memory/checkpoint",
        data: { version: 1, throughLeafId: "u2", acceptedUserTurns: 2 },
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
          data: { version: 1, throughLeafId: "a1", acceptedUserTurns: 1 },
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
          data: { version: 1, throughLeafId: "u1", acceptedUserTurns: 1 },
          id: "cp1",
          parentId: "u1",
        },
        message("a", "cp1", "assistant", "branch-a"),
        {
          type: "custom",
          customType: "@bds_pi/agent-memory/checkpoint",
          data: { version: 1, throughLeafId: "a", acceptedUserTurns: 2 },
          id: "cpa",
          parentId: "a",
        },
        message("b", "cp1", "assistant", "branch-b"),
        {
          type: "custom",
          customType: "@bds_pi/agent-memory/checkpoint",
          data: { version: 1, throughLeafId: "b", acceptedUserTurns: 2 },
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
        expect(listMaintenanceEvents(cfg, ["pending"])).toEqual([
          expect.objectContaining({
            event: expect.objectContaining({
              kind: "corpus-changed",
              cause: health.catalogSha256,
              basis: expect.objectContaining({
                catalogSha256: health.catalogSha256,
              }),
            }),
          }),
        ]);
      } finally {
        if (previousData === undefined) delete process.env.PI_MEMORY_DATA_DIR;
        else process.env.PI_MEMORY_DATA_DIR = previousData;
        if (previousRoot === undefined) delete process.env.PI_MEMORY_ROOT;
        else process.env.PI_MEMORY_ROOT = previousRoot;
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
