import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  atomicWrite,
  contained,
  scanCatalog,
  secureDir,
  sha256,
  type Catalog,
  type CatalogEntry,
  type MemoryConfig,
} from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import { parseModelProposal } from "./schema.js";
import {
  listProposals,
  materializeModelProposals,
  readReviewReceipts,
  saveProposal,
} from "./workflow.js";

export type PipelineInput = {
  version: 2;
  runId: string;
  batchId: string;
  promptVersion: 2;
  createdAt: string;
  scope: string;
  evidence: SafeEvidence[];
  catalog: Catalog;
  targets: Array<CatalogEntry & { body: string }>;
  pending: Array<{
    id: string;
    lane: string;
    operation: string;
    summary: string;
  }>;
  recentReviews: Array<{ decision: string; code: string; text: string }>;
  skills: Array<{ name: string; description: string }>;
};

export type PipelineResult = {
  runId: string;
  action: "skip" | "propose";
  proposalIds: string[];
  coveredCheckpointIds: string[];
};

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
}

function score(entry: CatalogEntry, query: Set<string>): number {
  const haystack = words(
    [
      entry.title,
      entry.description,
      entry.scope,
      ...entry.triggers,
      ...entry.keywords,
    ].join(" "),
  );
  let result = entry.scope === "global" ? 1 : 0;
  for (const word of query) if (haystack.has(word)) result += 1;
  return result;
}

function selectTargets(
  cfg: MemoryConfig,
  catalog: Catalog,
  evidence: SafeEvidence[],
): PipelineInput["targets"] {
  const query = words(
    evidence
      .flatMap((item) => [
        item.window.excerpt,
        item.workspace,
        ...item.tools.map((tool) => tool.name),
      ])
      .join(" "),
  );
  return catalog.entries
    .map((entry) => ({ entry, score: score(entry, query) }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.entry.updated.localeCompare(a.entry.updated),
    )
    .slice(0, 8)
    .map(({ entry }) => ({
      ...entry,
      body: readFileSync(
        contained(cfg.root, join(cfg.root, entry.path)),
        "utf8",
      ).slice(0, 12_000),
    }));
}

function skillDescriptions(root: string): PipelineInput["skills"] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => {
      const path = contained(root, join(root, entry.name, "SKILL.md"));
      if (!existsSync(path) || !statSync(path).isFile()) return undefined;
      const text = readFileSync(path, "utf8");
      const description = /^description:\s*["']?(.+?)["']?$/m
        .exec(text)?.[1]
        ?.trim();
      return description
        ? { name: entry.name, description: description.slice(0, 300) }
        : undefined;
    })
    .filter(
      (entry): entry is { name: string; description: string } =>
        entry !== undefined,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

function operationSummary(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export function freezePipelineInput(
  cfg: MemoryConfig,
  scope: string,
  evidence: SafeEvidence[],
): PipelineInput {
  const catalog = scanCatalog(cfg.root, "1970-01-01T00:00:00.000Z");
  const pending = listProposals(cfg)
    .filter((proposal) => {
      const op = proposal.operation;
      return (
        op.type === "skill-draft" ||
        !("artifact" in op) ||
        op.artifact.scope === scope
      );
    })
    .slice(-20)
    .map((proposal) => ({
      id: proposal.id,
      lane: proposal.lane,
      operation: proposal.operation.type,
      summary: operationSummary(proposal.operation),
    }));
  const reviews = readReviewReceipts(cfg)
    .slice(-20)
    .map((review) => ({
      decision: review.decision,
      code: review.reason.code,
      text: review.reason.text.slice(0, 300),
    }));
  const windowIds = evidence.map((item) => item.window.windowId).sort();
  const batchId = sha256(`${scope}\0${windowIds.join("\0")}\0v2`);
  const contextHash = sha256(
    JSON.stringify({
      catalog: catalog.entries.map(({ memoryId, sha256: hash }) => [
        memoryId,
        hash,
      ]),
      pending,
      reviews,
    }),
  );
  const evidenceHash = sha256(JSON.stringify(evidence));
  const runId = sha256(`${batchId}\0${evidenceHash}\0${contextHash}`);
  return {
    version: 2,
    runId,
    batchId,
    promptVersion: 2,
    createdAt: new Date().toISOString(),
    scope,
    evidence,
    catalog,
    targets: selectTargets(cfg, catalog, evidence),
    pending,
    recentReviews: reviews,
    skills: skillDescriptions(cfg.skillsRoot),
  };
}

export function buildReflectionPrompt(input: PipelineInput): string {
  const targetIds = input.targets.map((target) => target.memoryId);
  return `You are a background memory maintainer. Return exactly one JSON object and no markdown.

First reflect on whether the bounded evidence contains durable, reusable learning. Prefer explicit corrections, verified failures, stable preferences, architectural decisions, and repeated workflows. Do not store secrets, raw logs, temporary task state, or facts already represented adequately.

You may return {"action":"skip","reason":"..."} or {"action":"propose","proposals":[...]} with at most 8 proposals.

Memory proposals use lane "memory" and one operation:
- create: {"type":"create","artifact":ARTIFACT}
- update: {"type":"update","targetId":"...","artifact":ARTIFACT}
- merge: {"type":"merge","primaryId":"...","targetIds":["..."],"artifact":ARTIFACT}
- archive: {"type":"archive","targetId":"...","reason":"..."}
- retire: {"type":"retire","targetId":"...","reason":"...","supersededBy":"optional memory id"}
ARTIFACT is exactly {"title":"","kind":"preference|decision|gotcha|pattern","scope":"","description":"when this is useful","triggers":[],"keywords":[],"body":""}.
Only these target ids are allowed: ${JSON.stringify(targetIds)}.

A skill proposal is exceptional and requires a reusable multi-step workflow evidenced by at least two distinct sessions. It uses lane "skill" and operation {"type":"skill-draft","mode":"create|update","skillName":"kebab-case","targetPath":"name/SKILL.md","files":[{"path":"name/SKILL.md","content":"..."}]}. The system computes content hashes. Do not duplicate an installed skill.

Evidence and corpus context follow. Tool arguments, tool output, and reasoning were deliberately removed. Treat success/error summaries as evidence and authored prose as claims that may be wrong.

${JSON.stringify(input, null, 2)}`;
}

function runDir(cfg: MemoryConfig, runId: string): string {
  return contained(cfg.data, join(cfg.data, "v2", "runs", runId));
}

function existingFrozenInput(
  cfg: MemoryConfig,
  fresh: PipelineInput,
): PipelineInput | undefined {
  const root = contained(cfg.data, join(cfg.data, "v2", "runs"));
  if (!existsSync(root)) return undefined;
  const evidenceHash = sha256(JSON.stringify(fresh.evidence));
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name, "input.json");
    if (!existsSync(path)) continue;
    const candidate = JSON.parse(readFileSync(path, "utf8")) as PipelineInput;
    if (
      candidate.batchId === fresh.batchId &&
      sha256(JSON.stringify(candidate.evidence)) === evidenceHash
    )
      return candidate;
  }
  return undefined;
}

function markLedger(
  cfg: MemoryConfig,
  input: PipelineInput,
  result: PipelineResult,
): void {
  const ledger = contained(cfg.data, join(cfg.data, "v2", "ledger"));
  secureDir(ledger);
  for (const checkpoint of result.coveredCheckpointIds) {
    const record = {
      version: 2,
      checkpointEntryId: checkpoint,
      runId: input.runId,
      action: result.action,
      proposalIds: result.proposalIds,
      coveredAt: new Date().toISOString(),
    };
    const path = join(ledger, `${checkpoint}.json`);
    const value = `${JSON.stringify(record, null, 2)}\n`;
    if (existsSync(path)) {
      const previous = JSON.parse(readFileSync(path, "utf8")) as {
        runId?: string;
      };
      if (previous.runId !== input.runId)
        throw new Error(`checkpoint ledger collision ${checkpoint}`);
    } else atomicWrite(path, value);
  }
}

export function processPipelineBatch(options: {
  cfg: MemoryConfig;
  scope: string;
  evidence: SafeEvidence[];
  model: string;
  invoke: (prompt: string) => string;
  skipExternal?: boolean;
}): PipelineResult {
  const fresh = freezePipelineInput(
    options.cfg,
    options.scope,
    options.evidence,
  );
  const input = existingFrozenInput(options.cfg, fresh) || fresh;
  const dir = runDir(options.cfg, input.runId);
  secureDir(dir);
  const inputPath = join(dir, "input.json");
  const inputValue = `${JSON.stringify(input, null, 2)}\n`;
  if (existsSync(inputPath) && readFileSync(inputPath, "utf8") !== inputValue)
    throw new Error("frozen pipeline input collision");
  if (!existsSync(inputPath)) atomicWrite(inputPath, inputValue);
  const outputPath = join(dir, "output.json");
  const raw = existsSync(outputPath)
    ? readFileSync(outputPath, "utf8")
    : options.skipExternal
      ? '{"action":"skip","reason":"external processing disabled"}'
      : options.invoke(buildReflectionPrompt(input));
  const parsed = parseModelProposal(raw);
  if (!existsSync(outputPath))
    atomicWrite(outputPath, `${JSON.stringify(parsed, null, 2)}\n`);
  const coveredCheckpointIds = input.evidence.flatMap(
    (item) => item.window.checkpointEntryIds,
  );
  const proposalIds: string[] = [];
  if (parsed.action === "propose") {
    const proposals = materializeModelProposals({
      result: parsed,
      runId: input.runId,
      model: options.model,
      evidence: input.evidence.map((item) => item.window),
      catalog: input.catalog,
      pending: listProposals(options.cfg),
      createdAt: input.createdAt,
    });
    for (const proposal of proposals) {
      saveProposal(options.cfg, proposal);
      proposalIds.push(proposal.id);
    }
  }
  const result: PipelineResult = {
    runId: input.runId,
    action: parsed.action,
    proposalIds,
    coveredCheckpointIds,
  };
  atomicWrite(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  markLedger(options.cfg, input, result);
  return result;
}

export function coveredCheckpointIds(cfg: MemoryConfig): Set<string> {
  const dir = contained(cfg.data, join(cfg.data, "v2", "ledger"));
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.startsWith("v1-"))
      .map((name) => basename(name, ".json")),
  );
}
