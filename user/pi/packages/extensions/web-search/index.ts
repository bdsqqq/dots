/**
 * web_search tool — direct HTTP call to Parallel AI's Search API.
 *
 * uses curl (not fetch/SDK) because pi extensions run in a nix-built
 * environment where adding npm deps requires a rebuild. curl is always
 * available and the single-endpoint usage doesn't justify the SDK.
 *
 * cost is derived from the response's usage array, not hardcoded —
 * the API returns UsageItem[] with SKU counts, we multiply by known
 * unit prices. if the API omits usage, we fall back to base search cost.
 *
 * refs:
 *   schema: https://docs.parallel.ai/public-openapi.json (UsageItem)
 *   pricing: https://docs.parallel.ai/pricing (Search API section)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  boxRendererWindowed,
  osc8Link,
  type BoxSection,
  type Excerpt,
} from "@bds_pi/box-format";
import { Type } from "@sinclair/typebox";
import type { ToolCostDetails } from "@bds_pi/tool-cost";

type WebSearchExtConfig = {
  defaultMaxResults: number;
  endpoint: string;
  curlTimeoutSecs: number;
};

type WebSearchExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: WebSearchExtConfig = {
  defaultMaxResults: 10,
  endpoint: "https://api.parallel.ai/v1beta/search",
  curlTimeoutSecs: 30,
};

const DEFAULT_DEPS: WebSearchExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isWebSearchConfig(value: Record<string, unknown>): value is WebSearchExtConfig {
  return (
    typeof value.defaultMaxResults === "number" &&
    Number.isInteger(value.defaultMaxResults) &&
    value.defaultMaxResults >= 1 &&
    typeof value.endpoint === "string" &&
    value.endpoint.trim().length > 0 &&
    typeof value.curlTimeoutSecs === "number" &&
    Number.isInteger(value.curlTimeoutSecs) &&
    value.curlTimeoutSecs >= 1
  );
}

const WEB_SEARCH_CONFIG_SCHEMA: ExtensionConfigSchema<WebSearchExtConfig> = {
  validate: isWebSearchConfig,
};

/** per-result excerpts for collapsed display — first 5 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 5 }];

interface SearchResult {
  url: string;
  title: string;
  publish_date?: string;
  excerpts: string[];
}

/**
 * usage line item from the API response.
 * schema: https://docs.parallel.ai/public-openapi.json → UsageItem
 */
interface UsageItem {
  name: string;
  count: number;
}

/** per-unit pricing by SKU name ($/unit). ref: https://docs.parallel.ai/pricing */
const SKU_UNIT_COST: Record<string, number> = {
  sku_search: 0.005,
  sku_search_additional_results: 0.001,
};

/** falls back to base search cost when API omits usage (e.g., older API versions). */
function costFromUsage(usage: UsageItem[] | undefined): number {
  if (!usage?.length) return SKU_UNIT_COST.sku_search ?? 0;
  let total = 0;
  for (const item of usage) {
    total += (SKU_UNIT_COST[item.name] ?? 0) * item.count;
  }
  return total;
}

interface SearchResponse {
  search_id?: string;
  results: SearchResult[];
  warnings?: string[];
  usage?: UsageItem[];
}

function searchParallel(
  apiKey: string,
  body: Record<string, unknown>,
  endpoint: string,
  curlTimeoutSecs: number,
  signal?: AbortSignal,
): Promise<{ data?: SearchResponse; error?: string }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);

    const args = [
      "-sL",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-H",
      `x-api-key: ${apiKey}`,
      "-H",
      "parallel-beta: search-extract-2025-10-10",
      "-m",
      String(curlTimeoutSecs),
      "-d",
      payload,
      endpoint,
    ];

    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      if (!child.killed) child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ error: `curl error: ${err.message}` });
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        resolve({ error: "search aborted" });
        return;
      }
      if (code !== 0) {
        resolve({
          error: `search failed: ${stderr.trim() || `curl exited with code ${code}`}`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as SearchResponse;
        resolve({ data: parsed });
      } catch {
        resolve({
          error: `invalid response from Parallel API: ${stdout.slice(0, 200)}`,
        });
      }
    });
  });
}

function formatResults(results: SearchResult[]): {
  text: string;
  headerLineIndices: number[];
} {
  if (results.length === 0)
    return { text: "(no results found)", headerLineIndices: [] };

  const lines: string[] = [];
  const headerLineIndices: number[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    headerLineIndices.push(lines.length);
    lines.push(`### ${r.title || "(untitled)"}`);
    lines.push(r.url!);
    if (r.publish_date) lines.push(`*${r.publish_date}*`);
    if (r.excerpts?.length) {
      lines.push("");
      for (let j = 0; j < r.excerpts.length; j++) {
        const excerptLines = r.excerpts[j]!.split("\n");
        lines.push(...excerptLines);
        if (j < r.excerpts.length - 1) lines.push("");
      }
    }

    if (i < results.length - 1) {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return { text: lines.join("\n"), headerLineIndices };
}

/** convert raw SearchResult[] into BoxSection[] for box-format rendering. */
function resultsToSections(results: SearchResult[]): BoxSection[] {
  return results.map((r) => {
    const lines = [];
    lines.push({ text: osc8Link(r.url, r.url), highlight: true });
    if (r.publish_date) lines.push({ text: r.publish_date, highlight: true });
    if (r.excerpts?.length) {
      lines.push({ text: "", highlight: false });
      for (let j = 0; j < r.excerpts.length; j++) {
        for (const l of r.excerpts[j]!.split("\n")) {
          lines.push({ text: l, highlight: false });
        }
        if (j < r.excerpts.length - 1)
          lines.push({ text: "", highlight: false });
      }
    }
    return {
      header: r.title || "(untitled)",
      blocks: [{ lines }],
    };
  });
}

interface WebSearchParams {
  objective: string;
  search_queries?: string[];
  max_results?: number;
}

export function createWebSearchTool(config: WebSearchExtConfig = CONFIG_DEFAULTS): ToolDefinition {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for information relevant to a research objective.\n\n" +
      "Use when you need up-to-date or precise documentation. " +
      "Use `read_web_page` to fetch full content from a specific URL.\n\n" +
      "# Examples\n\n" +
      "Get API documentation for a specific provider\n" +
      '```json\n{"objective":"I want to know the request fields for the Stripe billing create customer API. Prefer Stripe\'s docs site."}\n```\n\n' +
      "See usage documentation for newly released library features\n" +
      '```json\n{"objective":"I want to know how to use SvelteKit remote functions, which is a new feature shipped in the last month.","search_queries":["sveltekit","remote function"]}\n```',

    parameters: Type.Object({
      objective: Type.String({
        description:
          "A natural-language description of the broader task or research goal, " +
          "including any source or freshness guidance.",
      }),
      search_queries: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional keyword queries to ensure matches for specific terms are " +
            "prioritized (recommended for best results).",
        }),
      ),
      max_results: Type.Optional(
        Type.Number({
          description: `The maximum number of results to return (default: ${config.defaultMaxResults}).`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const p = params as WebSearchParams;
      const apiKey = process.env.PARALLEL_API_KEY;
      if (!apiKey) {
        return {
          content: [
            {
              type: "text" as const,
              text: "PARALLEL_API_KEY not set. add it to secrets.yaml and export in shell.nix.",
            },
          ],
          isError: true,
        } as any;
      }

      const body: Record<string, unknown> = {
        objective: p.objective,
        max_results: p.max_results ?? config.defaultMaxResults,
        excerpts: { max_chars_per_result: 2000 },
      };
      if (p.search_queries?.length) {
        body.search_queries = p.search_queries;
      }

      const { data, error } = await searchParallel(apiKey, body, config.endpoint, config.curlTimeoutSecs, signal);

      if (error) {
        return {
          content: [{ type: "text" as const, text: error }],
          isError: true,
        } as any;
      }

      if (!data?.results) {
        return {
          content: [{ type: "text" as const, text: "(no results)" }],
        } as any;
      }

      const { text, headerLineIndices } = formatResults(data.results);
      let output = text;

      if (data.warnings?.length) {
        output += `\n\n**Warnings:** ${data.warnings.join("; ")}`;
      }

      const resultSections = resultsToSections(data.results);
      const details: ToolCostDetails & {
        matchLineIndices?: number[];
        resultSections?: BoxSection[];
      } = {
        cost: costFromUsage(data.usage),
        matchLineIndices: headerLineIndices,
        resultSections,
      };
      return { content: [{ type: "text" as const, text: output }], details };
    },

    renderCall(args: any, theme: any) {
      const objective = args.objective || "...";
      const short =
        objective.length > 70 ? `${objective.slice(0, 70)}...` : objective;
      let text =
        theme.fg("toolTitle", theme.bold("web_search ")) +
        theme.fg("dim", short);
      if (args.search_queries?.length) {
        text += theme.fg("muted", ` [${args.search_queries.join(", ")}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const sections: BoxSection[] | undefined = result.details?.resultSections;
      if (!sections?.length) {
        const text = result.content?.[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }
      return boxRendererWindowed(
        () => sections,
        {
          collapsed: { maxSections: 3, excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
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

const webSearchExtension: (pi: ExtensionAPI) => void = createWebSearchExtension();

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
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  });

  describe("web-search extension", () => {
    it("registers the tool with default config when enabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
          enabled: true,
          config: defaults,
        }),
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createWebSearchExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
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
        <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
          enabled: false,
          config: defaults,
        }),
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createWebSearchExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
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
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createWebSearchExtension({
        ...DEFAULT_DEPS,
        withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
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
