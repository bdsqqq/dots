/**
 * supplemental metrics with provenance.
 *
 * artificial analysis doesn't provide all dimensions we care about.
 * this module stores manually-curated metrics with explicit confidence
 * and source attribution. reports surface coverage gaps instead of
 * pretending data is complete.
 *
 * note: site scrape data (hallucination, context, instructionFollowing)
 * flows through aa-site.ts merge. this file only fills gaps that site
 * data cannot cover, specifically toolCalling for major providers.
 */

import type {
  DimensionId,
  EvaluatedModel,
  ModelId,
  SupplementalMetric,
} from "./types";

/**
 * supplemental metrics for candidate models.
 *
 * only verified data from official docs. hunch values are worse than
 * visible gaps - they create false confidence. site scrape provides
 * hallucination, context, and instructionFollowing benchmarks.
 */
export const supplementalMetrics: Partial<
  Record<ModelId, Partial<Record<DimensionId, SupplementalMetric>>>
> = {
  // gpt-5.4
  "gpt-5-4": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "openai docs - native function calling",
    },
  },

  // gpt-5.2
  "gpt-5-2": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "openai docs - native function calling",
    },
  },

  // gpt-5.4 mini
  "gpt-5-4-mini": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "openai docs - native function calling",
    },
  },

  // gpt-5.4 nano
  "gpt-5-4-nano": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "openai docs - native function calling",
    },
  },

  // gemini 3.1 pro
  "gemini-3-1-pro": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "google ai docs - native function calling",
    },
  },

  // gemini 3 flash
  "gemini-3-flash": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "google ai docs - native function calling",
    },
  },

  // claude opus 4.6
  "claude-opus-4-6": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "anthropic docs - tool use capability",
    },
  },

  // claude sonnet 4.6
  "claude-sonnet-4-6": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "anthropic docs - tool use capability",
    },
  },

  // minimax m2.7
  "minimax-m2-7": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "minimax docs - native tool use with interleaved thinking",
    },
  },

  // kimi k2
  "kimi-k2": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "moonshot ai docs - native tool use / function calling",
    },
  },

  // glm-5
  "glm-5": {
    toolCalling: {
      value: true,
      confidence: "verified",
      source: "zhipu ai docs - native function calling",
    },
  },
};

/**
 * merge supplemental metrics into evaluated models.
 *
 * site data takes precedence (already merged before this call).
 * supplements only fill remaining gaps.
 */
export function mergeSupplementalMetrics(input: {
  models: readonly EvaluatedModel[];
  supplemental: typeof supplementalMetrics;
}): EvaluatedModel[] {
  return input.models.map((model): EvaluatedModel => {
    const supplements = input.supplemental[model.id];
    if (!supplements) {
      return model;
    }

    // merge supplements, preserving existing supplements (site data takes precedence)
    const mergedSupplements = { ...model.supplements };

    for (const [dim, metric] of Object.entries(supplements)) {
      // only add supplement if not already present (site data already filled it)
      if (!(dim in mergedSupplements)) {
        mergedSupplements[dim as DimensionId] = metric;
      }
    }

    return {
      ...model,
      supplements: mergedSupplements,
    };
  });
}

/**
 * compute coverage ratio by dimension.
 *
 * returns the fraction of models that have data for each dimension.
 * counts both aa metrics and supplements separately.
 */
export function getCoverageByDimension(input: {
  models: readonly EvaluatedModel[];
  dimensions: readonly DimensionId[];
}): Partial<
  Record<DimensionId, { aa: number; supplements: number; verified: number }>
> {
  const coverage: Partial<
    Record<DimensionId, { aa: number; supplements: number; verified: number }>
  > = {};

  const total = input.models.length;

  for (const dim of input.dimensions) {
    let aaCount = 0;
    let supplementCount = 0;
    let verifiedCount = 0;

    for (const model of input.models) {
      if (model.metrics[dim] !== undefined) {
        aaCount++;
      }
      const supp = model.supplements[dim];
      if (supp) {
        supplementCount++;
        if (supp.confidence === "verified") {
          verifiedCount++;
        }
      }
    }

    coverage[dim] = {
      aa: total > 0 ? aaCount / total : 0,
      supplements: total > 0 ? supplementCount / total : 0,
      verified: total > 0 ? verifiedCount / total : 0,
    };
  }

  return coverage;
}

if (import.meta.vitest) {
  const { describe, expect, test } = import.meta.vitest;

  describe("mergeSupplementalMetrics", () => {
    test("merges supplements into models", () => {
      const models: EvaluatedModel[] = [
        {
          id: "test-model",
          providerModel: "test/model",
          displayName: "Test",
          metrics: { coding: 50 },
          metricSources: {},
          facts: {},
          supplements: {},
          notes: [],
        },
      ];

      const supplemental: typeof supplementalMetrics = {
        "test-model": {
          toolCalling: {
            value: true,
            confidence: "verified",
            source: "test",
          },
        },
      };

      const merged = mergeSupplementalMetrics({ models, supplemental });

      expect(merged[0]?.supplements.toolCalling?.value).toBe(true);
      expect(merged[0]?.supplements.toolCalling?.confidence).toBe("verified");
    });

    test("preserves existing supplements", () => {
      const models: EvaluatedModel[] = [
        {
          id: "test-model",
          providerModel: "test/model",
          displayName: "Test",
          metrics: {},
          metricSources: {},
          facts: {},
          supplements: {
            hallucination: {
              value: 0.9,
              confidence: "verified",
              source: "site data",
            },
          },
          notes: [],
        },
      ];

      const supplemental: typeof supplementalMetrics = {
        "test-model": {
          hallucination: {
            value: 0.5,
            confidence: "hunch",
            source: "test",
          },
        },
      };

      const merged = mergeSupplementalMetrics({ models, supplemental });

      // site data should not be overwritten
      expect(merged[0]?.supplements.hallucination?.value).toBe(0.9);
      expect(merged[0]?.supplements.hallucination?.source).toBe("site data");
    });

    test("handles missing model in supplements", () => {
      const models: EvaluatedModel[] = [
        {
          id: "unknown-model",
          providerModel: "unknown/model",
          displayName: "Unknown",
          metrics: {},
          metricSources: {},
          facts: {},
          supplements: {},
          notes: [],
        },
      ];

      const merged = mergeSupplementalMetrics({ models, supplemental: {} });

      expect(merged[0]?.supplements).toEqual({});
    });
  });

  describe("getCoverageByDimension", () => {
    test("computes coverage correctly", () => {
      const models: EvaluatedModel[] = [
        {
          id: "a",
          providerModel: "a",
          displayName: "A",
          metrics: { coding: 50 },
          metricSources: {},
          facts: {},
          supplements: {
            toolCalling: {
              value: true,
              confidence: "verified",
              source: "test",
            },
          },
          notes: [],
        },
        {
          id: "b",
          providerModel: "b",
          displayName: "B",
          metrics: {},
          metricSources: {},
          facts: {},
          supplements: {},
          notes: [],
        },
        {
          id: "c",
          providerModel: "c",
          displayName: "C",
          metrics: { coding: 60 },
          metricSources: {},
          facts: {},
          supplements: {},
          notes: [],
        },
      ];

      const coverage = getCoverageByDimension({
        models,
        dimensions: ["coding", "toolCalling"],
      });

      expect(coverage.coding?.aa).toBe(2 / 3);
      expect(coverage.toolCalling?.supplements).toBe(1 / 3);
      expect(coverage.toolCalling?.verified).toBe(1 / 3);
    });

    test("handles empty models", () => {
      const coverage = getCoverageByDimension({
        models: [],
        dimensions: ["coding"],
      });

      expect(coverage.coding?.aa).toBe(0);
      expect(coverage.coding?.supplements).toBe(0);
    });
  });
}
