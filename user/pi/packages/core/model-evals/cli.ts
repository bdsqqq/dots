/**
 * cli orchestration for model evaluation.
 *
 * commands:
 * - fetch: fetch and cache aa api data
 * - scrape-site: fetch and cache rich benchmark page data
 * - rank: evaluate role or agent
 * - report: generate full report
 * - inspect: show one model's details
 * - coverage: show data coverage
 */

import type {
  AgentProfile,
  EvaluatedModel,
  ModelId,
  OutputFormat,
  PresetName,
  RoleId,
  RoleProfile,
} from "./types";
import {
  agents,
  candidateModels,
  getAllDimensions,
  resolveAgentSelector,
  resolveModelSelector,
  roles,
} from "./registry";
import { getAaSnapshot, normalizeAaSnapshot, getDefaultCachePath } from "./aa";
import {
  DEFAULT_EVALUATION_PAGES,
  getDefaultSiteCacheDir,
  scrapeAaSiteToCache,
  loadCandidateSiteAggregate,
  buildSlugToModelIdMap,
  mergeSiteAggregateIntoEvaluatedModels,
} from "./aa-site";
import { supplementalMetrics, mergeSupplementalMetrics } from "./supplements";
import { evaluateRole } from "./evaluate";
import {
  renderJson,
  renderMarkdown,
  renderTable,
  renderCoverageSummary,
  renderTldrMatrix,
  renderPortfolioMatrix,
  renderInspectModel,
} from "./report";

export interface CliOptions {
  format?: OutputFormat;
  preset?: PresetName;
  cachePath?: string;
  refresh?: boolean;
  top?: number;
  tldr?: boolean;
}

type Command =
  | { kind: "fetch"; refresh?: boolean }
  | { kind: "scrape-site"; refresh?: boolean }
  | { kind: "rank"; target: "role" | "agent"; selector?: string }
  | { kind: "report"; all: boolean }
  | { kind: "inspect"; modelId: ModelId }
  | { kind: "coverage" }
  | { kind: "help" }
  | { kind: "unknown"; args: string[] };

function parseArgs(argv: readonly string[]): Command {
  if (argv.length === 0) {
    return { kind: "help" };
  }

  const [cmd, ...rest] = argv;

  switch (cmd) {
    case "fetch":
      return {
        kind: "fetch",
        refresh: rest.includes("--refresh"),
      };

    case "scrape-site":
      return {
        kind: "scrape-site",
        refresh: rest.includes("--refresh"),
      };

    case "rank":
      return parseRankArgs(rest);

    case "report":
      return parseReportArgs(rest);

    case "inspect":
      return parseInspectArgs(rest);

    case "coverage":
      return { kind: "coverage" };

    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };

    default:
      return { kind: "unknown", args: [...argv] };
  }
}

function parseRankArgs(args: string[]): Command {
  let target: "role" | "agent" | null = null;
  let selector: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--role") {
      target = "role";
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        selector = next;
        i += 1;
      }
    } else if (arg === "--agent") {
      target = "agent";
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        selector = next;
        i += 1;
      }
    } else if (arg === "--agent-file") {
      target = "agent";
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        selector = next;
        i += 1;
      }
    }
  }

  if (!target) {
    return { kind: "unknown", args };
  }

  return { kind: "rank", target, selector };
}

function parseReportArgs(args: string[]): Command {
  if (args.includes("--all")) {
    return { kind: "report", all: true };
  }
  return { kind: "unknown", args };
}

function parseInspectArgs(args: string[]): Command {
  const modelIdx = args.indexOf("--model");
  if (modelIdx === -1 || modelIdx + 1 >= args.length) {
    return { kind: "unknown", args };
  }

  const modelSelector = args[modelIdx + 1] ?? "";
  const modelId = resolveModelSelector(modelSelector);

  if (!modelId) {
    console.error(`unknown model: ${modelSelector}`);
    return { kind: "unknown", args };
  }

  return { kind: "inspect", modelId };
}

function renderHelp(): string {
  return `
model-evals — evaluate llm candidates for pi agents

commands:
  fetch [--refresh]         fetch and cache artificial analysis api data
  scrape-site [--refresh]   scrape and cache public benchmark page data
  rank --role [role]        evaluate models for a role, or list roles
  rank --agent [agent]      evaluate models for an agent, or list agents
  rank --agent-file <path>  evaluate models for an agent by file path
  report --all              generate portfolio matrix report
  inspect --model <model>   show details for one model
  coverage                  show data coverage by dimension

options:
  --format <md|json|table>  output format (default: md)
  --preset <name>           apply preset weights (balanced, cheap, fast, max-smarts)
  --tldr                    dense summary with rank ordinals
  --top <n>                 show top n models in table format
  --refresh                 re-fetch aa data
  --cache <path>            custom cache path

examples:
  bun run model-evals fetch
  bun run model-evals scrape-site
  bun run model-evals rank --role
  bun run model-evals rank --role dayToDay
  bun run model-evals rank --agent
  bun run model-evals rank --agent oracle --tldr
  bun run model-evals report --all
  bun run model-evals inspect --model glm-5
  bun run model-evals coverage
`.trim();
}

function formatCurrentModel(agent: AgentProfile): string {
  if (agent.currentModel === "inherits-default") {
    return `inherits ${agents.default.currentModel ?? "default"}`;
  }
  return agent.currentModel ?? "—";
}

function renderRoleCatalog(format: OutputFormat): string {
  const roleList = Object.values(roles);

  if (format === "json") {
    return JSON.stringify(
      roleList.map((role) => ({
        id: role.id,
        description: role.description,
        relevantDimensions: role.relevantDimensions,
        redFlagDimensions: role.redFlagDimensions ?? [],
      })),
      null,
      2,
    );
  }

  if (format === "table") {
    const lines: string[] = [];
    const header = ["role", "dimensions", "description"];
    const widths = [18, 40, 56];
    lines.push(header.map((h, i) => h.padEnd(widths[i]!)).join(" | "));
    lines.push(widths.map((w) => "─".repeat(w)).join("-+-"));
    for (const role of roleList) {
      lines.push(
        [
          role.id.slice(0, widths[0]!),
          role.relevantDimensions.join(", ").slice(0, widths[1]!),
          role.description.slice(0, widths[2]!),
        ]
          .map((value, i) => value.padEnd(widths[i]!))
          .join(" | "),
      );
    }
    return lines.join("\n");
  }

  const lines = ["# roles", ""];
  for (const role of roleList) {
    lines.push(`- \`${role.id}\` — ${role.description}`);
    lines.push(`  - dims: ${role.relevantDimensions.join(", ")}`);
    if (role.redFlagDimensions && role.redFlagDimensions.length > 0) {
      lines.push(`  - red flags: ${role.redFlagDimensions.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function renderAgentCatalog(format: OutputFormat): string {
  const agentList = Object.values(agents);

  if (format === "json") {
    return JSON.stringify(
      agentList.map((agent) => ({
        id: agent.id,
        label: agent.label,
        role: agent.role,
        currentModel: formatCurrentModel(agent),
      })),
      null,
      2,
    );
  }

  if (format === "table") {
    const lines: string[] = [];
    const header = ["agent", "role", "current", "label"];
    const widths = [18, 18, 22, 28];
    lines.push(header.map((h, i) => h.padEnd(widths[i]!)).join(" | "));
    lines.push(widths.map((w) => "─".repeat(w)).join("-+-"));
    for (const agent of agentList) {
      lines.push(
        [
          agent.id.slice(0, widths[0]!),
          agent.role.slice(0, widths[1]!),
          formatCurrentModel(agent).slice(0, widths[2]!),
          agent.label.slice(0, widths[3]!),
        ]
          .map((value, i) => value.padEnd(widths[i]!))
          .join(" | "),
      );
    }
    return lines.join("\n");
  }

  const lines = ["# agents", ""];
  for (const agent of agentList) {
    lines.push(
      `- \`${agent.id}\` → \`${agent.role}\` — ${agent.label} (current: ${formatCurrentModel(agent)})`,
    );
  }
  return lines.join("\n");
}

/**
 * get evaluated models from aa data.
 *
 * tries to load cached aa data. falls back to synthetic data if unavailable.
 * merges site aggregate data then supplemental metrics on top.
 * use `fetch` and `scrape-site` commands to populate the caches.
 */
async function getEvaluatedModels(
  cachePath?: string,
  refresh?: boolean,
): Promise<EvaluatedModel[]> {
  const snapshot = await getAaSnapshot({ cachePath, refresh });

  let models: EvaluatedModel[];
  if (snapshot) {
    models = normalizeAaSnapshot({
      snapshot,
      candidates: candidateModels,
    });
  } else {
    // fallback to synthetic data
    models = createSyntheticModels();
  }

  // merge site aggregate data (hallucination, context, ifbench)
  const siteAggregate = loadCandidateSiteAggregate();
  if (siteAggregate) {
    const slugToModelId = buildSlugToModelIdMap(candidateModels);
    models = mergeSiteAggregateIntoEvaluatedModels({
      models,
      aggregate: siteAggregate,
      slugToModelId,
    });
  }

  // merge supplements (only fills gaps site data didn't cover)
  return mergeSupplementalMetrics({
    models,
    supplemental: supplementalMetrics,
  });
}

/**
 * create synthetic evaluated models (fallback when no aa data).
 */
function createSyntheticModels(): EvaluatedModel[] {
  return candidateModels.map((candidate) => {
    // synthetic metrics for fallback
    // price is normalized: 100 = free, 0 = $100+/1M
    // realistic: premium ~$20-60/1M (score 40-80), flash ~$0.50/1M (score 99.5)
    const baseMetrics: Partial<Record<string, number>> = {
      coding: 50 + Math.random() * 40,
      intelligence: 50 + Math.random() * 40,
      price: 40 + Math.random() * 30, // default: mid-range pricing
      outputSpeed: 40 + Math.random() * 50,
      ttft: 40 + Math.random() * 50,
    };

    // add some role-appropriate variation
    const id = candidate.id.toLowerCase();
    if (
      id.includes("gpt-5-4") &&
      !id.includes("mini") &&
      !id.includes("nano")
    ) {
      baseMetrics.intelligence = 85 + Math.random() * 10;
      baseMetrics.coding = 85 + Math.random() * 10;
      baseMetrics.price = 50 + Math.random() * 25; // premium pricing
    }
    if (id.includes("gpt-5-2")) {
      baseMetrics.price = 55 + Math.random() * 20; // mid-tier pricing
    }
    if (id.includes("mini")) {
      baseMetrics.price = 95 + Math.random() * 4; // ~$0-5/1M, passes $5 guardrail
      baseMetrics.outputSpeed = 80 + Math.random() * 15;
    }
    if (id.includes("nano")) {
      baseMetrics.price = 96 + Math.random() * 3; // ~$1-4/1M, passes $5 guardrail
      baseMetrics.outputSpeed = 90 + Math.random() * 8;
    }
    if (id.includes("gemini-3-1-pro")) {
      baseMetrics.intelligence = 80 + Math.random() * 12;
      baseMetrics.coding = 78 + Math.random() * 12;
      baseMetrics.price = 60 + Math.random() * 20; // competitive
    }
    if (id.includes("flash")) {
      baseMetrics.outputSpeed = 85 + Math.random() * 10;
      baseMetrics.ttft = 85 + Math.random() * 10;
      baseMetrics.price = 95 + Math.random() * 4; // ~$0-5/1M, passes $5 guardrail
    }
    if (id.includes("claude-opus")) {
      baseMetrics.intelligence = 88 + Math.random() * 8;
      baseMetrics.coding = 85 + Math.random() * 10;
      baseMetrics.price = 40 + Math.random() * 30; // premium
    }
    if (id.includes("claude-sonnet")) {
      baseMetrics.intelligence = 80 + Math.random() * 10;
      baseMetrics.coding = 78 + Math.random() * 10;
      baseMetrics.price = 60 + Math.random() * 20; // mid-tier
    }
    if (id.includes("glm") || id.includes("kimi") || id.includes("minimax")) {
      baseMetrics.price = 92 + Math.random() * 6; // budget, mostly passes $5 guardrail
    }

    return {
      id: candidate.id,
      providerModel: candidate.providerModel,
      displayName: candidate.displayName,
      metrics: baseMetrics,
      metricSources: {},
      facts: {},
      supplements: {},
      notes: ["using synthetic data (run 'fetch' to get real data)"],
    };
  });
}

/**
 * main cli entrypoint.
 *
 * returns exit code: 0 for success, non-zero for errors.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const command = parseArgs(argv);

  // parse global options
  const formatIdx = argv.indexOf("--format");
  const format: OutputFormat =
    formatIdx !== -1 ? (argv[formatIdx + 1] as OutputFormat) : "md";

  const presetIdx = argv.indexOf("--preset");
  const preset: PresetName | undefined =
    presetIdx !== -1 ? (argv[presetIdx + 1] as PresetName) : undefined;

  const topIdx = argv.indexOf("--top");
  const top = topIdx !== -1 ? parseInt(argv[topIdx + 1] ?? "0", 10) : undefined;

  const tldr = argv.includes("--tldr");

  const cacheIdx = argv.indexOf("--cache");
  const cachePath = cacheIdx !== -1 ? argv[cacheIdx + 1] : undefined;

  switch (command.kind) {
    case "help":
      console.log(renderHelp());
      return 0;

    case "unknown":
      console.error(`unknown command: ${command.args.join(" ")}`);
      console.error("run 'model-evals help' for usage");
      return 1;

    case "fetch": {
      const path = cachePath ?? getDefaultCachePath();
      console.log(`fetching aa data to ${path}...`);

      try {
        const snapshot = await getAaSnapshot({
          cachePath: path,
          refresh: command.refresh,
        });

        if (snapshot) {
          const models = normalizeAaSnapshot({
            snapshot,
            candidates: candidateModels,
          });
          const found = models.filter(
            (m) => !m.notes.includes("not found in aa data"),
          );
          console.log(
            `cached ${found.length}/${models.length} candidate models`,
          );
        } else {
          console.error(
            "no api key provided. set artificial_analysis_api_key env var.",
          );
          return 1;
        }
      } catch (err) {
        console.error(`fetch failed: ${(err as Error).message}`);
        return 1;
      }

      return 0;
    }

    case "scrape-site": {
      const siteCacheDir = cachePath ?? getDefaultSiteCacheDir();
      console.log(`scraping aa benchmark pages into ${siteCacheDir}...`);
      try {
        const manifest = await scrapeAaSiteToCache({
          cacheDir: siteCacheDir,
          refresh: command.refresh,
          pages: DEFAULT_EVALUATION_PAGES,
          candidates: candidateModels,
        });
        console.log(`cached ${manifest.pages.length} pages`);
        console.log(`all models: ${manifest.allModelsPath}`);
        if (manifest.candidateModelsPath) {
          console.log(`candidate models: ${manifest.candidateModelsPath}`);
        }
      } catch (err) {
        console.error(`site scrape failed: ${(err as Error).message}`);
        return 1;
      }
      return 0;
    }

    case "coverage": {
      const models = await getEvaluatedModels(cachePath);
      const dims = getAllDimensions();
      console.log(renderCoverageSummary(models, [...dims]));
      return 0;
    }

    case "inspect": {
      const models = await getEvaluatedModels(cachePath);
      const model = models.find((m) => m.id === command.modelId);
      if (!model) {
        console.error(`model not found: ${command.modelId}`);
        return 1;
      }

      let output: string;
      if (format === "json") {
        output = JSON.stringify(model, null, 2);
      } else {
        // LOD 30: use new inspect renderer
        output = renderInspectModel(model, roles, models);
      }

      console.log(output);
      return 0;
    }

    case "rank": {
      if (command.target === "role" && !command.selector) {
        console.log(renderRoleCatalog(format));
        return 0;
      }

      if (command.target === "agent" && !command.selector) {
        console.log(renderAgentCatalog(format));
        return 0;
      }

      let role: RoleId;
      let currentModel: ModelId | undefined;
      let targetProfile: RoleProfile | AgentProfile;

      if (command.target === "role") {
        role = command.selector as RoleId;
        if (!roles[role]) {
          console.error(`unknown role: ${role}`);
          console.error(`available roles: ${Object.keys(roles).join(", ")}`);
          return 1;
        }
        targetProfile = roles[role];
      } else {
        try {
          const agentId = resolveAgentSelector(command.selector ?? "");
          const agent = agents[agentId];
          role = agent.role;
          targetProfile = agent;

          // resolve current model
          if (agent.currentModel === "inherits-default") {
            currentModel = agents.default.currentModel;
          } else {
            currentModel = agent.currentModel;
          }
        } catch (err) {
          console.error((err as Error).message);
          return 1;
        }
      }

      const roleProfile = roles[role];
      const models = await getEvaluatedModels(cachePath);
      const evaluation = evaluateRole(
        roleProfile,
        models,
        preset,
        currentModel,
      );

      let output: string;
      if (format === "json") {
        output = renderJson(targetProfile, evaluation, preset);
      } else if (tldr) {
        // LOD 29: dense --tldr matrix
        output = renderTldrMatrix(
          targetProfile,
          evaluation,
          currentModel,
          models,
        );
      } else if (format === "table") {
        output = renderTable(evaluation, top);
      } else {
        // LOD 24-25: decision-first markdown
        output = renderMarkdown(
          targetProfile,
          evaluation,
          preset,
          currentModel,
          models,
        );
      }

      console.log(output);
      return 0;
    }

    case "report": {
      const models = await getEvaluatedModels(cachePath);
      const evaluations = new Map<string, ReturnType<typeof evaluateRole>>();

      for (const [roleId, roleProfile] of Object.entries(roles)) {
        evaluations.set(roleId, evaluateRole(roleProfile, models, preset));
      }

      // LOD 25: portfolio matrix instead of concatenated reports
      const output = renderPortfolioMatrix(roles, evaluations, agents, models);
      console.log(output);
      return 0;
    }
  }
}

if (import.meta.vitest) {
  const { afterEach, beforeEach, describe, expect, test, vi } = import.meta
    .vitest;

  // suppress console output in tests
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("parseArgs", () => {
    test("parses help", () => {
      const cmd = parseArgs([]);
      expect(cmd.kind).toBe("help");
    });

    test("parses fetch", () => {
      const cmd = parseArgs(["fetch"]);
      expect(cmd.kind).toBe("fetch");
    });

    test("parses fetch --refresh", () => {
      const cmd = parseArgs(["fetch", "--refresh"]);
      expect(cmd.kind).toBe("fetch");
      expect((cmd as { refresh?: boolean }).refresh).toBe(true);
    });

    test("parses scrape-site", () => {
      const cmd = parseArgs(["scrape-site"]);
      expect(cmd.kind).toBe("scrape-site");
    });

    test("parses rank --role", () => {
      const cmd = parseArgs(["rank", "--role", "dayToDay"]);
      expect(cmd.kind).toBe("rank");
      if (cmd.kind === "rank") {
        expect(cmd.target).toBe("role");
        expect(cmd.selector).toBe("dayToDay");
      }
    });

    test("parses rank --role without selector", () => {
      const cmd = parseArgs(["rank", "--role"]);
      expect(cmd.kind).toBe("rank");
      if (cmd.kind === "rank") {
        expect(cmd.target).toBe("role");
        expect(cmd.selector).toBeUndefined();
      }
    });

    test("parses rank --agent", () => {
      const cmd = parseArgs(["rank", "--agent", "oracle"]);
      expect(cmd.kind).toBe("rank");
      if (cmd.kind === "rank") {
        expect(cmd.target).toBe("agent");
        expect(cmd.selector).toBe("oracle");
      }
    });

    test("parses rank --agent without selector", () => {
      const cmd = parseArgs(["rank", "--agent"]);
      expect(cmd.kind).toBe("rank");
      if (cmd.kind === "rank") {
        expect(cmd.target).toBe("agent");
        expect(cmd.selector).toBeUndefined();
      }
    });

    test("parses inspect --model", () => {
      const cmd = parseArgs(["inspect", "--model", "gpt-5-4"]);
      expect(cmd.kind).toBe("inspect");
    });

    test("parses coverage", () => {
      const cmd = parseArgs(["coverage"]);
      expect(cmd.kind).toBe("coverage");
    });
  });

  describe("main", () => {
    test("returns 0 for help", async () => {
      const code = await main(["help"]);
      expect(code).toBe(0);
    });

    test("returns 1 for unknown command", async () => {
      const code = await main(["bogus"]);
      expect(code).toBe(1);
    });

    test("returns 0 for rank --role dayToDay", async () => {
      const code = await main(["rank", "--role", "dayToDay"]);
      expect(code).toBe(0);
    });

    test("returns 0 for rank --role without selector", async () => {
      const code = await main(["rank", "--role"]);
      expect(code).toBe(0);
    });

    test("returns 0 for rank --agent oracle", async () => {
      const code = await main(["rank", "--agent", "oracle"]);
      expect(code).toBe(0);
    });

    test("returns 0 for rank --agent without selector", async () => {
      const code = await main(["rank", "--agent"]);
      expect(code).toBe(0);
    });

    test("returns 0 for coverage", async () => {
      const code = await main(["coverage"]);
      expect(code).toBe(0);
    });

    test("returns 0 for scrape-site", async () => {
      const code = await main(["scrape-site"]);
      expect(code).toBe(0);
    });
  });
}
