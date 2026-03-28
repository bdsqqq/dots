import * as fs from "node:fs";
import * as path from "node:path";
import type { CandidateModel, DimensionId, EvaluatedModel, MetricSource, ModelFacts } from "./types";

/**
 * aa site scrape definitions.
 *
 * these pages publicly embed richer evaluation data than the free aa api,
 * especially benchmark-specific results like omniscience hallucination,
 * terminalbench-hard, lcr, tau2, and ifbench. we persist raw html plus parsed
 * artifacts into a repo-local gitignored cache so the data is inspectable and
 * reproducible without re-hitting the site on every ranking run.
 */
export interface EvaluationPageDef {
  id: string;
  url: string;
}

export interface AaSiteDataset {
  name: string;
  description?: string;
  data: unknown[];
}

export interface AaSitePageCacheEntry {
  id: string;
  url: string;
  htmlPath: string;
  flightPath?: string;
  defaultDataPaths: string[];
  datasetPath?: string;
  modelCount: number;
  datasetCount: number;
}

export interface AaSiteCacheManifest {
  fetchedAt: string;
  cacheDir: string;
  pages: AaSitePageCacheEntry[];
  allModelsPath: string;
  candidateModelsPath?: string;
}

export const DEFAULT_EVALUATION_PAGES: readonly EvaluationPageDef[] = [
  {
    id: "intelligence-index",
    url: "https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index",
  },
  {
    id: "omniscience",
    url: "https://artificialanalysis.ai/evaluations/omniscience",
  },
  {
    id: "terminalbench-hard",
    url: "https://artificialanalysis.ai/evaluations/terminalbench-hard",
  },
  {
    id: "lcr",
    url: "https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning",
  },
  {
    id: "ifbench",
    url: "https://artificialanalysis.ai/evaluations/ifbench",
  },
  {
    id: "tau2-bench",
    url: "https://artificialanalysis.ai/evaluations/tau2-bench",
  },
  {
    id: "scicode",
    url: "https://artificialanalysis.ai/evaluations/scicode",
  },
  {
    id: "livecodebench",
    url: "https://artificialanalysis.ai/evaluations/livecodebench",
  },
  {
    id: "gdpval-aa",
    url: "https://artificialanalysis.ai/evaluations/gdpval-aa",
  },
  {
    id: "critpt",
    url: "https://artificialanalysis.ai/evaluations/critpt",
  },
  {
    id: "humanitys-last-exam",
    url: "https://artificialanalysis.ai/evaluations/humanitys-last-exam",
  },
] as const;

const MODEL_FIELD_KEYS = [
  "slug",
  "name",
  "short_name",
  "hosts_url",
  "model_url",
  "model_creators",
  "release_date",
  "context_window_tokens",
  "contextWindowFormatted",
  "intelligence_index",
  "coding_index",
  "agentic_index",
  "terminalbench_hard",
  "tau2",
  "lcr",
  "ifbench",
  "scicode",
  "livecodebench",
  "critpt",
  "gdpval",
  "gdpval_normalized",
  "omniscience",
  "omniscience_breakdown",
  "price_1m_input_tokens",
  "price_1m_output_tokens",
  "price_1m_blended_3_to_1",
  "evalCost",
  "eval_token_counts",
  "tokenCounts",
  "omniscience_token_use",
  "gdpval_token_use",
] as const;

/**
 * repo-local gitignored cache dir for site scrapes.
 *
 * this intentionally lives under `.cache/` in the repo because the user asked
 * for site scrapes to land in gitignored files that are easy to inspect.
 */
export function getDefaultSiteCacheDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".cache", "model-evals", "site");
}

export async function fetchEvaluationPageHtml(input: {
  url: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchFn = input.fetchImpl ?? fetch;
  const response = await fetchFn(input.url);
  if (!response.ok) {
    throw new Error(
      `site fetch failed for ${input.url}: ${response.status} ${response.statusText}`,
    );
  }
  return await response.text();
}

/**
 * extract react flight payload string fragments from the html.
 */
export function extractFlightChunks(html: string): string[] {
  const matches = html.matchAll(
    /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)<\/script>/gs,
  );
  const chunks: string[] = [];
  for (const match of matches) {
    const raw = match[1];
    if (!raw) continue;
    try {
      chunks.push(JSON.parse(`"${raw}"`) as string);
    } catch {
      // skip malformed chunks rather than failing the whole page.
    }
  }
  return chunks;
}

export function decodeFlightText(chunks: readonly string[]): string {
  return chunks.join("");
}

function bracketMatchJsonArray(input: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

/**
 * extract every `defaultData` array we can find in the decoded flight text.
 *
 * many evaluation pages embed a large `defaultData` model array that contains
 * the real benchmark numbers we want. we only keep arrays whose rows look like
 * model objects (`slug`, `name`, or `short_name`).
 */
export function extractDefaultDataArrays(decodedFlight: string): unknown[][] {
  const marker = '"defaultData":[';
  const arrays: unknown[][] = [];
  let searchIndex = 0;

  while (true) {
    const markerIndex = decodedFlight.indexOf(marker, searchIndex);
    if (markerIndex === -1) break;
    const arrayStart = markerIndex + marker.length - 1;
    const jsonArray = bracketMatchJsonArray(decodedFlight, arrayStart);
    if (jsonArray) {
      try {
        const parsed = JSON.parse(jsonArray) as unknown;
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          typeof parsed[0] === "object" &&
          parsed[0] !== null &&
          ["slug", "name", "short_name"].some((k) => k in (parsed[0] as Record<string, unknown>))
        ) {
          arrays.push(parsed as unknown[][] extends never ? never : unknown[]);
        }
      } catch {
        // ignore parse failures and continue.
      }
    }
    searchIndex = markerIndex + marker.length;
  }

  return arrays;
}

/**
 * extract schema.org dataset blobs from html.
 *
 * omniscience pages expose useful leaderboard data here directly.
 */
export function extractLdJsonDatasets(html: string): AaSiteDataset[] {
  const matches = html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gis,
  );
  const datasets: AaSiteDataset[] = [];
  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed["@type"] !== "Dataset") continue;
      if (!Array.isArray(parsed.data)) continue;
      datasets.push({
        name: String(parsed.name ?? "dataset"),
        description:
          typeof parsed.description === "string" ? parsed.description : undefined,
        data: parsed.data,
      });
    } catch {
      // ignore malformed dataset scripts.
    }
  }
  return datasets;
}

export function extractModelSlugFromDetailsUrl(detailsUrl: string): string | null {
  const match = detailsUrl.match(/\/models\/([^/]+)\/providers/);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickModelFields(row: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of MODEL_FIELD_KEYS) {
    if (key in row) picked[key] = row[key];
  }
  return picked;
}

/**
 * build a merged per-model aggregate from parsed site artifacts.
 */
export function buildModelAggregate(input: {
  defaultDataByPage: Record<string, unknown[][]>;
  datasetsByPage: Record<string, AaSiteDataset[]>;
}): Record<string, Record<string, unknown>> {
  const aggregate: Record<string, Record<string, unknown>> = {};

  for (const [pageId, arrays] of Object.entries(input.defaultDataByPage)) {
    for (const arr of arrays) {
      for (const row of arr) {
        if (!isRecord(row)) continue;
        const slug = typeof row.slug === "string" ? row.slug : null;
        if (!slug) continue;
        const existing = (aggregate[slug] ??= {
          slug,
          sources: [],
        });
        const sources = existing.sources;
        if (Array.isArray(sources) && !sources.includes(pageId)) {
          sources.push(pageId);
        }
        Object.assign(existing, pickModelFields(row));
      }
    }
  }

  for (const [pageId, datasets] of Object.entries(input.datasetsByPage)) {
    for (const dataset of datasets) {
      const datasetName = dataset.name.toLowerCase();
      for (const row of dataset.data) {
        if (!isRecord(row)) continue;
        const detailsUrl = typeof row.detailsUrl === "string" ? row.detailsUrl : null;
        const slug = detailsUrl ? extractModelSlugFromDetailsUrl(detailsUrl) : null;
        if (!slug) continue;
        const existing = (aggregate[slug] ??= {
          slug,
          sources: [],
        });
        const sources = existing.sources;
        if (Array.isArray(sources) && !sources.includes(`${pageId}:ldjson`)) {
          sources.push(`${pageId}:ldjson`);
        }

        if (
          datasetName.includes("hallucination rate") &&
          typeof row.omniscienceHallucinationRate === "number"
        ) {
          existing.aa_site_omniscience_hallucination_rate = row.omniscienceHallucinationRate;
        }
        if (
          datasetName.includes("accuracy") &&
          typeof row.omniscienceAccuracy === "number"
        ) {
          existing.aa_site_omniscience_accuracy = row.omniscienceAccuracy;
        }
      }
    }
  }

  return aggregate;
}

export function filterAggregateToCandidates(input: {
  aggregate: Record<string, Record<string, unknown>>;
  candidates: readonly CandidateModel[];
}): Record<string, Record<string, unknown>> {
  const wanted = new Set<string>();
  for (const candidate of input.candidates) {
    // use siteSlugs for site aggregate filtering
    if (candidate.aaMatch.siteSlugs) {
      for (const slug of candidate.aaMatch.siteSlugs) {
        wanted.add(slug);
      }
    }
    // fallback to apiSlug if no siteSlugs
    if (candidate.aaMatch.apiSlug && !candidate.aaMatch.siteSlugs?.length) {
      wanted.add(candidate.aaMatch.apiSlug);
    }
  }
  return Object.fromEntries(
    Object.entries(input.aggregate).filter(([slug]) => wanted.has(slug)),
  );
}

/**
 * load cached site aggregate from disk.
 *
 * returns null if cache doesn't exist or can't be parsed.
 */
export function loadCandidateSiteAggregate(
  cacheDir?: string
): Record<string, Record<string, unknown>> | null {
  const dir = cacheDir ?? getDefaultSiteCacheDir();
  const candidatePath = path.join(dir, "aggregate", "candidate-models.json");

  if (!fs.existsSync(candidatePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(candidatePath, "utf-8");
    return JSON.parse(raw) as Record<string, Record<string, unknown>>;
  } catch {
    return null;
  }
}

/**
 * slug-to-modelId mapping derived from candidateModels registry.
 *
 * site aggregate keys are aa slugs; we need to translate to our internal model ids.
 * maps both siteSlugs and apiSlug to the model id.
 */
export function buildSlugToModelIdMap(
  candidates: readonly CandidateModel[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const candidate of candidates) {
    // map siteSlugs
    if (candidate.aaMatch.siteSlugs) {
      for (const slug of candidate.aaMatch.siteSlugs) {
        map.set(slug, candidate.id);
      }
    }
    // map apiSlug as fallback
    if (candidate.aaMatch.apiSlug) {
      map.set(candidate.aaMatch.apiSlug, candidate.id);
    }
    // map apiName as fallback
    if (candidate.aaMatch.apiName) {
      map.set(candidate.aaMatch.apiName, candidate.id);
    }
  }
  return map;
}

/**
 * normalize context window tokens to a 0-100 score.
 *
 * uses log scaling: 128k = 0, 1m = 100.
 * compresses absurdly large raw numbers while rewarding larger windows.
 */
export function normalizeContextWindowTokens(tokens: number): number {
  const minTokens = 128_000;
  const maxTokens = 1_000_000;
  if (tokens <= minTokens) return 0;
  if (tokens >= maxTokens) return 100;
  
  const normalized = Math.log2(tokens / minTokens) / Math.log2(maxTokens / minTokens);
  return Math.max(0, Math.min(100, normalized * 100));
}

/**
 * build tool-calling score from terminalbench, tau2, and agentic index.
 *
 * weighted average: terminalbench_hard @ 0.5, tau2 @ 0.3, agentic_index @ 0.2.
 * renormalizes if components are missing.
 */
export function buildToolCallingScore(input: {
  terminalbenchHard?: number;
  tau2?: number;
  agenticIndex?: number;
}): number | undefined {
  const components: { value: number; weight: number }[] = [];
  
  if (input.terminalbenchHard !== undefined) {
    components.push({ value: input.terminalbenchHard * 100, weight: 0.5 });
  }
  if (input.tau2 !== undefined) {
    components.push({ value: input.tau2 * 100, weight: 0.3 });
  }
  if (input.agenticIndex !== undefined) {
    components.push({ value: input.agenticIndex, weight: 0.2 });
  }
  
  if (components.length === 0) return undefined;
  
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const weightedSum = components.reduce((sum, c) => sum + c.value * c.weight, 0);
  
  return weightedSum / totalWeight;
}

/**
 * extract hallucination score from site data.
 *
 * preferred order:
 * 1. non_hallucination_rate * 100 (direct higher-is-better)
 * 2. (1 - hallucination_rate) * 100 (invert lower-is-better)
 * 3. (1 - aa_site_omniscience_hallucination_rate) * 100 (ld+json fallback)
 */
function extractHallucinationScore(siteData: Record<string, unknown>): number | undefined {
  // try omniscience_breakdown.total.non_hallucination_rate first
  const omniscienceBreakdown = siteData.omniscience_breakdown as Record<string, unknown> | undefined;
  const totalBreakdown = omniscienceBreakdown?.total as Record<string, unknown> | undefined;
  
  const nonHallucinationRate = totalBreakdown?.non_hallucination_rate;
  if (typeof nonHallucinationRate === "number") {
    return nonHallucinationRate * 100;
  }
  
  // try hallucination_rate (invert it)
  const hallucinationRate = totalBreakdown?.hallucination_rate;
  if (typeof hallucinationRate === "number") {
    return (1 - hallucinationRate) * 100;
  }
  
  // try ld+json fallback
  const ldJsonRate = siteData.aa_site_omniscience_hallucination_rate;
  if (typeof ldJsonRate === "number") {
    return (1 - ldJsonRate) * 100;
  }
  
  return undefined;
}

/**
 * merge site aggregate data into evaluated models.
 *
 * normalizes site benchmark fields into:
 * - metrics: normalized comparison scores (0-100, higher is better)
 * - facts: raw benchmark values for guardrails and inspect output
 * - metricSources: provenance for each metric
 *
 * site data gets "verified" confidence since it comes from published benchmarks.
 * only populates values that are missing; does not overwrite existing metrics.
 */
export function mergeSiteAggregateIntoEvaluatedModels(input: {
  models: readonly EvaluatedModel[];
  aggregate: Record<string, Record<string, unknown>>;
  slugToModelId: Map<string, string>;
}): EvaluatedModel[] {
  // build reverse lookup: modelId -> all matching slugs
  const modelIdToSlugs = new Map<string, string[]>();
  for (const [slug, modelId] of input.slugToModelId) {
    const existing = modelIdToSlugs.get(modelId) ?? [];
    existing.push(slug);
    modelIdToSlugs.set(modelId, existing);
  }
  
  return input.models.map((model): EvaluatedModel => {
    // find all slugs for this model
    const slugs = modelIdToSlugs.get(model.id) ?? [];
    
    // find site data by trying each slug
    let siteData: Record<string, unknown> | undefined;
    for (const slug of slugs) {
      if (input.aggregate[slug]) {
        siteData = input.aggregate[slug];
        break;
      }
    }
    
    if (!siteData) return model;

    const mergedMetrics = { ...model.metrics };
    const mergedSources = { ...model.metricSources };
    const mergedFacts: ModelFacts = { ...model.facts };
    const notes = [...model.notes];

    // === HALLUCINATION ===
    // extract to facts first
    const omniscienceBreakdown = siteData.omniscience_breakdown as Record<string, unknown> | undefined;
    const totalBreakdown = omniscienceBreakdown?.total as Record<string, unknown> | undefined;
    
    if (typeof totalBreakdown?.hallucination_rate === "number") {
      mergedFacts.hallucinationRate = totalBreakdown.hallucination_rate;
    }
    if (typeof totalBreakdown?.non_hallucination_rate === "number") {
      mergedFacts.nonHallucinationRate = totalBreakdown.non_hallucination_rate;
    }
    
    // add to metrics if not present
    if (mergedMetrics.hallucination === undefined) {
      const score = extractHallucinationScore(siteData);
      if (score !== undefined) {
        mergedMetrics.hallucination = score;
        mergedSources.hallucination = {
          source: "aa-site-omniscience",
          confidence: "verified",
        };
        notes.push(`hallucination score from aa site: ${score.toFixed(1)}`);
      }
    }

    // === CONTEXT ===
    const contextTokens = siteData.context_window_tokens;
    if (typeof contextTokens === "number") {
      mergedFacts.contextWindowTokens = contextTokens;
      
      // add normalized score to metrics if not present
      if (mergedMetrics.context === undefined) {
        mergedMetrics.context = normalizeContextWindowTokens(contextTokens);
        mergedSources.context = {
          source: "aa-site-metadata",
          confidence: "verified",
          note: `${(contextTokens / 1000).toFixed(0)}k tokens`,
        };
      }
    }

    // === INSTRUCTION FOLLOWING (ifbench) ===
    const ifbench = siteData.ifbench;
    if (typeof ifbench === "number") {
      mergedFacts.ifbench = ifbench;
      
      if (mergedMetrics.instructionFollowing === undefined) {
        mergedMetrics.instructionFollowing = ifbench * 100;
        mergedSources.instructionFollowing = {
          source: "aa-site-ifbench",
          confidence: "verified",
        };
        notes.push(`instructionFollowing from aa site ifbench: ${(ifbench * 100).toFixed(1)}`);
      }
    }

    // === LONG CONTEXT REASONING (lcr) ===
    const lcr = siteData.lcr;
    if (typeof lcr === "number") {
      mergedFacts.lcr = lcr;
      
      if (mergedMetrics.longContextReasoning === undefined) {
        mergedMetrics.longContextReasoning = lcr * 100;
        mergedSources.longContextReasoning = {
          source: "aa-site-lcr",
          confidence: "verified",
        };
      }
    }

    // === TOOL CALLING ===
    // extract raw components to facts
    const terminalbenchHard = siteData.terminalbench_hard;
    const tau2 = siteData.tau2;
    const agenticIndex = siteData.agentic_index;
    
    if (typeof terminalbenchHard === "number") {
      mergedFacts.terminalbenchHard = terminalbenchHard;
    }
    if (typeof tau2 === "number") {
      mergedFacts.tau2 = tau2;
    }
    if (typeof agenticIndex === "number") {
      mergedFacts.agenticIndex = agenticIndex;
    }
    
    // compute composite score if not present
    if (mergedMetrics.toolCalling === undefined) {
      const score = buildToolCallingScore({
        terminalbenchHard: typeof terminalbenchHard === "number" ? terminalbenchHard : undefined,
        tau2: typeof tau2 === "number" ? tau2 : undefined,
        agenticIndex: typeof agenticIndex === "number" ? agenticIndex : undefined,
      });
      
      if (score !== undefined) {
        mergedMetrics.toolCalling = score;
        mergedSources.toolCalling = {
          source: "aa-site-composite",
          confidence: "verified",
          note: "weighted: terminalbench @ 0.5, tau2 @ 0.3, agentic @ 0.2",
        };
        notes.push(`toolCalling score from aa site: ${score.toFixed(1)}`);
      }
    }

    return {
      ...model,
      metrics: mergedMetrics,
      metricSources: mergedSources,
      facts: mergedFacts,
      notes,
    };
  });
}

export async function scrapeAaSiteToCache(input: {
  cacheDir?: string;
  refresh?: boolean;
  pages?: readonly EvaluationPageDef[];
  fetchImpl?: typeof fetch;
  candidates?: readonly CandidateModel[];
}): Promise<AaSiteCacheManifest> {
  const cacheDir = input.cacheDir ?? getDefaultSiteCacheDir();
  const rawDir = path.join(cacheDir, "raw");
  const decodedDir = path.join(cacheDir, "decoded");
  const parsedDir = path.join(cacheDir, "parsed");
  const aggregateDir = path.join(cacheDir, "aggregate");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(decodedDir, { recursive: true });
  fs.mkdirSync(parsedDir, { recursive: true });
  fs.mkdirSync(aggregateDir, { recursive: true });

  const pages = input.pages ?? DEFAULT_EVALUATION_PAGES;
  const pageEntries: AaSitePageCacheEntry[] = [];
  const defaultDataByPage: Record<string, unknown[][]> = {};
  const datasetsByPage: Record<string, AaSiteDataset[]> = {};

  for (const page of pages) {
    const htmlPath = path.join(rawDir, `${page.id}.html`);
    let html: string;
    if (!input.refresh && fs.existsSync(htmlPath)) {
      html = fs.readFileSync(htmlPath, "utf-8");
    } else {
      html = await fetchEvaluationPageHtml({
        url: page.url,
        fetchImpl: input.fetchImpl,
      });
      fs.writeFileSync(htmlPath, html);
    }

    const chunks = extractFlightChunks(html);
    const decoded = decodeFlightText(chunks);
    const decodedPath = path.join(decodedDir, `${page.id}.flight.txt`);
    if (decoded.length > 0) {
      fs.writeFileSync(decodedPath, decoded);
    }

    const defaultArrays = extractDefaultDataArrays(decoded);
    defaultDataByPage[page.id] = defaultArrays;
    const defaultDataPaths: string[] = [];
    defaultArrays.forEach((arr, index) => {
      const filePath = path.join(parsedDir, `${page.id}.defaultData.${index}.json`);
      fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
      defaultDataPaths.push(filePath);
    });

    const datasets = extractLdJsonDatasets(html);
    datasetsByPage[page.id] = datasets;
    let datasetPath: string | undefined;
    if (datasets.length > 0) {
      datasetPath = path.join(parsedDir, `${page.id}.datasets.json`);
      fs.writeFileSync(datasetPath, JSON.stringify(datasets, null, 2));
    }

    const modelCount = defaultArrays.reduce((sum, arr) => sum + arr.length, 0);
    pageEntries.push({
      id: page.id,
      url: page.url,
      htmlPath,
      flightPath: decoded.length > 0 ? decodedPath : undefined,
      defaultDataPaths,
      datasetPath,
      modelCount,
      datasetCount: datasets.length,
    });
  }

  const aggregate = buildModelAggregate({
    defaultDataByPage,
    datasetsByPage,
  });
  const allModelsPath = path.join(aggregateDir, "all-models.json");
  fs.writeFileSync(allModelsPath, JSON.stringify(aggregate, null, 2));

  let candidateModelsPath: string | undefined;
  if (input.candidates && input.candidates.length > 0) {
    const candidateAggregate = filterAggregateToCandidates({
      aggregate,
      candidates: input.candidates,
    });
    candidateModelsPath = path.join(aggregateDir, "candidate-models.json");
    fs.writeFileSync(candidateModelsPath, JSON.stringify(candidateAggregate, null, 2));
  }

  const manifest: AaSiteCacheManifest = {
    fetchedAt: new Date().toISOString(),
    cacheDir,
    pages: pageEntries,
    allModelsPath,
    candidateModelsPath,
  };
  fs.writeFileSync(
    path.join(cacheDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  return manifest;
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, test } = import.meta.vitest;
  const tmpRoot = path.join(process.cwd(), ".tmp-model-evals-aa-site-test");

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("extractFlightChunks", () => {
    test("decodes next flight chunks", () => {
      const html = String.raw`<script>self.__next_f.push([1,"abc\n"])</script><script>self.__next_f.push([1,"def"])</script>`;
      const chunks = extractFlightChunks(html);
      expect(chunks).toEqual(["abc\n", "def"]);
      expect(decodeFlightText(chunks)).toBe("abc\ndef");
    });
  });

  describe("extractDefaultDataArrays", () => {
    test("extracts model arrays from decoded flight text", () => {
      const decoded = 'xx "defaultData":[{"slug":"gpt-5-4","terminalbench_hard":0.5},{"slug":"glm-5"}] yy';
      const arrays = extractDefaultDataArrays(decoded);
      expect(arrays).toHaveLength(1);
      expect((arrays[0]?.[0] as Record<string, unknown>).slug).toBe("gpt-5-4");
    });
  });

  describe("extractLdJsonDatasets", () => {
    test("extracts dataset blobs", () => {
      const html = `
        <script type="application/ld+json">{"@type":"Dataset","name":"AA-Omniscience Hallucination Rate","data":[{"modelName":"GPT-5.4","omniscienceHallucinationRate":0.3,"detailsUrl":"/models/gpt-5-4/providers"}]}</script>
      `;
      const datasets = extractLdJsonDatasets(html);
      expect(datasets).toHaveLength(1);
      expect(datasets[0]?.name).toContain("Hallucination Rate");
    });
  });

  describe("extractModelSlugFromDetailsUrl", () => {
    test("extracts slug from details url", () => {
      expect(extractModelSlugFromDetailsUrl("/models/gpt-5-4/providers")).toBe("gpt-5-4");
      expect(extractModelSlugFromDetailsUrl("/wat/nope")).toBeNull();
    });
  });

  describe("buildModelAggregate", () => {
    test("merges defaultData and ldjson datasets", () => {
      const aggregate = buildModelAggregate({
        defaultDataByPage: {
          foo: [[
            { slug: "gpt-5-4", name: "GPT-5.4", terminalbench_hard: 0.57 },
          ]],
        },
        datasetsByPage: {
          omniscience: [
            {
              name: "AA-Omniscience Hallucination Rate",
              data: [
                {
                  modelName: "GPT-5.4",
                  omniscienceHallucinationRate: 0.25,
                  detailsUrl: "/models/gpt-5-4/providers",
                },
              ],
            },
          ],
        },
      });
      expect(aggregate["gpt-5-4"]?.terminalbench_hard).toBe(0.57);
      expect(aggregate["gpt-5-4"]?.aa_site_omniscience_hallucination_rate).toBe(0.25);
    });
  });

  describe("scrapeAaSiteToCache", () => {
    test("writes raw and parsed artifacts", async () => {
      const pageHtml = String.raw`
        <html><body>
          <script>self.__next_f.push([1,"xx \"defaultData\":[{\"slug\":\"gpt-5-4\",\"terminalbench_hard\":0.5}] yy"])</script>
          <script type="application/ld+json">{"@type":"Dataset","name":"AA-Omniscience Accuracy","data":[{"modelName":"GPT-5.4","omniscienceAccuracy":0.55,"detailsUrl":"/models/gpt-5-4/providers"}]}</script>
        </body></html>
      `;
      const manifest = await scrapeAaSiteToCache({
        cacheDir: tmpRoot,
        pages: [{ id: "test", url: "https://example.test/eval" }],
        fetchImpl: ((async () =>
          ({ ok: true, text: async () => pageHtml } as Response)) as unknown) as typeof fetch,
      });

      expect(fs.existsSync(path.join(tmpRoot, "raw", "test.html"))).toBe(true);
      expect(fs.existsSync(path.join(tmpRoot, "parsed", "test.defaultData.0.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmpRoot, "aggregate", "all-models.json"))).toBe(true);
      expect(manifest.pages[0]?.modelCount).toBe(1);
    });
  });

  // === LOD 22: Pure math / normalization tests ===

  describe("normalizeContextWindowTokens", () => {
    test("returns 0 for 128k tokens (floor)", () => {
      expect(normalizeContextWindowTokens(128000)).toBe(0);
    });

    test("returns 100 for 1m tokens (ceiling)", () => {
      expect(normalizeContextWindowTokens(1_000_000)).toBe(100);
    });

    test("returns 0 for tokens below floor", () => {
      expect(normalizeContextWindowTokens(100000)).toBe(0);
      expect(normalizeContextWindowTokens(50000)).toBe(0);
    });

    test("returns 100 for tokens above ceiling", () => {
      expect(normalizeContextWindowTokens(2_000_000)).toBe(100);
    });

    test("scales log-linear between floor and ceiling", () => {
      // 256k should be ~33 (log2(2) / log2(7.8125) * 100)
      const score256k = normalizeContextWindowTokens(256000);
      expect(score256k).toBeGreaterThan(0);
      expect(score256k).toBeLessThan(50);

      // 512k should be ~58 (log2(4) / log2(7.8125) * 100)
      const score512k = normalizeContextWindowTokens(512000);
      expect(score512k).toBeGreaterThan(score256k);
      expect(score512k).toBeLessThan(100);
    });
  });

  describe("buildToolCallingScore", () => {
    test("returns undefined when all components missing", () => {
      expect(buildToolCallingScore({})).toBeUndefined();
    });

    test("computes weighted average with all components", () => {
      // terminalbenchHard=0.5 @ 0.5, tau2=0.5 @ 0.3, agenticIndex=50 @ 0.2
      // = (50*0.5 + 50*0.3 + 50*0.2) / 1.0 = 50
      const score = buildToolCallingScore({
        terminalbenchHard: 0.5,
        tau2: 0.5,
        agenticIndex: 50,
      });
      expect(score).toBeCloseTo(50, 1);
    });

    test("renormalizes when components missing", () => {
      // only terminalbenchHard=0.6 @ 0.5
      // = (60*0.5) / 0.5 = 60
      const score = buildToolCallingScore({
        terminalbenchHard: 0.6,
      });
      expect(score).toBeCloseTo(60, 1);
    });

    test("renormalizes with two components", () => {
      // terminalbenchHard=0.4 @ 0.5, tau2=0.8 @ 0.3
      // = (40*0.5 + 80*0.3) / 0.8 = (20 + 24) / 0.8 = 55
      const score = buildToolCallingScore({
        terminalbenchHard: 0.4,
        tau2: 0.8,
      });
      expect(score).toBeCloseTo(55, 1);
    });

    test("uses agenticIndex directly (already 0-100 scale)", () => {
      // agenticIndex=75 @ 0.2
      // = 75*0.2 / 0.2 = 75
      const score = buildToolCallingScore({
        agenticIndex: 75,
      });
      expect(score).toBeCloseTo(75, 1);
    });
  });

  describe("extractHallucinationScore", () => {
    test("extracts from non_hallucination_rate (preferred)", () => {
      const siteData = {
        omniscience_breakdown: {
          total: {
            non_hallucination_rate: 0.9,
          },
        },
      };
      // extractHallucinationScore is not exported, test via merge
      const models: EvaluatedModel[] = [{
        id: "test-model",
        providerModel: "test/model",
        displayName: "Test Model",
        metrics: {},
        metricSources: {},
        facts: {},
        supplements: {},
        notes: [],
      }];
      const result = mergeSiteAggregateIntoEvaluatedModels({
        models,
        aggregate: { "test-slug": siteData },
        slugToModelId: new Map([["test-slug", "test-model"]]),
      });
      expect(result[0]?.metrics.hallucination).toBeCloseTo(90, 1);
    });

    test("inverts hallucination_rate when non_hallucination_rate missing", () => {
      const siteData = {
        omniscience_breakdown: {
          total: {
            hallucination_rate: 0.15,
          },
        },
      };
      const models: EvaluatedModel[] = [{
        id: "test-model",
        providerModel: "test/model",
        displayName: "Test Model",
        metrics: {},
        metricSources: {},
        facts: {},
        supplements: {},
        notes: [],
      }];
      const result = mergeSiteAggregateIntoEvaluatedModels({
        models,
        aggregate: { "test-slug": siteData },
        slugToModelId: new Map([["test-slug", "test-model"]]),
      });
      // (1 - 0.15) * 100 = 85
      expect(result[0]?.metrics.hallucination).toBeCloseTo(85, 1);
    });

    test("falls back to ld+json hallucination rate", () => {
      const siteData = {
        aa_site_omniscience_hallucination_rate: 0.2,
      };
      const models: EvaluatedModel[] = [{
        id: "test-model",
        providerModel: "test/model",
        displayName: "Test Model",
        metrics: {},
        metricSources: {},
        facts: {},
        supplements: {},
        notes: [],
      }];
      const result = mergeSiteAggregateIntoEvaluatedModels({
        models,
        aggregate: { "test-slug": siteData },
        slugToModelId: new Map([["test-slug", "test-model"]]),
      });
      // (1 - 0.2) * 100 = 80
      expect(result[0]?.metrics.hallucination).toBeCloseTo(80, 1);
    });
  });

  // === LOD 22: Source matching tests ===

  describe("buildSlugToModelIdMap", () => {
    test("maps siteSlugs to model id", () => {
      const candidates: CandidateModel[] = [{
        id: "gemini-3-flash",
        providerModel: "google/gemini-3-flash",
        displayName: "Gemini 3 Flash",
        aaMatch: { apiSlug: "gemini-3-flash-preview", siteSlugs: ["gemini-3-flash"] },
      }];
      const map = buildSlugToModelIdMap(candidates);
      expect(map.get("gemini-3-flash")).toBe("gemini-3-flash");
      expect(map.get("gemini-3-flash-preview")).toBe("gemini-3-flash");
    });

    test("maps apiSlug when no siteSlugs", () => {
      const candidates: CandidateModel[] = [{
        id: "gpt-5-4",
        providerModel: "openai/gpt-5.4",
        displayName: "GPT-5.4",
        aaMatch: { apiSlug: "gpt-5-4" },
      }];
      const map = buildSlugToModelIdMap(candidates);
      expect(map.get("gpt-5-4")).toBe("gpt-5-4");
    });

    test("maps multiple siteSlugs to same model id", () => {
      const candidates: CandidateModel[] = [{
        id: "gemini-3-1-pro",
        providerModel: "google/gemini-3.1-pro",
        displayName: "Gemini 3.1 Pro",
        aaMatch: { apiSlug: "gemini-3-1-pro-preview", siteSlugs: ["gemini-3-1-pro-preview", "gemini-3-1-pro"] },
      }];
      const map = buildSlugToModelIdMap(candidates);
      expect(map.get("gemini-3-1-pro-preview")).toBe("gemini-3-1-pro");
      expect(map.get("gemini-3-1-pro")).toBe("gemini-3-1-pro");
    });
  });

  // === LOD 22: Integration-ish model merge tests ===

  describe("mergeSiteAggregateIntoEvaluatedModels", () => {
    test("api metrics survive when site data adds new dimensions", () => {
      const models: EvaluatedModel[] = [{
        id: "test-model",
        providerModel: "test/model",
        displayName: "Test Model",
        metrics: { intelligence: 75, price: 90 },
        metricSources: { intelligence: { source: "aa-api", confidence: "verified" } },
        facts: {},
        supplements: {},
        notes: [],
      }];
      const siteData = {
        ifbench: 0.8,
        context_window_tokens: 200000,
      };
      const result = mergeSiteAggregateIntoEvaluatedModels({
        models,
        aggregate: { "test-slug": siteData },
        slugToModelId: new Map([["test-slug", "test-model"]]),
      });
      // api metrics preserved
      expect(result[0]?.metrics.intelligence).toBe(75);
      expect(result[0]?.metrics.price).toBe(90);
      // site metrics added
      expect(result[0]?.metrics.instructionFollowing).toBe(80);
    });

    test("site data populates facts with raw values", () => {
      const models: EvaluatedModel[] = [{
        id: "test-model",
        providerModel: "test/model",
        displayName: "Test Model",
        metrics: {},
        metricSources: {},
        facts: {},
        supplements: {},
        notes: [],
      }];
      const siteData = {
        context_window_tokens: 400000,
        terminalbench_hard: 0.57,
        tau2: 0.73,
        lcr: 0.85,
        ifbench: 0.72,
        omniscience_breakdown: { total: { hallucination_rate: 0.1 } },
      };
      const result = mergeSiteAggregateIntoEvaluatedModels({
        models,
        aggregate: { "test-slug": siteData },
        slugToModelId: new Map([["test-slug", "test-model"]]),
      });
      expect(result[0]?.facts.contextWindowTokens).toBe(400000);
      expect(result[0]?.facts.terminalbenchHard).toBe(0.57);
      expect(result[0]?.facts.tau2).toBe(0.73);
      expect(result[0]?.facts.lcr).toBe(0.85);
      expect(result[0]?.facts.ifbench).toBe(0.72);
      expect(result[0]?.facts.hallucinationRate).toBe(0.1);
    });

    test("does not overwrite existing metrics", () => {
      const models: EvaluatedModel[] = [{
        id: "test-model",
        providerModel: "test/model",
        displayName: "Test Model",
        metrics: { toolCalling: 95 },
        metricSources: { toolCalling: { source: "aa-api", confidence: "verified" } },
        facts: {},
        supplements: {},
        notes: [],
      }];
      const siteData = {
        terminalbench_hard: 0.5,
        tau2: 0.5,
        agentic_index: 50,
      };
      const result = mergeSiteAggregateIntoEvaluatedModels({
        models,
        aggregate: { "test-slug": siteData },
        slugToModelId: new Map([["test-slug", "test-model"]]),
      });
      // existing metric preserved
      expect(result[0]?.metrics.toolCalling).toBe(95);
    });

    test("metricSources tracks provenance", () => {
      const models: EvaluatedModel[] = [{
        id: "test-model",
        providerModel: "test/model",
        displayName: "Test Model",
        metrics: {},
        metricSources: {},
        facts: {},
        supplements: {},
        notes: [],
      }];
      const siteData = {
        context_window_tokens: 256000,
        ifbench: 0.75,
        omniscience_breakdown: { total: { non_hallucination_rate: 0.92 } },
      };
      const result = mergeSiteAggregateIntoEvaluatedModels({
        models,
        aggregate: { "test-slug": siteData },
        slugToModelId: new Map([["test-slug", "test-model"]]),
      });
      expect(result[0]?.metricSources.context?.source).toBe("aa-site-metadata");
      expect(result[0]?.metricSources.instructionFollowing?.source).toBe("aa-site-ifbench");
      expect(result[0]?.metricSources.hallucination?.source).toBe("aa-site-omniscience");
    });

    test("returns unchanged model when no site data match", () => {
      const models: EvaluatedModel[] = [{
        id: "orphan-model",
        providerModel: "test/orphan",
        displayName: "Orphan Model",
        metrics: { intelligence: 50 },
        metricSources: {},
        facts: {},
        supplements: {},
        notes: [],
      }];
      const siteData = { ifbench: 0.8 };
      const result = mergeSiteAggregateIntoEvaluatedModels({
        models,
        aggregate: { "other-slug": siteData },
        slugToModelId: new Map([["other-slug", "other-model"]]),
      });
      expect(result[0]?.metrics).toEqual({ intelligence: 50 });
      expect(result[0]?.notes).toEqual([]);
    });
  });
}
