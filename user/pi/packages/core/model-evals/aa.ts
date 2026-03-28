/**
 * artificial analysis data fetch/cache/normalize.
 *
 * fetches llm benchmark data from the artificial analysis api, caches locally,
 * and normalizes to our internal format. higher values are better for all
 * normalized metrics (including price, where higher = cheaper).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CandidateModel, DimensionId, EvaluatedModel, MetricSource, ModelFacts } from "./types";

/**
 * cached aa snapshot.
 *
 * stores the raw api response plus metadata for provenance.
 */
export interface AaSnapshot {
  fetchedAt: string;
  source: "artificial-analysis";
  raw: unknown;
}

/**
 * raw aa model entry (subset of fields we use).
 */
interface AaModelRaw {
  slug?: string;
  name?: string;
  provider?: string;
  evaluations?: {
    artificial_analysis_coding_index?: number | null;
    artificial_analysis_intelligence_index?: number | null;
  };
  pricing?: {
    price_1m_input_tokens?: number | null;
    price_1m_output_tokens?: number | null;
    price_1m_blended_3_to_1?: number | null;
  };
  median_output_tokens_per_second?: number | null;
  median_time_to_first_token_seconds?: number | null;
  context_window?: number | null;
}

const AA_API_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";

/**
 * get the default cache path for aa data.
 *
 * uses platform-appropriate cache directory outside git.
 */
export function getDefaultCachePath(): string {
  const cacheDir =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(cacheDir, "pi-model-evals", "aa-snapshot.json");
}

/**
 * fetch a fresh snapshot from the artificial analysis api.
 */
export async function fetchAaSnapshot(input: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<AaSnapshot> {
  const fetchFn = input.fetchImpl ?? fetch;
  const apiKey = input.apiKey ?? process.env.artificial_analysis_api_key;

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const response = await fetchFn(AA_API_URL, { headers });

  if (!response.ok) {
    throw new Error(
      `aa api error: ${response.status} ${response.statusText}`
    );
  }

  const raw = await response.json();

  return {
    fetchedAt: new Date().toISOString(),
    source: "artificial-analysis",
    raw,
  };
}

/**
 * load a cached snapshot from disk.
 */
export function loadAaSnapshot(cachePath: string): AaSnapshot | null {
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as AaSnapshot;
    if (
      parsed.fetchedAt &&
      parsed.source === "artificial-analysis" &&
      parsed.raw
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * save a snapshot to disk.
 */
export function saveAaSnapshot(cachePath: string, snapshot: AaSnapshot): void {
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(snapshot, null, 2));
}

/**
 * get a snapshot, using cache if available.
 *
 * refresh=true forces a fresh fetch.
 * returns null if no cache exists and no api key is provided.
 */
export async function getAaSnapshot(input: {
  apiKey?: string;
  cachePath?: string;
  refresh?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<AaSnapshot | null> {
  const cachePath = input.cachePath ?? getDefaultCachePath();

  // try cache first
  if (!input.refresh) {
    const cached = loadAaSnapshot(cachePath);
    if (cached) {
      return cached;
    }
  }

  // fetch fresh
  if (!input.apiKey && !process.env.artificial_analysis_api_key) {
    return null;
  }

  const snapshot = await fetchAaSnapshot({
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
  });

  saveAaSnapshot(cachePath, snapshot);
  return snapshot;
}

/**
 * find a model in aa data by apiSlug or apiName.
 */
function findAaModel(
  rawModels: AaModelRaw[],
  candidate: CandidateModel
): AaModelRaw | null {
  // try apiSlug first
  if (candidate.aaMatch.apiSlug) {
    const found = rawModels.find(
      (m) => m.slug?.toLowerCase() === candidate.aaMatch.apiSlug!.toLowerCase()
    );
    if (found) return found;
  }

  // try apiName
  if (candidate.aaMatch.apiName) {
    const found = rawModels.find(
      (m) => m.name?.toLowerCase() === candidate.aaMatch.apiName!.toLowerCase()
    );
    if (found) return found;
  }

  // try display name as fallback
  const found = rawModels.find(
    (m) => m.name?.toLowerCase().includes(candidate.displayName.toLowerCase())
  );
  return found ?? null;
}

/**
 * normalize a raw aa model to our metric format.
 *
 * all metrics are normalized so higher = better:
 * - coding: direct (higher = better)
 * - intelligence: direct (higher = better)
 * - price: inverted (higher = cheaper/better)
 * - outputSpeed: direct (higher = faster)
 * - ttft: inverted (higher = faster, since ttft is latency)
 */
function normalizeMetrics(aa: AaModelRaw): Partial<Record<DimensionId, number>> {
  const metrics: Partial<Record<DimensionId, number>> = {};

  // coding score
  const coding = aa.evaluations?.artificial_analysis_coding_index;
  if (coding != null && !isNaN(coding)) {
    metrics.coding = coding;
  }

  // intelligence score
  const intelligence = aa.evaluations?.artificial_analysis_intelligence_index;
  if (intelligence != null && !isNaN(intelligence)) {
    metrics.intelligence = intelligence;
  }

  // price: we want higher = cheaper
  // convert to a 0-100 scale where 0 = expensive, 100 = free
  const inputPrice = aa.pricing?.price_1m_input_tokens ?? 0;
  const outputPrice = aa.pricing?.price_1m_output_tokens ?? 0;
  const blendedPrice = (inputPrice + outputPrice) / 2;
  if (blendedPrice > 0) {
    // invert: higher price = lower score
    // scale: $0 = 100, $100+ = 0
    const priceScore = Math.max(0, 100 - blendedPrice);
    metrics.price = priceScore;
  }

  // output speed
  const speed = aa.median_output_tokens_per_second;
  if (speed != null && !isNaN(speed)) {
    // normalize to 0-100 scale
    // ~200 tps is fast, ~20 tps is slow
    metrics.outputSpeed = Math.min(100, (speed / 200) * 100);
  }

  // ttft: lower is better, so invert
  const ttft = aa.median_time_to_first_token_seconds;
  if (ttft != null && !isNaN(ttft)) {
    // normalize: 0s = 100, 5s+ = 0
    const ttftScore = Math.max(0, 100 - (ttft / 5) * 100);
    metrics.ttft = ttftScore;
  }

  return metrics;
}

/**
 * build metric sources for aa-api-derived metrics.
 */
function buildMetricSources(metrics: Partial<Record<DimensionId, number>>): Partial<Record<DimensionId, MetricSource>> {
  const sources: Partial<Record<DimensionId, MetricSource>> = {};
  for (const dim of Object.keys(metrics) as DimensionId[]) {
    sources[dim] = {
      source: "artificial-analysis-api",
      confidence: "verified",
    };
  }
  return sources;
}

/**
 * normalize aa snapshot to evaluated models.
 *
 * matches candidates to aa data and extracts relevant metrics.
 * models not found in aa data get empty metrics with a note.
 */
export function normalizeAaSnapshot(input: {
  snapshot: AaSnapshot;
  candidates: readonly CandidateModel[];
}): EvaluatedModel[] {
  const raw = input.snapshot.raw as { data?: AaModelRaw[] };
  const rawModels = raw?.data ?? [];

  return input.candidates.map((candidate): EvaluatedModel => {
    const aa = findAaModel(rawModels, candidate);
    const notes: string[] = [];

    if (!aa) {
      notes.push(`not found in aa data`);
    }

    const metrics = aa ? normalizeMetrics(aa) : {};
    const metricSources = buildMetricSources(metrics);
    const facts: ModelFacts = {};

    // add context window to facts if available (raw value for guardrails)
    if (aa?.context_window != null && !isNaN(aa.context_window)) {
      facts.contextWindowTokens = aa.context_window;
    }

    return {
      id: candidate.id,
      providerModel: candidate.providerModel,
      displayName: candidate.displayName,
      metrics,
      metricSources,
      facts,
      supplements: {},
      notes,
    };
  });
}

if (import.meta.vitest) {
  const { afterEach, beforeEach, describe, expect, test, vi } = import.meta.vitest;
  const tmpdir = os.tmpdir();

  let testDir: string;
  let testCachePath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(tmpdir, "pi-model-evals-test-"));
    testCachePath = path.join(testDir, "aa-snapshot.json");
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("getDefaultCachePath", () => {
    test("returns a path under cache dir", () => {
      const p = getDefaultCachePath();
      expect(p).toContain(".cache");
      expect(p).toContain("pi-model-evals");
    });

    test("respects XDG_CACHE_HOME", () => {
      const original = process.env.XDG_CACHE_HOME;
      process.env.XDG_CACHE_HOME = testDir;
      const p = getDefaultCachePath();
      expect(p).toContain(testDir);
      process.env.XDG_CACHE_HOME = original;
    });
  });

  describe("saveAaSnapshot and loadAaSnapshot", () => {
    test("round-trips a snapshot", () => {
      const snapshot: AaSnapshot = {
        fetchedAt: "2024-01-01T00:00:00Z",
        source: "artificial-analysis",
        raw: { data: [{ slug: "test-model" }] },
      };

      saveAaSnapshot(testCachePath, snapshot);
      const loaded = loadAaSnapshot(testCachePath);

      expect(loaded).toEqual(snapshot);
    });

    test("returns null for missing file", () => {
      const loaded = loadAaSnapshot(path.join(testDir, "nonexistent.json"));
      expect(loaded).toBeNull();
    });

    test("returns null for invalid json", () => {
      fs.writeFileSync(testCachePath, "not valid json {{{");
      const loaded = loadAaSnapshot(testCachePath);
      expect(loaded).toBeNull();
    });

    test("returns null for missing required fields", () => {
      fs.writeFileSync(testCachePath, JSON.stringify({ fetchedAt: "x" }));
      const loaded = loadAaSnapshot(testCachePath);
      expect(loaded).toBeNull();
    });
  });

  describe("fetchAaSnapshot", () => {
    test("fetches and returns snapshot", async () => {
      const mockResponse = {
        data: [{ slug: "gpt-5-4", evaluations: { artificial_analysis_coding_index: 85 } }],
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      }) as unknown as typeof fetch;

      // clear env var for this test
      const originalKey = process.env.artificial_analysis_api_key;
      delete process.env.artificial_analysis_api_key;

      const snapshot = await fetchAaSnapshot({ fetchImpl: mockFetch });

      expect(mockFetch).toHaveBeenCalledWith(AA_API_URL, { headers: {} });
      expect(snapshot.source).toBe("artificial-analysis");
      expect(snapshot.raw).toEqual(mockResponse);
      expect(snapshot.fetchedAt).toBeDefined();

      // restore
      if (originalKey) process.env.artificial_analysis_api_key = originalKey;
    });

    test("includes auth header when api key provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }) as unknown as typeof fetch;

      await fetchAaSnapshot({ apiKey: "test-key", fetchImpl: mockFetch });

      expect(mockFetch).toHaveBeenCalledWith(AA_API_URL, {
        headers: { "x-api-key": "test-key" },
      });
    });

    test("throws on non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      }) as unknown as typeof fetch;

      await expect(
        fetchAaSnapshot({ fetchImpl: mockFetch })
      ).rejects.toThrow("aa api error: 429");
    });
  });

  describe("getAaSnapshot", () => {
    test("uses cache when available", async () => {
      const cached: AaSnapshot = {
        fetchedAt: "2024-01-01T00:00:00Z",
        source: "artificial-analysis",
        raw: { data: [] },
      };
      saveAaSnapshot(testCachePath, cached);

      const mockFetch = vi.fn() as unknown as typeof fetch;

      const result = await getAaSnapshot({
        cachePath: testCachePath,
        fetchImpl: mockFetch,
      });

      expect(result).toEqual(cached);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("fetches when refresh=true", async () => {
      const cached: AaSnapshot = {
        fetchedAt: "2024-01-01T00:00:00Z",
        source: "artificial-analysis",
        raw: { data: [] },
      };
      saveAaSnapshot(testCachePath, cached);

      const fresh: AaSnapshot = {
        fetchedAt: "2024-01-02T00:00:00Z",
        source: "artificial-analysis",
        raw: { data: [{ slug: "new" }] },
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => fresh.raw,
      }) as unknown as typeof fetch;

      const result = await getAaSnapshot({
        cachePath: testCachePath,
        refresh: true,
        apiKey: "test-key", // need api key for fetch to happen
        fetchImpl: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalled();
      expect(result?.fetchedAt).not.toBe(cached.fetchedAt);
    });

    test("returns null when no cache and no api key", async () => {
      // clear env var for this test
      const originalKey = process.env.artificial_analysis_api_key;
      delete process.env.artificial_analysis_api_key;

      const result = await getAaSnapshot({
        cachePath: testCachePath,
        fetchImpl: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [] }),
        }) as unknown as typeof fetch,
      });

      expect(result).toBeNull();

      // restore
      if (originalKey) process.env.artificial_analysis_api_key = originalKey;
    });
  });

  describe("normalizeAaSnapshot", () => {
    const testCandidates: CandidateModel[] = [
      {
        id: "test-model",
        providerModel: "test/model",
        displayName: "Test Model",
        aaMatch: { apiSlug: "test-model" },
      },
      {
        id: "missing-model",
        providerModel: "missing/model",
        displayName: "Missing",
        aaMatch: { apiSlug: "nonexistent" },
      },
    ];

    test("normalizes aa data to evaluated models", () => {
      const snapshot: AaSnapshot = {
        fetchedAt: "2024-01-01T00:00:00Z",
        source: "artificial-analysis",
        raw: {
          data: [
            {
              slug: "test-model",
              evaluations: {
                artificial_analysis_coding_index: 85,
                artificial_analysis_intelligence_index: 80,
              },
              pricing: {
                price_1m_input_tokens: 10,
                price_1m_output_tokens: 30,
              },
              median_output_tokens_per_second: 100,
              median_time_to_first_token_seconds: 0.5,
              context_window: 128000,
            },
          ],
        },
      };

      const models = normalizeAaSnapshot({
        snapshot,
        candidates: testCandidates,
      });

      expect(models).toHaveLength(2);

      const testModel = models.find((m) => m.id === "test-model")!;
      expect(testModel).toBeDefined();
      expect(testModel.metrics.coding).toBe(85);
      expect(testModel.metrics.intelligence).toBe(80);
      expect(testModel.metrics.price).toBeGreaterThan(0); // inverted
      expect(testModel.metrics.outputSpeed).toBeGreaterThan(0);
      expect(testModel.metrics.ttft).toBeGreaterThan(0); // inverted
      expect(testModel.facts.contextWindowTokens).toBe(128000);
      expect(testModel.metricSources.coding?.source).toBe("artificial-analysis-api");
      expect(testModel.notes).toHaveLength(0);

      const missingModel = models.find((m) => m.id === "missing-model")!;
      expect(missingModel.notes).toContain("not found in aa data");
    });

    test("handles missing aa metrics gracefully", () => {
      const snapshot: AaSnapshot = {
        fetchedAt: "2024-01-01T00:00:00Z",
        source: "artificial-analysis",
        raw: {
          data: [
            {
              slug: "test-model",
              // all metrics missing
            },
          ],
        },
      };

      const models = normalizeAaSnapshot({
        snapshot,
        candidates: [testCandidates[0]!],
      });

      expect(models[0]?.metrics).toEqual({});
      expect(models[0]?.metricSources).toEqual({});
    });
  });
}
