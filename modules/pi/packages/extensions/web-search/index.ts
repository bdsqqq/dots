/**
 * retrieval, not research delegation. let the calling model control coverage and
 * evidence budgets; keep provider defaults adaptive rather than compressing every
 * source to an arbitrary local limit.
 * contract: https://docs.parallel.ai/api-reference/search/search.md
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { renderLifecycleCall, framedTextRenderer } from "@bds_pi/box-format";
import {
  Type,
  type Static,
  type TObject,
  type TOptional,
  type TString,
  type TArray,
  type TInteger,
  type TUnsafe,
} from "typebox";
import { Assert } from "typebox/value";
import {
  parallelRequest,
  retrievalIdentity,
  publishResult,
  continueResult,
  formatWarnings,
  usageCost,
  fetchPolicySchema,
  resolveFetchPolicy,
} from "@bds_pi/web-retrieval";

type SearchMode = "turbo" | "fast" | "basic" | "advanced";

type WebSearchExtConfig = {
  defaultMaxResults: number;
  endpoint: string;
  requestTimeoutSecs: number;
  defaultMode: SearchMode;
  maxRetries: number;
};

type WebSearchExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: WebSearchExtConfig = {
  defaultMaxResults: 10,
  endpoint: "https://api.parallel.ai/v1/search",
  requestTimeoutSecs: 120,
  defaultMode: "advanced",
  maxRetries: 2,
};

const DEFAULT_DEPS: WebSearchExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isWebSearchConfig(
  value: Record<string, unknown>,
): value is WebSearchExtConfig {
  return (
    typeof value.defaultMaxResults === "number" &&
    Number.isInteger(value.defaultMaxResults) &&
    value.defaultMaxResults >= 1 &&
    value.defaultMaxResults <= 20 &&
    value.endpoint === CONFIG_DEFAULTS.endpoint &&
    typeof value.requestTimeoutSecs === "number" &&
    Number.isInteger(value.requestTimeoutSecs) &&
    value.requestTimeoutSecs >= 1 &&
    typeof value.defaultMode === "string" &&
    ["turbo", "fast", "basic", "advanced"].includes(value.defaultMode) &&
    typeof value.maxRetries === "number" &&
    Number.isInteger(value.maxRetries) &&
    value.maxRetries >= 0 &&
    value.maxRetries <= 2
  );
}

const WEB_SEARCH_CONFIG_SCHEMA: ExtensionConfigSchema<WebSearchExtConfig> = {
  validate: isWebSearchConfig,
};

interface SearchResult {
  url: string;
  title?: string | null;
  publish_date?: string | null;
  excerpts: string[];
}

function formatResults(results: SearchResult[]): string {
  if (!results.length) return "(no results found)";
  return results
    .map((result) => {
      const sections = [`### ${result.title || "(untitled)"}`, result.url];
      if (result.publish_date) sections.push(`*${result.publish_date}*`);
      if (result.excerpts.length)
        sections.push("", result.excerpts.join("\n\n"));
      return sections.join("\n");
    })
    .join("\n\n---\n\n");
}

const searchSchema: TObject<{
  objective: TOptional<TString>;
  search_queries: TOptional<TArray<TString>>;
  mode: TOptional<TUnsafe<SearchMode>>;
  max_results: TOptional<TInteger>;
  max_chars_total: TOptional<TInteger>;
  max_chars_per_result: TOptional<TInteger>;
  source_policy: TOptional<
    TObject<{
      include_domains: TOptional<TArray<TString>>;
      exclude_domains: TOptional<TArray<TString>>;
      after_date: TOptional<TString>;
    }>
  >;
  fetch_policy: TOptional<typeof fetchPolicySchema>;
  location: TOptional<TString>;
  session_id: TOptional<TString>;
  cursor: TOptional<TString>;
  max_length: TOptional<TInteger>;
}> = Type.Object(
  {
    objective: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 5000,
        description:
          "Self-contained research goal and context. Prefer sources here; source_policy is a HARD filter.",
      }),
    ),
    search_queries: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        minItems: 1,
        maxItems: 5,
        description:
          "Required for a new search: 1–5 concise keyword queries. Usually 2–3 distinct angles, not repeated instructions.",
      }),
    ),
    mode: Type.Optional(
      Type.Unsafe<SearchMode>({
        type: "string",
        enum: ["turbo", "fast", "basic", "advanced"],
        description:
          "Default advanced: deeper retrieval/compression. basic: extended snippets. fast: low latency. turbo: simplest, English/Japanese; no path filters.",
      }),
    ),
    max_results: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 20,
        description:
          "Default 10; upstream maximum 20. Broader coverage needs distinct searches, which may run concurrently.",
      }),
    ),
    max_chars_total: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Total excerpt-character budget. Omit for provider-adaptive sizing; no local 2,000-character cap.",
      }),
    ),
    max_chars_per_result: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Optional excerpt-character budget per source. Omit to let the provider choose.",
      }),
    ),
    source_policy: Type.Optional(
      Type.Object(
        {
          include_domains: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              maxItems: 200,
              description:
                "Only these domains/path prefixes/extensions. Cannot combine nonempty include and exclude lists.",
            }),
          ),
          exclude_domains: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              maxItems: 200,
              description:
                "Block these domains/path prefixes/extensions. No schemes, ports or wildcards.",
            }),
          ),
          after_date: Type.Optional(
            Type.String({
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description:
                "Earliest publication date YYYY-MM-DD; NOT cache freshness.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    fetch_policy: Type.Optional(fetchPolicySchema),
    location: Type.Optional(
      Type.String({
        pattern: "^[a-zA-Z]{2}$",
        description:
          "Country code, e.g. br/us/gb. Unset by default. Upstream may warn for unsupported codes.",
      }),
    ),
    session_id: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1000,
        description:
          "Optional explicit grouping across Search/Extract. Default is opaque and task/branch-scoped; overrides deliberately share context.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Continue an existing search snapshot in this session branch; no new API call. Exclusive with search fields. Expires after 24h.",
      }),
    ),
    max_length: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Visible page length, not retrieval budget. Remaining evidence is available via cursor.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type WebSearchParams = Static<typeof searchSchema>;

function validateParams(input: WebSearchParams): WebSearchParams {
  const p = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value != null),
  );
  Assert(searchSchema, p);
  if (p.cursor) {
    if (Object.keys(p).some((key) => key !== "cursor" && key !== "max_length"))
      throw new Error(
        "cursor is exclusive with search controls; only max_length is allowed",
      );
    return p;
  }
  if (
    !p.search_queries?.length ||
    p.search_queries.some((query) => !query.trim())
  )
    throw new Error(
      "search_queries requires 1–5 nonempty keyword queries; objective alone is not a v1 search",
    );
  const {
    include_domains = [],
    exclude_domains = [],
    after_date,
  } = p.source_policy ?? {};
  if (include_domains.length && exclude_domains.length)
    throw new Error(
      "choose include_domains OR exclude_domains: upstream ignores excludes when includes are set",
    );
  if (include_domains.length + exclude_domains.length > 200)
    throw new Error("source filters exceed the upstream combined limit of 200");
  for (const source of [...include_domains, ...exclude_domains]) {
    if (/[:?#*\s]/.test(source) || source.startsWith("/"))
      throw new Error(
        "source filters must be bare domains, extensions, or domain/path prefixes",
      );
    if (p.mode === "turbo" && source.includes("/"))
      throw new Error(
        "turbo does not support path filters; use fast/basic/advanced",
      );
  }
  if (
    after_date &&
    (!Number.isFinite(Date.parse(after_date)) ||
      new Date(after_date).toISOString().slice(0, 10) !== after_date)
  )
    throw new Error("after_date must be a real YYYY-MM-DD date");
  return p;
}

function isResult(value: unknown): value is SearchResult {
  if (typeof value !== "object" || !value) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.url === "string" &&
    /^https?:\/\//.test(r.url) &&
    (r.title == null || typeof r.title === "string") &&
    (r.publish_date == null || typeof r.publish_date === "string") &&
    Array.isArray(r.excerpts) &&
    r.excerpts.every((excerpt) => typeof excerpt === "string")
  );
}

export function createWebSearchTool(
  config: WebSearchExtConfig = CONFIG_DEFAULTS,
): ToolDefinition<typeof searchSchema> {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for ranked URLs and source excerpts, not generated answers. " +
      `Default mode ${config.defaultMode}, ${config.defaultMaxResults} results, adaptive excerpt budgets. ` +
      "Send a self-contained objective plus concise keyword search_queries. " +
      "Independent information needs can be searched concurrently; related query angles share one request. " +
      "Use read_web_page for document or focused extraction from known URLs. " +
      "Time-sensitive facts can request fetch_policy with a maximum cache age; publication date is separate. " +
      "Oversized evidence is retained for 24h: pass its cursor to this tool to continue without searching again.\n" +
      'Example: {"objective":"Find Stripe customer creation fields; prefer official documentation","search_queries":["Stripe create customer API fields"]}',
    parameters: searchSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const p = validateParams(params);
      if (p.cursor)
        return continueResult(p.cursor, ctx, "web_search", p.max_length);
      const mode = p.mode ?? config.defaultMode;
      // Validate mode-dependent constraints against the effective, not merely explicit, mode.
      validateParams({ ...p, mode });
      const policy = resolveFetchPolicy(p.fetch_policy);
      const settings = {
        max_results: p.max_results ?? config.defaultMaxResults,
        ...(p.source_policy ? { source_policy: p.source_policy } : {}),
        ...(policy ? { fetch_policy: policy } : {}),
        ...(p.location ? { location: p.location.toLowerCase() } : {}),
        ...(p.max_chars_per_result !== undefined
          ? {
              excerpt_settings: {
                max_chars_per_result: p.max_chars_per_result,
              },
            }
          : {}),
      };
      const body = {
        search_queries: p.search_queries,
        ...(p.objective !== undefined ? { objective: p.objective } : {}),
        mode,
        ...retrievalIdentity(ctx, p.session_id),
        ...(p.max_chars_total !== undefined
          ? { max_chars_total: p.max_chars_total }
          : {}),
        advanced_settings: settings,
      };
      const data = await parallelRequest(config.endpoint, body, {
        signal,
        maxRetries: config.maxRetries,
        timeoutSeconds: Math.max(
          config.requestTimeoutSecs,
          (policy?.timeout_seconds ?? 0) + 30,
        ),
      });
      if (!Array.isArray(data.results) || !data.results.every(isResult))
        throw new Error(
          "malformed Parallel search response: expected results with URLs and excerpt arrays",
        );
      const text = formatResults(data.results);
      const metadata = Object.fromEntries(
        Object.entries(data).filter(([key]) => key !== "results"),
      );
      const base = mode === "fast" || mode === "turbo" ? 0.001 : 0.005;
      const cost = usageCost(
        data.usage,
        base + Math.max(0, data.results.length - 10) * 0.001,
        base,
      );
      const warnings = formatWarnings(data.warnings);
      const output = [
        `search metadata: ${JSON.stringify({ ...metadata, mode, fetch_policy: policy })}`,
        warnings && `warnings:\n${warnings}`,
        cost.unknownSkus?.length &&
          `cost unknown: unrecognized usage SKUs ${cost.unknownSkus.join(", ")}`,
        text,
      ]
        .filter(Boolean)
        .join("\n\n");
      signal?.throwIfAborted();
      return publishResult(
        output,
        ctx,
        { ...metadata, mode, ...cost },
        "web_search",
        { length: p.max_length },
      );
    },

    renderCall(args: any, theme: any, context: any) {
      const objective = args.objective || "...";
      const short =
        objective.length > 70 ? `${objective.slice(0, 70)}...` : objective;
      let text =
        theme.fg("toolTitle", theme.bold("web_search ")) +
        theme.fg("dim", short);
      if (args.search_queries?.length) {
        text += theme.fg("muted", ` [${args.search_queries.join(", ")}]`);
      }
      return renderLifecycleCall(new Text(text, 0, 0), theme, context);
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const text = result.content?.[0];
      return framedTextRenderer(
        text?.type === "text" ? text.text : "(no output)",
        expanded,
      );
    },
  };
}

function createWebSearchExtension(
  deps: WebSearchExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function webSearchExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/web-search",
      CONFIG_DEFAULTS,
      { schema: WEB_SEARCH_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(deps.withPromptPatch(createWebSearchTool(cfg)));
  };
}

const webSearchExtension: (pi: ExtensionAPI) => void =
  createWebSearchExtension();

export default webSearchExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const tmpdir = os.tmpdir();

  function writeTmpJson(dir: string, filename: string, data: unknown): string {
    const filePath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  function createMockExtensionApiHarness() {
    const tools: unknown[] = [];

    const pi = {
      registerTool(tool: unknown) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;

    return { pi, tools };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  });

  describe("search v1 evidence contract", () => {
    it("preserves excerpt whitespace and source boundaries", () => {
      expect(
        formatResults([
          {
            url: "https://example.com",
            title: "source 🌍",
            publish_date: "2026-01-01",
            excerpts: ["first\n", "", "last"],
          },
          { url: "https://example.org", excerpts: [] },
        ]),
      ).toBe(
        "### source 🌍\nhttps://example.com\n*2026-01-01*\n\nfirst\n\n\n\n\nlast\n\n---\n\n### (untitled)\nhttps://example.org",
      );
    });
    type Context = Parameters<
      ReturnType<typeof createWebSearchTool>["execute"]
    >[4];
    const entries: unknown[] = [];
    const ctx = {
      model: { id: "test-model" },
      sessionManager: {
        getSessionId: () => "search-contract-test",
        getBranch: () => entries,
      },
    } as unknown as Context;
    const run = (params: WebSearchParams) =>
      createWebSearchTool({ ...CONFIG_DEFAULTS, maxRetries: 0 }).execute(
        "search",
        params,
        undefined,
        undefined,
        ctx,
      );
    function network(
      results: unknown = [
        { url: "https://example.com", title: null, excerpts: ["evidence"] },
      ],
    ) {
      vi.stubEnv("PARALLEL_API_KEY", "test-key");
      return vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              search_id: "search-id",
              session_id: "server-session",
              results,
              warnings: [
                {
                  type: "new_warning_type",
                  message: "upstream warning",
                  detail: { constraint: 20 },
                },
              ],
              usage: [{ name: "sku_search", count: 1 }],
            }),
          ),
      );
    }
    it("sends the GA shape with quality-first adaptive defaults and model context", async () => {
      const fetch = network();
      const result = await run({
        search_queries: ["precise keyword query"],
        objective: "a focused goal",
      });
      expect(fetch.mock.calls[0]![0]).toEqual(
        new URL("https://api.parallel.ai/v1/search"),
      );
      const request = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
      expect(request).toEqual({
        search_queries: ["precise keyword query"],
        objective: "a focused goal",
        mode: "advanced",
        client_model: "test-model",
        session_id: expect.any(String),
        advanced_settings: { max_results: 10 },
      });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("upstream warning"),
      });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("evidence"),
      });
      expect(result.details).toMatchObject({
        search_id: "search-id",
        session_id: "server-session",
        cost: 0.005,
      });
    });
    it("exposes the complete retrieval controls without silently shrinking them", async () => {
      const fetch = network();
      await run({
        search_queries: ["one", "two", "three", "four", "five"],
        mode: "basic",
        max_results: 20,
        max_chars_total: 200000,
        max_chars_per_result: 60000,
        location: "BR",
        session_id: "explicit",
        source_policy: {
          include_domains: ["docs.example.com/api"],
          after_date: "2026-01-01",
        },
        fetch_policy: { max_age_seconds: 600, timeout_seconds: 60 },
      });
      expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject(
        {
          max_chars_total: 200000,
          session_id: "explicit",
          advanced_settings: {
            max_results: 20,
            location: "br",
            excerpt_settings: { max_chars_per_result: 60000 },
            source_policy: {
              include_domains: ["docs.example.com/api"],
              after_date: "2026-01-01",
            },
            fetch_policy: {
              max_age_seconds: 600,
              timeout_seconds: 60,
              disable_cache_fallback: true,
            },
          },
        },
      );
    });
    it("preserves an explicitly permitted stale-cache fallback", async () => {
      const fetch = network();
      await run({
        search_queries: ["query"],
        fetch_policy: { max_age_seconds: 600, disable_cache_fallback: false },
      });
      expect(
        JSON.parse(fetch.mock.calls[0]![1]!.body as string).advanced_settings
          .fetch_policy.disable_cache_fallback,
      ).toBe(false);
    });
    it("prices the shared search SKU according to the selected mode", async () => {
      network();
      const result = await run({ search_queries: ["query"], mode: "fast" });
      expect(result.details).toMatchObject({
        cost: 0.001,
        costEstimated: false,
      });
    });
    for (const invalid of [
      {},
      { objective: "no keywords" },
      { search_queries: ["  "] },
      { search_queries: Array(6).fill("query") },
      { search_queries: ["query"], max_results: 100 },
      { search_queries: ["query"], max_results: 2.5 },
      { search_queries: ["query"], max_chars_total: 0 },
      {
        search_queries: ["query"],
        mode: "turbo",
        source_policy: { include_domains: ["example.com/path"] },
      },
      {
        search_queries: ["query"],
        source_policy: {
          include_domains: ["example.com"],
          exclude_domains: ["other.com"],
        },
      },
      {
        search_queries: ["query"],
        source_policy: { after_date: "2026-02-30" },
      },
      { search_queries: ["query"], fetch_policy: { max_age_seconds: 0 } },
      { search_queries: ["query"], cursor: "not-a-cursor" },
    ]) {
      it(`rejects invalid request before network ${JSON.stringify(invalid).slice(0, 100)}`, async () => {
        const fetch = network();
        await expect(run(invalid as WebSearchParams)).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
      });
    }
    it("does not turn HTTP or malformed-response errors into empty success", async () => {
      const fetch = network();
      fetch.mockResolvedValueOnce(
        new Response('{"error":{"message":"denied"}}', { status: 401 }),
      );
      await expect(run({ search_queries: ["query"] })).rejects.toThrow(
        "HTTP 401",
      );
      fetch.mockResolvedValueOnce(
        new Response('{"error":{"message":"wrong shape"}}'),
      );
      await expect(run({ search_queries: ["query"] })).rejects.toThrow(
        "malformed",
      );
    });
    it("reports genuinely empty results and unknown prices honestly", async () => {
      const fetch = network([]);
      expect(
        (await run({ search_queries: ["query"] })).content[0],
      ).toMatchObject({ text: expect.stringContaining("no results found") });
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [],
            usage: [{ name: "new_sku", count: 1 }],
          }),
        ),
      );
      const result = await run({ search_queries: ["query"] });
      expect(result.details).not.toHaveProperty("cost");
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("cost unknown"),
      });
    });
    it("continues retained excerpts without another request or charge", async () => {
      const fetch = network([
        { url: "https://example.com", excerpts: ["evidence\n".repeat(6000)] },
      ]);
      const first = await run({ search_queries: ["query"] });
      entries.push({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "web_search",
          details: first.details,
        },
      });
      const cursor = (first.details as { webPage: { nextCursor: string } })
        .webPage.nextCursor;
      const next = await run({ cursor });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(next.details).toMatchObject({ cost: 0, continuation: true });
    });
    it("publishes huge multiline excerpts instead of exceeding the argument limit", async () => {
      const fetch = network([
        {
          url: "https://example.com",
          excerpts: ["evidence\n".repeat(150000)],
        },
      ]);
      const first = await run({ search_queries: ["large document"] });
      expect(first.details).toMatchObject({
        cost: 0.005,
        webPage: { total: expect.any(Number), nextCursor: expect.any(String) },
      });
      entries.push({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "web_search",
          details: first.details,
        },
      });
      const cursor = (first.details as { webPage: { nextCursor: string } })
        .webPage.nextCursor;
      const next = await run({ cursor });
      expect(next.content[0]).toMatchObject({
        text: expect.stringContaining("evidence\n"),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("web-search extension", () => {
    it("registers the tool with default config when enabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: true,
          config: defaults,
        }),
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createWebSearchExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/web-search",
        CONFIG_DEFAULTS,
        { schema: WEB_SEARCH_CONFIG_SCHEMA },
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
    });

    it("registers no tools when disabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: false,
          config: defaults,
        }),
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createWebSearchExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-web-search-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/web-search": {
          defaultMaxResults: 0,
          endpoint: "",
          curlTimeoutSecs: "fast",
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createWebSearchExtension({
        ...DEFAULT_DEPS,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/web-search; falling back to defaults.",
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
    });
  });
}
