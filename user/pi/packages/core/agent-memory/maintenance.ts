import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  scanCatalog,
  sha256,
  type CatalogEntry,
  type MemoryConfig,
} from "./catalog.js";
import { isHistoryInitialized, listHistory } from "./history.js";
import { memoryRef, type MemoryRef } from "./schema.js";

export type PathologyType =
  | "duplicate-exact"
  | "overlap-cluster"
  | "source-fragmentation"
  | "provenance-gap"
  | "oversized-artifact"
  | "prompt-pressure"
  | "rewrite-churn";

export type CorpusPathology = {
  version: 1;
  id: string;
  type: PathologyType;
  scope: string;
  metric: { name: string; value: number; threshold: number };
  basis: {
    historyCommit?: string;
    catalogSha256: string;
    targets: MemoryRef[];
  };
  allowedOperations: Array<"patch" | "deduplicate" | "archive" | "retire">;
};

export type CorpusHealthReport = {
  version: 1;
  catalogSha256: string;
  historyCommit?: string;
  pathologies: CorpusPathology[];
};

type Artifact = {
  entry: CatalogEntry;
  body: string;
  normalizedBody: string;
  tokens: Set<string>;
  sources: string[];
  lines: number;
};

const BODY_LIMIT = 6_000;
const LINE_LIMIT = 100;
const PROMPT_ENTRY_LIMIT = 30;

function frontmatterArray(text: string, field: string): string[] {
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1];
  const raw = frontmatter
    ? new RegExp(`^${field}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]
    : undefined;
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function body(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function pathology(
  report: Omit<CorpusPathology, "version" | "id">,
): CorpusPathology {
  const id = `health_${sha256(JSON.stringify(report)).slice(0, 24)}`;
  return { version: 1, id, ...report };
}

function targetBasis(
  catalogSha256: string,
  historyCommit: string | undefined,
  entries: CatalogEntry[],
): CorpusPathology["basis"] {
  return {
    ...(historyCommit ? { historyCommit } : {}),
    catalogSha256,
    targets: entries
      .map(memoryRef)
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function scanCorpusHealth(cfg: MemoryConfig): CorpusHealthReport {
  const catalog = scanCatalog(cfg.root, "1970-01-01T00:00:00.000Z");
  const catalogSha256 = sha256(JSON.stringify(catalog));
  const history = isHistoryInitialized(cfg)
    ? listHistory(cfg, { limit: 10 })
    : [];
  const historyCommit = history[0]?.commit;
  const artifacts: Artifact[] = catalog.entries.map((entry) => {
    const text = readFileSync(join(cfg.root, entry.path), "utf8");
    const content = body(text);
    return {
      entry,
      body: content,
      normalizedBody: normalize(content),
      tokens: tokens(content),
      sources: [...new Set(frontmatterArray(text, "sources"))],
      lines: content.split("\n").filter((line) => line.trim()).length,
    };
  });
  const pathologies: CorpusPathology[] = [];
  const seenPairs = new Set<string>();

  for (let leftIndex = 0; leftIndex < artifacts.length; leftIndex++)
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < artifacts.length;
      rightIndex++
    ) {
      const left = artifacts[leftIndex]!;
      const right = artifacts[rightIndex]!;
      if (left.entry.scope !== right.entry.scope) continue;
      const pair = [left.entry, right.entry];
      const pairId = pair
        .map((entry) => entry.memoryId)
        .sort()
        .join(":");
      if (left.normalizedBody && left.normalizedBody === right.normalizedBody) {
        seenPairs.add(pairId);
        pathologies.push(
          pathology({
            type: "duplicate-exact",
            scope: left.entry.scope,
            metric: {
              name: "normalized-body-equality",
              value: 1,
              threshold: 1,
            },
            basis: targetBasis(catalogSha256, historyCommit, pair),
            allowedOperations: ["deduplicate", "archive", "retire"],
          }),
        );
        continue;
      }
      const overlap = jaccard(left.tokens, right.tokens);
      if (
        !seenPairs.has(pairId) &&
        Math.min(left.tokens.size, right.tokens.size) >= 12 &&
        overlap >= 0.8
      )
        pathologies.push(
          pathology({
            type: "overlap-cluster",
            scope: left.entry.scope,
            metric: { name: "token-jaccard", value: overlap, threshold: 0.8 },
            basis: targetBasis(catalogSha256, historyCommit, pair),
            allowedOperations: ["patch", "deduplicate", "archive", "retire"],
          }),
        );
    }

  const bySource = new Map<string, Artifact[]>();
  for (const artifact of artifacts)
    for (const source of artifact.sources)
      bySource.set(source, [...(bySource.get(source) ?? []), artifact]);
  for (const [source, members] of bySource)
    if (
      members.length >= 3 &&
      members.some((left, index) =>
        members
          .slice(index + 1)
          .some((right) => jaccard(left.tokens, right.tokens) >= 0.5),
      )
    )
      pathologies.push(
        pathology({
          type: "source-fragmentation",
          scope: members[0]!.entry.scope,
          metric: {
            name: `memories-for-source:${source}`,
            value: members.length,
            threshold: 3,
          },
          basis: targetBasis(
            catalogSha256,
            historyCommit,
            members.map((member) => member.entry),
          ),
          allowedOperations: ["patch", "deduplicate", "archive", "retire"],
        }),
      );

  for (const artifact of artifacts) {
    const basis = targetBasis(catalogSha256, historyCommit, [artifact.entry]);
    if (!artifact.entry.legacy && artifact.sources.length === 0)
      pathologies.push(
        pathology({
          type: "provenance-gap",
          scope: artifact.entry.scope,
          metric: { name: "source-count", value: 0, threshold: 1 },
          basis,
          allowedOperations: [],
        }),
      );
    if (artifact.body.length > BODY_LIMIT || artifact.lines > LINE_LIMIT)
      pathologies.push(
        pathology({
          type: "oversized-artifact",
          scope: artifact.entry.scope,
          metric:
            artifact.body.length > BODY_LIMIT
              ? {
                  name: "body-characters",
                  value: artifact.body.length,
                  threshold: BODY_LIMIT,
                }
              : {
                  name: "nonblank-lines",
                  value: artifact.lines,
                  threshold: LINE_LIMIT,
                },
          basis,
          allowedOperations: artifact.sources.length ? ["patch"] : [],
        }),
      );
  }

  const byScope = new Map<string, CatalogEntry[]>();
  for (const entry of catalog.entries)
    byScope.set(entry.scope, [...(byScope.get(entry.scope) ?? []), entry]);
  for (const [scope, entries] of byScope)
    if (entries.length > PROMPT_ENTRY_LIMIT)
      pathologies.push(
        pathology({
          type: "prompt-pressure",
          scope,
          metric: {
            name: "eligible-catalog-entries",
            value: entries.length,
            threshold: PROMPT_ENTRY_LIMIT,
          },
          basis: targetBasis(catalogSha256, historyCommit, entries),
          allowedOperations: [],
        }),
      );

  const changed = new Map<string, number>();
  for (const entry of history)
    for (const change of entry.receipt.changes)
      changed.set(change.path, (changed.get(change.path) ?? 0) + 1);
  for (const [path, count] of changed)
    if (count >= 3) {
      const entry = catalog.entries.find(
        (candidate) => candidate.path === path,
      );
      if (entry)
        pathologies.push(
          pathology({
            type: "rewrite-churn",
            scope: entry.scope,
            metric: {
              name: "changes-in-last-ten-commits",
              value: count,
              threshold: 3,
            },
            basis: targetBasis(catalogSha256, historyCommit, [entry]),
            allowedOperations: [],
          }),
        );
    }

  return {
    version: 1,
    catalogSha256,
    ...(historyCommit ? { historyCommit } : {}),
    pathologies: pathologies.sort(
      (left, right) =>
        left.type.localeCompare(right.type) || left.id.localeCompare(right.id),
    ),
  };
}
