import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import type { MemoryConfig } from "../catalog.js";
import type { Proposal } from "../schema.js";
import { parseStoredProposal } from "../workflow.js";
import {
  canonicalJson,
  durableCreate,
  durableWrite,
  object,
  safeRelativePath,
  sha256,
  timestamp,
  v3Data,
  type JsonValue,
} from "./common.js";
import { RESOURCE_LIMITS } from "./policy.js";
import type { ArtifactRef } from "./workflows.js";

export type ProposalState = "pending" | "reviewed" | "expired";

export type ProposalIndexRecord = {
  schemaVersion: 3;
  proposalId: string;
  proposalSha256: string;
  state: ProposalState;
  artifact: ArtifactRef;
  createdAt: string;
  expiresAt: string;
  admissionDecisionId: string | null;
};

export type TransactionIndexRecord = {
  schemaVersion: 3;
  transactionId: string;
  state: string;
  terminal: boolean;
  artifact: ArtifactRef;
  importedAt: string;
};

type IndexConfig = Pick<MemoryConfig, "data">;
const proposalIndexPath = (cfg: IndexConfig, proposalId: string): string => {
  const digest = sha256(proposalId);
  return v3Data(
    cfg,
    "indexes/proposals",
    digest.slice(0, 2),
    `${proposalId}.json`,
  );
};
const proposalPath = (
  cfg: IndexConfig,
  state: ProposalState,
  proposalId: string,
): string => {
  const digest = sha256(proposalId);
  return v3Data(
    cfg,
    `proposals/${state}`,
    digest.slice(0, 2),
    `${proposalId}.json`,
  );
};
const transactionPath = (
  cfg: IndexConfig,
  terminal: boolean,
  transactionId: string,
): string =>
  v3Data(
    cfg,
    `indexes/transactions/${terminal ? "terminal" : "nonterminal"}`,
    `${transactionId}.json`,
  );

function artifact(cfg: IndexConfig, bytes: string): ArtifactRef {
  const digest = sha256(bytes);
  const path = v3Data(cfg, "artifacts/sha256", digest.slice(0, 2), digest);
  if (!durableCreate(path, bytes) && readFileSync(path, "utf8") !== bytes)
    throw new Error("indexed artifact collision");
  return {
    sha256: digest,
    relativePath: relative(v3Data(cfg), path),
    bytes: Buffer.byteLength(bytes),
  };
}

function proposalIdentity(value: unknown): { id: string; createdAt: string } {
  if (
    !object(value) ||
    value.version !== 2 ||
    typeof value.id !== "string" ||
    !/^prop_[a-f0-9]{32}$/.test(value.id) ||
    value.status !== "pending" ||
    !object(value.provenance) ||
    typeof value.provenance.createdAt !== "string"
  )
    throw new Error("invalid indexed proposal");
  timestamp(value.provenance.createdAt, "proposal createdAt");
  return { id: value.id, createdAt: value.provenance.createdAt };
}

export function saveIndexedProposal(
  cfg: IndexConfig,
  proposal: Proposal,
  state: ProposalState = "pending",
  expiresAt: string = new Date(
    Date.parse(proposal.provenance.createdAt) + 30 * 86_400_000,
  ).toISOString(),
): ProposalIndexRecord {
  proposal = parseStoredProposal(JSON.stringify(proposal));
  const bytes = `${canonicalJson(proposal as unknown as JsonValue)}\n`;
  if (Buffer.byteLength(bytes) > RESOURCE_LIMITS.maxArtifactBytes)
    throw new Error("proposal exceeds size cap");
  const identity = proposalIdentity(proposal);
  timestamp(expiresAt, "proposal expiresAt");
  const payload = artifact(cfg, bytes);
  const record: ProposalIndexRecord = {
    schemaVersion: 3,
    proposalId: identity.id,
    proposalSha256: sha256(bytes),
    state,
    artifact: payload,
    createdAt: identity.createdAt,
    expiresAt,
    admissionDecisionId: null,
  };
  const storedPath = proposalPath(cfg, state, identity.id);
  if (
    !durableCreate(storedPath, `${JSON.stringify(record, null, 2)}\n`) &&
    readFileSync(storedPath, "utf8") !== `${JSON.stringify(record, null, 2)}\n`
  )
    throw new Error(`proposal collision ${identity.id}`);
  const indexPath = proposalIndexPath(cfg, identity.id);
  if (existsSync(indexPath)) {
    const existing = parseProposalIndex(
      JSON.parse(readFileSync(indexPath, "utf8")),
    );
    if (
      existing.proposalSha256 !== record.proposalSha256 ||
      existing.state !== record.state
    )
      throw new Error(`proposal index collision ${identity.id}`);
    return existing;
  }
  durableWrite(indexPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function parseProposalIndex(value: unknown): ProposalIndexRecord {
  if (
    !object(value) ||
    value.schemaVersion !== 3 ||
    typeof value.proposalId !== "string" ||
    typeof value.proposalSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.proposalSha256) ||
    !["pending", "reviewed", "expired"].includes(String(value.state)) ||
    !object(value.artifact) ||
    typeof value.artifact.relativePath !== "string" ||
    typeof value.artifact.sha256 !== "string" ||
    !Number.isSafeInteger(value.artifact.bytes) ||
    (value.admissionDecisionId !== null &&
      typeof value.admissionDecisionId !== "string")
  )
    throw new Error("invalid proposal index");
  safeRelativePath(value.artifact.relativePath);
  timestamp(value.createdAt, "proposal index createdAt");
  timestamp(value.expiresAt, "proposal index expiresAt");
  return value as ProposalIndexRecord;
}

export function findIndexedProposal(
  cfg: IndexConfig,
  proposalId: string,
  read: (path: string, encoding: "utf8") => string = readFileSync,
): { proposal: Proposal; index: ProposalIndexRecord } {
  const index = parseProposalIndex(
    JSON.parse(read(proposalIndexPath(cfg, proposalId), "utf8")),
  );
  if (index.proposalId !== proposalId)
    throw new Error("proposal index identity changed");
  const bytes = read(v3Data(cfg, index.artifact.relativePath), "utf8");
  if (
    Buffer.byteLength(bytes) !== index.artifact.bytes ||
    sha256(bytes) !== index.artifact.sha256 ||
    sha256(bytes) !== index.proposalSha256
  )
    throw new Error("proposal artifact binding changed");
  const proposal = JSON.parse(bytes) as Proposal;
  if (proposalIdentity(proposal).id !== proposalId)
    throw new Error("proposal artifact identity changed");
  return { proposal, index };
}

function jsonFiles(
  root: string,
  limit: number,
  result: string[] = [],
): string[] {
  if (!existsSync(root) || result.length >= limit) return result;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (result.length >= limit) break;
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink())
      jsonFiles(path, limit, result);
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(path);
  }
  return result;
}

export function listIndexedProposals(
  cfg: IndexConfig,
  states: readonly ProposalState[] = ["pending", "reviewed", "expired"],
): ProposalIndexRecord[] {
  const root = v3Data(cfg, "indexes/proposals");
  return jsonFiles(root, RESOURCE_LIMITS.maxProposalBacklog)
    .map((path) => parseProposalIndex(JSON.parse(readFileSync(path, "utf8"))))
    .filter((record) => states.includes(record.state))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.proposalId.localeCompare(right.proposalId),
    );
}

export function markIndexedProposal(
  cfg: IndexConfig,
  proposalId: string,
  state: Exclude<ProposalState, "pending">,
  admissionDecisionId: string | null,
): ProposalIndexRecord {
  const found = findIndexedProposal(cfg, proposalId);
  if (found.index.state !== "pending") {
    if (
      found.index.state !== state ||
      found.index.admissionDecisionId !== admissionDecisionId
    )
      throw new Error("proposal terminal state changed");
    return found.index;
  }
  const next: ProposalIndexRecord = {
    ...found.index,
    state,
    admissionDecisionId,
  };
  durableWrite(
    proposalPath(cfg, state, proposalId),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  durableWrite(
    proposalIndexPath(cfg, proposalId),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  rmSync(proposalPath(cfg, "pending", proposalId), { force: true });
  return next;
}

export function indexTransaction(
  cfg: IndexConfig,
  raw: string,
  importedAt: string = new Date().toISOString(),
): TransactionIndexRecord {
  const value: unknown = JSON.parse(raw);
  const identity = transactionIdentity(value);
  timestamp(importedAt, "transaction importedAt");
  const terminal =
    identity.state === "applied" || identity.state === "rolled-back";
  const record: TransactionIndexRecord = {
    schemaVersion: 3,
    transactionId: identity.id,
    state: identity.state,
    terminal,
    artifact: artifact(cfg, raw),
    importedAt,
  };
  durableWrite(
    transactionPath(cfg, terminal, identity.id),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

function transactionIdentity(value: unknown): { id: string; state: string } {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9_.-]+$/.test(value.id) ||
    typeof value.state !== "string" ||
    !["prepared", "applied", "rollback-prepared", "rolled-back"].includes(
      value.state,
    )
  )
    throw new Error("invalid indexed transaction");
  return { id: value.id, state: value.state };
}

export function listNonterminalTransactions(
  cfg: IndexConfig,
): TransactionIndexRecord[] {
  const dir = v3Data(cfg, "indexes/transactions/nonterminal");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const record = JSON.parse(
        readFileSync(join(dir, name), "utf8"),
      ) as TransactionIndexRecord;
      if (
        record.schemaVersion !== 3 ||
        record.terminal ||
        `${record.transactionId}.json` !== name
      )
        throw new Error("invalid nonterminal transaction index");
      return record;
    });
}

export type V2ImportReport = {
  schemaVersion: 3;
  importedAt: string;
  proposals: number;
  transactions: number;
  unresolved: Array<{ path: string; reason: string }>;
};

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(path, name));
}

export function importV2Indexes(
  cfg: IndexConfig,
  clock: () => Date = () => new Date(),
  options: { dryRun?: boolean } = {},
): V2ImportReport {
  const importedAt = clock().toISOString();
  let proposals = 0;
  let transactions = 0;
  const unresolved: V2ImportReport["unresolved"] = [];
  for (const state of ["pending", "reviewed"] as const)
    for (const path of files(join(cfg.data, "v2/proposals", state))) {
      try {
        const proposal = parseStoredProposal(readFileSync(path, "utf8"));
        if (!options.dryRun) saveIndexedProposal(cfg, proposal, state);
        proposals += 1;
      } catch (error) {
        unresolved.push({
          path: relative(cfg.data, path),
          reason:
            error instanceof Error ? error.message.slice(0, 300) : "unknown",
        });
      }
    }
  for (const path of files(join(cfg.data, "v2/transactions"))) {
    try {
      const raw = readFileSync(path, "utf8");
      transactionIdentity(JSON.parse(raw));
      if (!options.dryRun) indexTransaction(cfg, raw, importedAt);
      transactions += 1;
    } catch (error) {
      unresolved.push({
        path: relative(cfg.data, path),
        reason:
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
      });
    }
  }
  const report: V2ImportReport = {
    schemaVersion: 3,
    importedAt,
    proposals,
    transactions,
    unresolved,
  };
  if (!options.dryRun)
    durableWrite(
      v3Data(cfg, "migration/v2-import-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  return report;
}

export function parseV2ImportReport(value: unknown): V2ImportReport {
  if (
    !object(value) ||
    value.schemaVersion !== 3 ||
    !Number.isSafeInteger(value.proposals) ||
    Number(value.proposals) < 0 ||
    !Number.isSafeInteger(value.transactions) ||
    Number(value.transactions) < 0 ||
    !Array.isArray(value.unresolved) ||
    !value.unresolved.every(
      (item) =>
        object(item) &&
        typeof item.path === "string" &&
        typeof item.reason === "string",
    )
  )
    throw new Error("invalid v2 import report");
  timestamp(value.importedAt, "v2 import report importedAt");
  return value as V2ImportReport;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { canonicalProposalId } = await import("../schema.js");

  function fixtureProposal(): Proposal {
    const withoutId = {
      version: 2 as const,
      digestVersion: 2 as const,
      lane: "memory" as const,
      status: "pending" as const,
      operation: {
        type: "create" as const,
        artifact: {
          memoryId: "mem_000000000000000000000000",
          title: "test",
          kind: "preference" as const,
          scope: "global",
          description: "test preference",
          triggers: ["test"],
          keywords: ["test"],
          sources: ["pi://session/checkpoint"],
          created: "2026-09-03",
          updated: "2026-09-03",
          body: "use the test command",
        },
      },
      supersedes: [],
      evidence: [],
      provenance: {
        runId: "run_test",
        promptVersion: 1,
        model: "test",
        createdAt: "2026-09-03T12:00:00.000Z",
        corpusAware: true,
      },
    };
    return { ...withoutId, id: canonicalProposalId(withoutId) };
  }

  describe("direct v3 indexes", () => {
    it("resolves one proposal through one index regardless of backlog size", () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-index-")) };
      const proposal = fixtureProposal();
      saveIndexedProposal(cfg, proposal);
      for (let index = 0; index < 200; index += 1)
        durableWrite(
          v3Data(cfg, "proposals/pending/ff", `noise-${index}.json`),
          "{}\n",
        );
      let reads = 0;
      const found = findIndexedProposal(cfg, proposal.id, (path, encoding) => {
        reads += 1;
        return readFileSync(path, encoding);
      });
      expect(found.proposal).toEqual(proposal);
      expect(reads).toBe(2);
    });

    it("normal recovery reads only nonterminal transactions", () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-index-")) };
      for (let index = 0; index < 200; index += 1)
        indexTransaction(
          cfg,
          JSON.stringify({
            version: 1,
            id: `terminal_${index}`,
            reviewId: `review_${index}`,
            state: "applied",
            actions: [],
          }),
          "2026-09-03T12:00:00.000Z",
        );
      indexTransaction(
        cfg,
        JSON.stringify({
          version: 1,
          id: "active",
          reviewId: "review_active",
          state: "prepared",
          actions: [],
        }),
        "2026-09-03T12:00:00.000Z",
      );
      expect(
        listNonterminalTransactions(cfg).map((item) => item.transactionId),
      ).toEqual(["active"]);
    });

    it("imports real v2 directory shapes and reports malformed records", () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-index-")) };
      mkdirSync(join(cfg.data, "v2/proposals/pending"), { recursive: true });
      mkdirSync(join(cfg.data, "v2/transactions"), { recursive: true });
      const proposal = fixtureProposal();
      writeFileSync(
        join(cfg.data, "v2/proposals/pending/proposal.json"),
        `${JSON.stringify(proposal)}\n`,
      );
      writeFileSync(
        join(cfg.data, "v2/transactions/transaction.json"),
        `${JSON.stringify({ version: 1, id: "tx", reviewId: "review", state: "prepared", actions: [] })}\n`,
      );
      writeFileSync(join(cfg.data, "v2/transactions/bad.json"), "{}\n");
      const report = importV2Indexes(
        cfg,
        () => new Date("2026-09-03T12:00:00.000Z"),
      );
      expect(report).toMatchObject({
        proposals: 1,
        transactions: 1,
        unresolved: [{ path: "v2/transactions/bad.json" }],
      });
      expect(findIndexedProposal(cfg, proposal.id).proposal.id).toBe(
        proposal.id,
      );
      expect(listNonterminalTransactions(cfg)).toHaveLength(1);
      rmSync(join(cfg.data, "v3"), { recursive: true });
      expect(
        importV2Indexes(cfg, () => new Date("2026-09-03T12:00:00.000Z")),
      ).toEqual(report);
      expect(findIndexedProposal(cfg, proposal.id).proposal.id).toBe(
        proposal.id,
      );
    });

    it("validates migration in report-only mode without creating v3 state", () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-index-")) };
      mkdirSync(join(cfg.data, "v2/proposals/pending"), { recursive: true });
      writeFileSync(
        join(cfg.data, "v2/proposals/pending/proposal.json"),
        `${JSON.stringify(fixtureProposal())}\n`,
      );
      const report = importV2Indexes(cfg, () => new Date(), { dryRun: true });
      expect(report).toMatchObject({ proposals: 1, unresolved: [] });
      expect(existsSync(join(cfg.data, "v3"))).toBe(false);
    });
  });
}
