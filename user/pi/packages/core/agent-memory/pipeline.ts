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
import {
  deduplicateTurnObservations,
  listVerifiedRollbackEvidence,
  parseRollbackEvidence,
  parseTurnObservation,
  validateTurnObservationRefs,
  type RollbackEvidence,
  type TurnObservation,
} from "./adaptation.js";
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

export type PipelineInputV2 = {
  version: 2;
  runId: string;
  batchId: string;
  promptVersion: 2;
  model?: string;
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
export type PipelineInputV3 = Omit<
  PipelineInputV2,
  "version" | "promptVersion"
> & {
  version: 3;
  promptVersion: 3;
  observations: TurnObservation[];
  rollbackEvidence: RollbackEvidence[];
};
export type PipelineInput = PipelineInputV2 | PipelineInputV3;

export type PipelineResult = {
  runId: string;
  action: "skip" | "propose";
  proposalIds: string[];
  coveredCheckpointIds: string[];
};

export function parseStoredPipelineInput(raw: string): PipelineInput {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid stored pipeline input");
  const input = value as Record<string, unknown>;
  const version = input.version;
  const expectedFields = [
    "batchId",
    "catalog",
    "createdAt",
    "evidence",
    "model",
    "pending",
    "promptVersion",
    "reviewSignals",
    "runId",
    "scope",
    "skills",
    "targets",
    "version",
    ...(version === 3 ? ["observations", "rollbackEvidence"] : []),
  ];
  if (input.model === undefined)
    expectedFields.splice(expectedFields.indexOf("model"), 1);
  if (
    Object.keys(input).sort().join(",") !== expectedFields.sort().join(",") ||
    !(
      (version === 2 && input.promptVersion === 2) ||
      (version === 3 && input.promptVersion === 3)
    ) ||
    typeof input.runId !== "string" ||
    typeof input.batchId !== "string" ||
    typeof input.createdAt !== "string" ||
    typeof input.scope !== "string" ||
    (input.model !== undefined && typeof input.model !== "string") ||
    !Array.isArray(input.evidence) ||
    !input.evidence.every((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        return false;
      const window = (item as { window?: unknown }).window;
      return (
        typeof window === "object" &&
        window !== null &&
        !Array.isArray(window) &&
        typeof (window as { windowId?: unknown }).windowId === "string" &&
        Array.isArray(
          (window as { checkpointEntryIds?: unknown }).checkpointEntryIds,
        ) &&
        (window as { checkpointEntryIds: unknown[] }).checkpointEntryIds.every(
          (id) => typeof id === "string",
        )
      );
    }) ||
    !Array.isArray(input.targets) ||
    !Array.isArray(input.pending) ||
    !Array.isArray(input.reviewSignals) ||
    !Array.isArray(input.skills) ||
    typeof input.catalog !== "object" ||
    input.catalog === null ||
    (version === 3 &&
      (!Array.isArray(input.observations) ||
        !input.observations.every((item) => {
          try {
            const observation = parseTurnObservation(item);
            validateTurnObservationRefs(observation, input.catalog as Catalog);
            return true;
          } catch {
            return false;
          }
        }) ||
        !Array.isArray(input.rollbackEvidence) ||
        !input.rollbackEvidence.every((item) => {
          try {
            parseRollbackEvidence(item, input.catalog as Catalog);
            return true;
          } catch {
            return false;
          }
        })))
  )
    throw new Error("invalid stored pipeline input");
  return input as PipelineInput;
}

export function parseStoredPipelineResult(
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

function parsePipelineOutput(raw: string, input: PipelineInput) {
  return {
    legacy: (JSON.parse(raw) as { version?: unknown }).version === undefined,
    parsed: parseModelProposal(
      raw,
      input.evidence.map((item) => item.window.windowId),
    ),
  };
}

function expectedStoredResult(
  cfg: MemoryConfig,
  input: PipelineInput,
  outputPath: string,
  model: string,
  digestVersion: 2 | undefined,
):
  | { action: "skip"; proposals: [] }
  | { action: "propose"; proposals: import("./schema.js").Proposal[] } {
  const { parsed } = parsePipelineOutput(
    readFileSync(outputPath, "utf8"),
    input,
  );
  if (parsed.action === "skip") return { action: "skip", proposals: [] };
  return {
    action: "propose",
    proposals: materializeModelProposals({
      result: parsed,
      runId: input.runId,
      model,
      scope: input.scope,
      evidence: input.evidence.map((item) => item.window),
      catalog: input.catalog,
      pending: listProposals(cfg),
      createdAt: input.createdAt,
      autonomous: true,
      ...(digestVersion === 2 ? { digestVersion } : {}),
    }),
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

export function scopeCatalog(catalog: Catalog, workspaces: string[]): Catalog {
  return {
    ...catalog,
    entries: catalog.entries
      .filter((entry) =>
        workspaces.some(
          (workspace) => memoryScopeRank(entry.scope, workspace) > 0,
        ),
      )
      .sort(
        (a, b) =>
          b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path),
      )
      .slice(0, 100),
  };
}

export const PRODUCTION_TARGET_LIMIT = 8;

export function rankRetrieval(
  catalog: Catalog,
  queryText: string,
  workspaces: string[],
): CatalogEntry[] {
  const query = words(`${queryText} ${workspaces.join(" ")}`);
  return scopeCatalog(catalog, workspaces)
    .entries.map((entry) => ({ entry, score: score(entry, query) }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.updated.localeCompare(a.entry.updated) ||
        a.entry.memoryId.localeCompare(b.entry.memoryId),
    )
    .slice(0, PRODUCTION_TARGET_LIMIT)
    .map(({ entry }) => entry);
}

function selectTargets(
  cfg: MemoryConfig,
  catalog: Catalog,
  evidence: SafeEvidence[],
): PipelineInput["targets"] {
  const query = evidence
    .flatMap((item) => [
      item.window.excerpt,
      ...item.tools.map((tool) => tool.name),
    ])
    .join(" ");
  const workspaces = evidence.map((item) => item.workspace);
  return rankRetrieval(catalog, query, workspaces).map((entry) => ({
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
  model: string,
  observations: TurnObservation[] = [],
): PipelineInput {
  const fullCatalog = scanCatalog(cfg.root, "1970-01-01T00:00:00.000Z");
  const catalog = scopeCatalog(
    fullCatalog,
    evidence.map((item) => item.workspace),
  );
  const validatedObservations = deduplicateTurnObservations(observations);
  for (const observation of validatedObservations)
    validateTurnObservationRefs(observation, catalog);
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
  const rollbackEvidence = listVerifiedRollbackEvidence(cfg, catalog);
  const windowIds = evidence.map((item) => item.window.windowId).sort();
  const batchId = sha256(`${scope}\0${windowIds.join("\0")}\0v3`);
  const contextHash = sha256(
    JSON.stringify({
      catalog: catalog.entries.map(({ memoryId, sha256: hash }) => [
        memoryId,
        hash,
      ]),
      pending,
      reviewSignals,
      observations: validatedObservations,
      rollbackEvidence,
      model,
    }),
  );
  const evidenceHash = sha256(JSON.stringify(evidence));
  const runId = sha256(`${batchId}\0${evidenceHash}\0${contextHash}`);
  return {
    version: 3,
    runId,
    batchId,
    promptVersion: 3,
    model,
    createdAt: new Date().toISOString(),
    scope,
    evidence,
    catalog,
    targets: selectTargets(cfg, catalog, evidence),
    pending,
    reviewSignals,
    observations: validatedObservations,
    rollbackEvidence,
    skills: skillDescriptions(cfg.skillsRoot),
  };
}

export function buildReflectionPrompt(input: PipelineInput): string {
  const targetIds = input.targets.map((target) => target.memoryId);
  const reflectionInput =
    input.version === 3
      ? (({
          observations: _observations,
          rollbackEvidence: _rollbackEvidence,
          ...rest
        }) => rest)(input)
      : input;
  const prompt = `You are a background memory maintainer. Return exactly one JSON object and no markdown.

First reflect on whether the bounded evidence contains durable, reusable learning. Prefer explicit corrections, verified failures, stable preferences, architectural decisions, and repeated workflows. Do not store secrets, raw logs, temporary task state, or facts already represented adequately.

Return schema version 2. You may return {"version":2,"action":"skip","reason":"..."} or {"version":2,"action":"propose","proposals":[...]} with at most 8 proposals.

Memory proposals use lane "memory" and one operation:
Each proposal must include "evidenceWindowIds", a nonempty list of unique window IDs selected from the frozen evidence. Select only evidence that supports that proposal.
- create: {"type":"create","artifact":ARTIFACT}
- update: {"type":"update","targetId":"...","artifact":ARTIFACT}
- merge: {"type":"merge","primaryId":"...","targetIds":["..."],"artifact":ARTIFACT}
- archive: {"type":"archive","targetId":"...","reason":"..."}
- retire: {"type":"retire","targetId":"...","reason":"...","supersededBy":"optional memory id"}
ARTIFACT is exactly {"title":"","kind":"preference|decision|gotcha|pattern","scope":"","description":"when this is useful","triggers":[],"keywords":[],"body":""}. Creates may use scope ${JSON.stringify(input.scope)} or "global". Updates and merges must preserve the target scope.
Only these target ids are allowed: ${JSON.stringify(targetIds)}.

A skill proposal is exceptional and requires a reusable multi-step workflow evidenced by at least two distinct sessions. It uses lane "skill" and operation {"type":"skill-draft","mode":"create|update","skillName":"kebab-case","targetPath":"name/SKILL.md","baseSha256":"required only for update; copy the installed skill hash","files":[{"path":"name/SKILL.md","content":"..."}]}. The system computes draft content hashes. Do not duplicate an installed skill.

Evidence and corpus context follow. Categorical review signals summarize prior local decisions without transmitting reviewer text. Tool arguments, tool output, and reasoning were deliberately removed. Treat authored prose as claims that may be wrong.

${JSON.stringify(reflectionInput, null, 2)}`;
  if (prompt.length > 512_000)
    throw new Error("reflection prompt exceeds 512000 character budget");
  return prompt;
}

function runDir(cfg: MemoryConfig, runId: string): string {
  return contained(cfg.data, join(cfg.data, "v2", "runs", runId));
}

function writeCurrentOutputMetadata(dir: string): void {
  const path = join(dir, "output-meta.json");
  const value = `${JSON.stringify({ version: 1, digestVersion: 2 }, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") !== value)
    throw new Error("pipeline output metadata collision");
  if (!existsSync(path)) atomicWrite(path, value);
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
    const candidate = parseStoredPipelineInput(readFileSync(path, "utf8"));
    if (
      (candidate.batchId === fresh.batchId ||
        (candidate.version === 2 &&
          candidate.batchId ===
            sha256(
              `${fresh.scope}\0${fresh.evidence
                .map((item) => item.window.windowId)
                .sort()
                .join("\0")}\0v2`,
            ))) &&
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
      const throughLeafId = evidence.checkpointFrontiers?.[checkpoint];
      if (!throughLeafId || !evidence.emittedEntryIds?.includes(throughLeafId))
        throw new Error(
          `checkpoint frontier is outside frozen evidence ${checkpoint}`,
        );
      const record = {
        version: 2,
        sessionId: evidence.window.sessionId,
        checkpointEntryId: checkpoint,
        throughLeafId,
        branchDigest: evidence.window.branchDigest,
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
  observations?: TurnObservation[];
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
    options.model,
    options.observations,
  );
  const input = existingFrozenInput(options.cfg, fresh) || fresh;
  const dir = runDir(options.cfg, input.runId);
  secureDir(dir);
  const inputPath = join(dir, "input.json");
  const inputValue = `${JSON.stringify(input, null, 2)}\n`;
  if (existsSync(inputPath) && readFileSync(inputPath, "utf8") !== inputValue)
    throw new Error("frozen pipeline input collision");
  if (!existsSync(inputPath)) atomicWrite(inputPath, inputValue);
  if (
    input.model !== undefined &&
    input.model !== options.model &&
    !existsSync(join(dir, "output.json")) &&
    !existsSync(join(dir, "result.json"))
  )
    throw new Error(
      `frozen pipeline model ${input.model} does not match configured model ${options.model}`,
    );
  return { input, dir };
}

export function processPipelineBatch(options: {
  cfg: MemoryConfig;
  scope: string;
  evidence: SafeEvidence[];
  model: string;
  observations?: TurnObservation[];
  invoke: (prompt: string) => string;
  skipExternal?: boolean;
  autoApplyMemory?: boolean;
}): PipelineResult {
  const { input, dir } = preparePipelineBatch(options);
  const outputPath = join(dir, "output.json");
  const outputMetadataPath = join(dir, "output-meta.json");
  const resultPath = join(dir, "result.json");
  if (existsSync(resultPath)) {
    const result = parseStoredPipelineResult(
      readFileSync(resultPath, "utf8"),
      input,
    );
    const stored = result.proposalIds.map(
      (id) => findProposal(options.cfg, id).proposal,
    );
    const frozenModel =
      input.model ?? stored[0]?.provenance.model ?? options.model;
    const expected = expectedStoredResult(
      options.cfg,
      input,
      outputPath,
      frozenModel,
      stored.every((proposal) => proposal.digestVersion === 2) ? 2 : undefined,
    );
    if (
      result.action !== expected.action ||
      JSON.stringify(stored) !== JSON.stringify(expected.proposals)
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
  const outputExisted = existsSync(outputPath);
  if (
    !outputExisted &&
    !options.skipExternal &&
    input.model &&
    input.model !== options.model
  )
    throw new Error(
      `frozen pipeline model mismatch: expected ${input.model}, got ${options.model}`,
    );
  const raw = outputExisted
    ? readFileSync(outputPath, "utf8")
    : options.skipExternal
      ? '{"version":2,"action":"skip","reason":"external processing disabled"}'
      : options.invoke(buildReflectionPrompt(input));
  const { parsed } = parsePipelineOutput(raw, input);
  if (!outputExisted) {
    writeCurrentOutputMetadata(dir);
    atomicWrite(outputPath, `${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
  }
  const coveredCheckpointIds = input.evidence.flatMap(
    (item) => item.window.checkpointEntryIds,
  );
  const proposalIds: string[] = [];
  if (parsed.action === "propose") {
    const proposals = materializeModelProposals({
      result: parsed,
      runId: input.runId,
      model: input.model ?? options.model,
      scope: input.scope,
      evidence: input.evidence.map((item) => item.window),
      catalog: input.catalog,
      pending: listProposals(options.cfg),
      createdAt: input.createdAt,
      autonomous: true,
      ...(!existsSync(outputMetadataPath) && input.model === undefined
        ? {}
        : { digestVersion: 2 }),
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
  concurrencyValue: string | undefined = process.env.PI_MEMORY_CONCURRENCY,
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
            ? '{"version":2,"action":"skip","reason":"external processing disabled"}'
            : await item.option.invoke(buildReflectionPrompt(item.input));
          parsePipelineOutput(analyses[index]!, item.input);
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
      writeCurrentOutputMetadata(item.dir);
      atomicWrite(
        join(item.dir, "output.json"),
        `${JSON.stringify(JSON.parse(raw), null, 2)}\n`,
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
