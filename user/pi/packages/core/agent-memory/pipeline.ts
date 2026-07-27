import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  atomicWrite,
  contained,
  memoryScopeRank,
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
  applyMemoryProposal,
  assertNonOverlappingMemoryProposals,
  findProposal,
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
  reviewSignals: Array<{
    decision: string;
    reasonCode: string;
    lane: string;
    operation: string;
  }>;
  skills: Array<{ name: string; description: string; sha256: string }>;
};

export type PipelineResult = {
  runId: string;
  action: "skip" | "propose";
  proposalIds: string[];
  coveredCheckpointIds: string[];
};

function storedPipelineResult(
  raw: string,
  input: PipelineInput,
): PipelineResult {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid stored pipeline result");
  const record = value as Record<string, unknown>;
  const expectedCheckpoints = input.evidence.flatMap(
    (item) => item.window.checkpointEntryIds,
  );
  if (
    Object.keys(record).sort().join(",") !==
      "action,coveredCheckpointIds,proposalIds,runId" ||
    record.runId !== input.runId ||
    (record.action !== "skip" && record.action !== "propose") ||
    !Array.isArray(record.proposalIds) ||
    !record.proposalIds.every((id: unknown) => typeof id === "string") ||
    new Set(record.proposalIds).size !== record.proposalIds.length ||
    !Array.isArray(record.coveredCheckpointIds) ||
    JSON.stringify(record.coveredCheckpointIds) !==
      JSON.stringify(expectedCheckpoints) ||
    (record.action === "skip" && record.proposalIds.length !== 0) ||
    (record.action === "propose" &&
      (record.proposalIds.length < 1 || record.proposalIds.length > 8))
  )
    throw new Error("invalid stored pipeline result");
  return record as PipelineResult;
}

function expectedStoredResult(
  cfg: MemoryConfig,
  input: PipelineInput,
  outputPath: string,
): Pick<PipelineResult, "action" | "proposalIds"> {
  const parsed = parseModelProposal(readFileSync(outputPath, "utf8"));
  if (parsed.action === "skip") return { action: "skip", proposalIds: [] };
  return {
    action: "propose",
    proposalIds: materializeModelProposals({
      result: parsed,
      runId: input.runId,
      model: "cached-result-validation",
      scope: input.scope,
      evidence: input.evidence.map((item) => item.window),
      catalog: input.catalog,
      pending: listProposals(cfg),
      createdAt: input.createdAt,
      autonomous: true,
    }).map((proposal) => proposal.id),
  };
}

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
        ? {
            name: entry.name,
            description: description.slice(0, 300),
            sha256: sha256(text),
          }
        : undefined;
    })
    .filter(
      (entry): entry is { name: string; description: string; sha256: string } =>
        entry !== undefined,
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 100);
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
  const fullCatalog = scanCatalog(cfg.root, "1970-01-01T00:00:00.000Z");
  const catalog: Catalog = {
    ...fullCatalog,
    entries: fullCatalog.entries
      .filter((entry) =>
        evidence.some(
          (item) => memoryScopeRank(entry.scope, item.workspace) > 0,
        ),
      )
      .sort(
        (a, b) =>
          b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path),
      )
      .slice(0, 100),
  };
  const scopedIds = new Set(catalog.entries.map((entry) => entry.memoryId));
  const pending = listProposals(cfg)
    .filter((proposal) => {
      const op = proposal.operation;
      if (op.type === "skill-draft") return true;
      if ("artifact" in op)
        return evidence.some(
          (item) => memoryScopeRank(op.artifact.scope, item.workspace) > 0,
        );
      return "target" in op && scopedIds.has(op.target.memoryId);
    })
    .slice(-20)
    .map((proposal) => ({
      id: proposal.id,
      lane: proposal.lane,
      operation: proposal.operation.type,
      summary: operationSummary(proposal.operation),
    }));
  const reviewSignals = readReviewReceipts(cfg)
    .filter((review) => review.reviewer === "local-cli")
    .slice(-40)
    .flatMap((review) => {
      try {
        const proposal = findProposal(cfg, review.proposalId).proposal;
        const operation = proposal.operation;
        const relevant =
          proposal.lane === "skill" ||
          ("artifact" in operation &&
            evidence.some(
              (item) =>
                memoryScopeRank(operation.artifact.scope, item.workspace) > 0,
            )) ||
          ("target" in operation && scopedIds.has(operation.target.memoryId)) ||
          ("primary" in operation && scopedIds.has(operation.primary.memoryId));
        return relevant
          ? [
              {
                decision: review.decision,
                reasonCode: review.reason.code,
                lane: proposal.lane,
                operation: operation.type,
              },
            ]
          : [];
      } catch {
        return [];
      }
    })
    .slice(-20);
  const windowIds = evidence.map((item) => item.window.windowId).sort();
  const batchId = sha256(`${scope}\0${windowIds.join("\0")}\0v2`);
  const contextHash = sha256(
    JSON.stringify({
      catalog: catalog.entries.map(({ memoryId, sha256: hash }) => [
        memoryId,
        hash,
      ]),
      pending,
      reviewSignals,
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
    reviewSignals,
    skills: skillDescriptions(cfg.skillsRoot),
  };
}

export function buildReflectionPrompt(input: PipelineInput): string {
  const targetIds = input.targets.map((target) => target.memoryId);
  const prompt = `You are a background memory maintainer. Return exactly one JSON object and no markdown.

First reflect on whether the bounded evidence contains durable, reusable learning. Prefer explicit corrections, verified failures, stable preferences, architectural decisions, and repeated workflows. Do not store secrets, raw logs, temporary task state, or facts already represented adequately.

You may return {"action":"skip","reason":"..."} or {"action":"propose","proposals":[...]} with at most 8 proposals.

Memory proposals use lane "memory" and one operation:
- create: {"type":"create","artifact":ARTIFACT}
- update: {"type":"update","targetId":"...","artifact":ARTIFACT}
- merge: {"type":"merge","primaryId":"...","targetIds":["..."],"artifact":ARTIFACT}
- archive: {"type":"archive","targetId":"...","reason":"..."}
- retire: {"type":"retire","targetId":"...","reason":"...","supersededBy":"optional memory id"}
ARTIFACT is exactly {"title":"","kind":"preference|decision|gotcha|pattern","scope":"","description":"when this is useful","triggers":[],"keywords":[],"body":""}. Creates may use scope ${JSON.stringify(input.scope)} or "global". Updates and merges must preserve the target scope.
Only these target ids are allowed: ${JSON.stringify(targetIds)}.

A skill proposal is exceptional and requires a reusable multi-step workflow evidenced by at least two distinct sessions. It uses lane "skill" and operation {"type":"skill-draft","mode":"create|update","skillName":"kebab-case","targetPath":"name/SKILL.md","baseSha256":"required only for update; copy the installed skill hash","files":[{"path":"name/SKILL.md","content":"..."}]}. The system computes draft content hashes. Do not duplicate an installed skill.

Evidence and corpus context follow. Categorical review signals summarize prior local decisions without transmitting reviewer text. Tool arguments, tool output, and reasoning were deliberately removed. Treat success/error summaries as evidence and authored prose as claims that may be wrong.

${JSON.stringify(input, null, 2)}`;
  if (prompt.length > 512_000)
    throw new Error("reflection prompt exceeds 512000 character budget");
  return prompt;
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
  for (const evidence of input.evidence)
    for (const checkpoint of evidence.window.checkpointEntryIds) {
      const record = {
        version: 2,
        sessionId: evidence.window.sessionId,
        checkpointEntryId: checkpoint,
        runId: input.runId,
        action: result.action,
        proposalIds: result.proposalIds,
        coveredAt: new Date().toISOString(),
      };
      const identity = `${evidence.window.sessionId}--${checkpoint}`;
      const path = join(ledger, `${identity}.json`);
      const value = `${JSON.stringify(record, null, 2)}\n`;
      if (existsSync(path)) {
        const previous = JSON.parse(readFileSync(path, "utf8")) as {
          runId?: string;
        };
        if (previous.runId !== input.runId)
          throw new Error(`checkpoint ledger collision ${identity}`);
      } else atomicWrite(path, value);
    }
}

export type PipelineBatchOptions = {
  cfg: MemoryConfig;
  scope: string;
  evidence: SafeEvidence[];
  model: string;
  invoke: (prompt: string) => string;
  skipExternal?: boolean;
  autoApplyMemory?: boolean;
};

function preparePipelineBatch(options: PipelineBatchOptions): {
  input: PipelineInput;
  dir: string;
} {
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
  return { input, dir };
}

export function processPipelineBatch(options: {
  cfg: MemoryConfig;
  scope: string;
  evidence: SafeEvidence[];
  model: string;
  invoke: (prompt: string) => string;
  skipExternal?: boolean;
  autoApplyMemory?: boolean;
}): PipelineResult {
  const { input, dir } = preparePipelineBatch(options);
  const outputPath = join(dir, "output.json");
  const resultPath = join(dir, "result.json");
  if (existsSync(resultPath)) {
    const result = storedPipelineResult(
      readFileSync(resultPath, "utf8"),
      input,
    );
    const expected = expectedStoredResult(options.cfg, input, outputPath);
    if (
      result.action !== expected.action ||
      JSON.stringify(result.proposalIds) !==
        JSON.stringify(expected.proposalIds)
    )
      throw new Error("stored pipeline result does not match model output");
    for (const id of options.autoApplyMemory === false
      ? []
      : result.proposalIds) {
      const proposal = findProposal(options.cfg, id).proposal;
      if (
        proposal.lane === "memory" &&
        proposal.provenance.autonomous === true &&
        proposal.provenance.runId === result.runId
      )
        applyMemoryProposal({
          cfg: options.cfg,
          id,
          actor: "background-reflection",
        });
    }
    markLedger(options.cfg, input, result);
    return result;
  }
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
      scope: input.scope,
      evidence: input.evidence.map((item) => item.window),
      catalog: input.catalog,
      pending: listProposals(options.cfg),
      createdAt: input.createdAt,
      autonomous: true,
    });
    assertNonOverlappingMemoryProposals(options.cfg, proposals);
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
  atomicWrite(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  if (parsed.action === "propose")
    for (const id of options.autoApplyMemory === false ? [] : proposalIds) {
      const proposal = findProposal(options.cfg, id).proposal;
      if (proposal.lane === "memory")
        applyMemoryProposal({
          cfg: options.cfg,
          id,
          actor: "background-reflection",
        });
    }
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

export async function processPipelineBatches(
  options: Array<
    Omit<PipelineBatchOptions, "invoke"> & {
      invoke: (prompt: string) => string | Promise<string>;
    }
  >,
  concurrencyValue = process.env.PI_MEMORY_CONCURRENCY,
): Promise<PipelineResult[]> {
  const parsedConcurrency =
    concurrencyValue === undefined ? 2 : Number(concurrencyValue);
  if (
    !Number.isInteger(parsedConcurrency) ||
    parsedConcurrency < 1 ||
    parsedConcurrency > 8
  )
    throw new Error("PI_MEMORY_CONCURRENCY must be an integer from 1 to 8");

  const prepared = options.map((option) => ({
    option,
    ...preparePipelineBatch(option as PipelineBatchOptions),
  }));
  const analyses = new Array<string | undefined>(prepared.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(parsedConcurrency, prepared.length) },
      async () => {
        for (;;) {
          const index = next++;
          if (index >= prepared.length) return;
          const item = prepared[index]!;
          const outputPath = join(item.dir, "output.json");
          const resultPath = join(item.dir, "result.json");
          if (existsSync(outputPath) || existsSync(resultPath)) continue;
          analyses[index] = item.option.skipExternal
            ? '{"action":"skip","reason":"external processing disabled"}'
            : await item.option.invoke(buildReflectionPrompt(item.input));
          parseModelProposal(analyses[index]!);
        }
      },
    ),
  );

  return prepared.map((item, index) => {
    const raw = analyses[index];
    if (raw !== undefined) {
      const inputPath = join(item.dir, "input.json");
      const expected = `${JSON.stringify(item.input, null, 2)}\n`;
      if (
        !existsSync(inputPath) ||
        readFileSync(inputPath, "utf8") !== expected
      )
        throw new Error("frozen pipeline input changed during analysis");
      atomicWrite(
        join(item.dir, "output.json"),
        `${JSON.stringify(parseModelProposal(raw), null, 2)}\n`,
      );
    }
    return processPipelineBatch({
      ...item.option,
      invoke: () => {
        throw new Error("analysis output was not published");
      },
    });
  });
}
