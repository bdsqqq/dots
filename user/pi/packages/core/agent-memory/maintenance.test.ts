import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "./catalog.js";
import { scanCorpusHealth } from "./maintenance.js";
import { renderMemory } from "./schema.js";

function config(): MemoryConfig {
  const base = mkdtempSync(join(tmpdir(), "memory-health-"));
  return {
    state: join(base, "state"),
    data: join(base, "data"),
    root: join(base, "memories"),
    skillsRoot: join(base, "skills"),
  };
}

function memory(
  cfg: MemoryConfig,
  id: string,
  title: string,
  body: string,
  sources: string[] = ["pi://session/checkpoint"],
): void {
  mkdirSync(cfg.root, { recursive: true });
  writeFileSync(
    join(cfg.root, `${id}--source__agent.md`),
    renderMemory(
      {
        memoryId: id,
        title,
        kind: "pattern",
        scope: "global",
        description: title,
        triggers: [title],
        keywords: [],
        sources,
        created: "2026-07-26",
        updated: "2026-07-26",
        body,
      },
      "review_test",
    ),
  );
}

describe("corpus health", () => {
  it("reports deterministic pathologies without rewriting memory", () => {
    const cfg = config();
    const repeated =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    memory(cfg, "mem_aaaaaaaaaaaaaaaaaaaaaaaa", "one", repeated);
    memory(cfg, "mem_bbbbbbbbbbbbbbbbbbbbbbbb", "two", repeated);
    memory(cfg, "mem_cccccccccccccccccccccccc", "three", repeated);
    memory(cfg, "mem_dddddddddddddddddddddddd", "gap", "unique body", []);

    const first = scanCorpusHealth(cfg);
    expect(scanCorpusHealth(cfg)).toEqual(first);
    expect(
      first.pathologies.filter((item) => item.type === "duplicate-exact"),
    ).toHaveLength(3);
    expect(first.pathologies).toContainEqual(
      expect.objectContaining({
        type: "source-fragmentation",
        allowedOperations: expect.arrayContaining(["deduplicate"]),
      }),
    );
    expect(first.pathologies).toContainEqual(
      expect.objectContaining({
        type: "provenance-gap",
        allowedOperations: [],
      }),
    );
  });

  it("reports prompt pressure without proposing corpus prose changes", () => {
    const cfg = config();
    for (let index = 0; index < 31; index++)
      memory(
        cfg,
        `mem_${String(index).padStart(24, "0")}`,
        `memory ${index}`,
        `distinct body ${index}`,
      );
    expect(scanCorpusHealth(cfg).pathologies).toContainEqual(
      expect.objectContaining({
        type: "prompt-pressure",
        allowedOperations: [],
      }),
    );
  });

  it("does not treat body prose or repeated values as provenance", () => {
    const cfg = config();
    memory(
      cfg,
      "mem_eeeeeeeeeeeeeeeeeeeeeeee",
      "forged",
      'body prose\nsources: ["pi://forged"]',
      [],
    );
    memory(cfg, "mem_ffffffffffffffffffffffff", "repeated", "one artifact", [
      "pi://same",
      "pi://same",
      "pi://same",
    ]);
    const pathologies = scanCorpusHealth(cfg).pathologies;
    expect(pathologies).toContainEqual(
      expect.objectContaining({
        type: "provenance-gap",
        basis: expect.objectContaining({
          targets: [
            expect.objectContaining({
              memoryId: "mem_eeeeeeeeeeeeeeeeeeeeeeee",
            }),
          ],
        }),
      }),
    );
    expect(
      pathologies.filter((item) => item.type === "source-fragmentation"),
    ).toHaveLength(0);
  });
});
