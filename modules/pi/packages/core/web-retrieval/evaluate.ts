/**
 * opt-in retrieval evaluation, not a synthetic answer-quality score.
 * no model calls: inspect saved evidence against the declared source/fact rubrics.
 * reserve published maximum request cost BEFORE dispatch, including failures.
 *
 * node packages/core/web-retrieval/evaluate.ts --live --budget=1 --repeats=3
 * requires existing PARALLEL_API_KEY credits; never funds or changes the account.
 */
import { createJiti } from "jiti";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  ModelRuntime,
  SessionManager,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type JsonValue } from "@earendil-works/pi-ai";
import type { WebSearchParams } from "../../extensions/web-search/index.ts";
import type { ReadWebPageParams } from "../../extensions/read-web-page/index.ts";

type Schema = {
  $ref?: string;
  anyOf?: Schema[];
  type?: string;
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  required?: string[];
  items?: Schema;
};
type ProviderSpec = {
  components: { schemas: Record<string, Schema> };
  paths: Record<
    string,
    {
      post: {
        requestBody: { content: { "application/json": { schema: Schema } } };
      };
    }
  >;
};
type RetrievalRequest = {
  advanced_settings?: { max_results?: number };
  max_results?: number;
  mode?: string;
  urls?: string[];
};
type RequestRecord = {
  path: string;
  request: RetrievalRequest;
  reservedCost: number;
  startedAt: string;
  status?: number;
  response?: unknown;
  milliseconds?: number;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const args = process.argv.slice(2);
const budget = Number(
  args.find((arg) => arg.startsWith("--budget="))?.split("=")[1] ?? 0,
);
const repeats = Number(
  args.find((arg) => arg.startsWith("--repeats="))?.split("=")[1] ?? 3,
);
if (
  !args.includes("--live") ||
  !(budget > 0 && budget <= 5) ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 3
)
  throw new Error(
    "explicit --live --budget=(0,5] --repeats=1..3 required; uses existing credits only",
  );
if (!process.env.PARALLEL_API_KEY) throw new Error("PARALLEL_API_KEY required");

const jiti = createJiti(import.meta.url);
const { createWebSearchTool } = await jiti.import<
  typeof import("../../extensions/web-search/index.ts")
>("../../extensions/web-search/index.ts");
const { createReadWebPageTool } = await jiti.import<
  typeof import("../../extensions/read-web-page/index.ts")
>("../../extensions/read-web-page/index.ts");
const fetchOriginal = globalThis.fetch;
const records: RequestRecord[] = [];
let reserved = 0;
const directory = await mkdtemp(join(tmpdir(), "pi-web-eval-"));
console.log(JSON.stringify({ directory, budget, repeats }));

// Reject undocumented outgoing fields before spending credits. The live spec is
// retained with the evidence so this check is auditable rather than a second schema.
const specResponse = await fetchOriginal(
  "https://docs.parallel.ai/docs-latest-openapi.json",
  { signal: AbortSignal.timeout(30000) },
);
if (!specResponse.ok) throw new Error("could not load provider contract");
const spec = (await specResponse.json()) as ProviderSpec;
await writeFile(
  join(directory, "provider-schema.json"),
  JSON.stringify(spec, null, 2),
  { mode: 0o600 },
);
function checkFields(value: unknown, schema: Schema): void {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1);
    const target = name ? spec.components.schemas[name] : undefined;
    assert.ok(target, `missing schema ${schema.$ref}`);
    return checkFields(value, target);
  }
  if (schema.anyOf) {
    const options = schema.anyOf.filter(
      (s) =>
        s.$ref ||
        s.type ===
          (Array.isArray(value)
            ? "array"
            : value === null
              ? "null"
              : typeof value),
    );
    if (options.length === 1 && options[0]) checkFields(value, options[0]);
    return;
  }
  if (schema.properties && isRecord(value)) {
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        assert.ok(key in schema.properties, `undocumented field ${key}`);
    for (const key of schema.required ?? [])
      assert.ok(key in value, `missing required field ${key}`);
    for (const [key, item] of Object.entries(value))
      if (schema.properties[key]) checkFields(item, schema.properties[key]);
  }
  if (schema.items && Array.isArray(value))
    for (const item of value) checkFields(item, schema.items);
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://api.parallel.ai")
    return fetchOriginal(input, init);
  assert.equal(init?.method, "POST");
  assert.ok(
    ["/v1/search", "/v1beta/search", "/v1/extract"].includes(url.pathname),
    "retrieval endpoints only",
  );
  assert.ok(init);
  assert.equal(typeof init.body, "string");
  const body = JSON.parse(String(init.body)) as RetrievalRequest;
  const search = url.pathname.endsWith("/search");
  if (url.pathname.startsWith("/v1/")) {
    const schema =
      spec.paths[url.pathname]?.post.requestBody.content["application/json"]
        .schema;
    assert.ok(schema, `missing request schema ${url.pathname}`);
    checkFields(body, schema);
  }
  const resultCount =
    body.advanced_settings?.max_results ?? body.max_results ?? 10;
  if (!search)
    assert.ok(body.urls, "extract URLs required for cost reservation");
  const cost = search
    ? (body.mode === "fast" || body.mode === "turbo" ? 0.001 : 0.005) +
      Math.max(0, resultCount - 10) * 0.001
    : body.urls!.length * 0.001;
  if (reserved + cost > budget + 1e-9)
    throw new Error("evaluation budget exhausted BEFORE dispatch");
  reserved += cost;
  const record: RequestRecord = {
    path: url.pathname,
    request: body,
    reservedCost: cost,
    startedAt: new Date().toISOString(),
  };
  records.push(record);
  await writeFile(
    join(directory, "requests.json"),
    JSON.stringify(records, null, 2),
    { mode: 0o600 },
  );
  const started = performance.now();
  try {
    const response = await fetchOriginal(input, init);
    record.status = response.status;
    record.response = await response
      .clone()
      .json()
      .catch(() => null);
    return response;
  } finally {
    record.milliseconds = Math.round(performance.now() - started);
    await writeFile(
      join(directory, "requests.json"),
      JSON.stringify(records, null, 2),
      { mode: 0o600 },
    );
  }
};

const tasks = [
  {
    id: "react-effects",
    objective:
      "Find React's rules for effect cleanup and its extra development Strict Mode cycle; prefer official documentation.",
    search_queries: [
      "React useEffect cleanup Strict Mode cycle",
      "React effect dependencies cleanup unmount",
    ],
    source: "react.dev",
    facts: ["cleanup", "strict"],
  },
  {
    id: "node-abort",
    objective:
      "Find the Node.js AbortSignal.any API and its behavior when an input signal is already aborted; prefer official docs.",
    search_queries: [
      "Node AbortSignal.any already aborted",
      "Node AbortSignal any reason",
    ],
    source: "nodejs.org",
    facts: ["AbortSignal.any", "aborted"],
  },
  {
    id: "nix-no-lock-write",
    objective:
      "Find Nix CLI --no-write-lock-file behavior and distinguish it from --no-update-lock-file; prefer official documentation.",
    search_queries: [
      "Nix no-write-lock-file no-update-lock-file",
      "Nix flake lock file flags",
    ],
    source: "nix.dev",
    facts: ["no-write-lock-file", "no-update-lock-file"],
  },
  {
    id: "pix-portuguese",
    objective:
      "Como funciona o Pix Automático e quem autoriza pagamentos recorrentes? Prefira fontes oficiais do Banco Central do Brasil.",
    search_queries: [
      "Pix Automático autorização pagamentos recorrentes",
      "Banco Central Pix Automático pagador",
    ],
    source: "bcb.gov.br",
    facts: ["autom", "autoriz"],
  },
  {
    id: "parallel-current-search",
    objective:
      "Find current Parallel Search API modes, result limits and required search_queries. Prefer current official documentation over older launch posts.",
    search_queries: [
      "Parallel Search modes advanced fast turbo",
      "Parallel v1 search max_results 20",
    ],
    source: "docs.parallel.ai",
    facts: ["advanced", "20"],
  },
  {
    id: "pdf-attention",
    objective:
      "Find the original Attention Is All You Need paper and its definition of scaled dot-product attention, including division by square root of key dimension.",
    search_queries: [
      "Attention Is All You Need scaled dot product sqrt dk",
      "1706.03762 attention paper",
    ],
    source: "arxiv.org",
    facts: ["attention", "sqrt"],
  },
];
const outcomes: unknown[] = [];
const models = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  refreshOnCreate: false,
  modelsPath: null,
});
function context(modelId?: "gpt-5.4"): ExtensionToolContext {
  // Real in-memory entries preserve paging identity without disk/session startup.
  const unsupported = (): never => {
    throw new Error("unsupported evaluation context operation");
  };
  return {
    model: modelId ? models.getModel("openai-codex", modelId) : undefined,
    sessionManager: SessionManager.inMemory(),
    get ui() {
      return unsupported();
    },
    get modelRegistry() {
      return unsupported();
    },
    mode: "json",
    hasUI: false,
    cwd: process.cwd(),
    scopedModels: [],
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => false,
    abort: unsupported,
    hasPendingMessages: () => false,
    shutdown: unsupported,
    getContextUsage: () => undefined,
    compact: unsupported,
    getSystemPrompt: () => "",
    tools: [],
    executeTool: unsupported,
  };
}
async function execute(
  tool:
    | ReturnType<typeof createWebSearchTool>
    | ReturnType<typeof createReadWebPageTool>,
  params: WebSearchParams & ReadWebPageParams,
  ctx: ExtensionToolContext,
): Promise<{ text: string; failed: boolean }> {
  let result = await tool.execute(
    randomUUID(),
    params,
    undefined,
    undefined,
    ctx,
  );
  // The read-only tool context exposes this manager; retain the initial result
  // exactly as the SDK would so continuations can find their snapshot.
  assert.ok(ctx.sessionManager instanceof SessionManager);
  ctx.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: randomUUID(),
    toolName: tool.name,
    content: result.content,
    details: JSON.parse(JSON.stringify(result.details)) as JsonValue,
    isError: false,
    timestamp: Date.now(),
  });
  let text = "";
  const failed =
    isRecord(result.details) && result.details.retrievalFailed === true;
  for (;;) {
    const page =
      isRecord(result.details) && isRecord(result.details.webPage)
        ? result.details.webPage
        : undefined;
    const first = result.content[0];
    assert.ok(first?.type === "text", "retrieval must return text");
    if (page) {
      assert.equal(typeof page.end, "number");
      assert.equal(typeof page.start, "number");
      assert.ok(typeof page.end === "number" && typeof page.start === "number");
      text += first.text.slice(0, page.end - page.start);
    } else text += first.text;
    if (!page?.nextCursor) return { text, failed };
    assert.equal(typeof page.nextCursor, "string");
    assert.ok(typeof page.nextCursor === "string");
    result = await tool.execute(
      randomUUID(),
      { cursor: page.nextCursor },
      undefined,
      undefined,
      ctx,
    );
  }
}
try {
  for (
    let repeat = 0;
    repeat < (args.includes("--controls-only") ? 0 : repeats);
    repeat++
  )
    for (const task of tasks) {
      for (const variant of [
        "legacy-2k",
        "advanced",
        "basic",
        "fast",
      ] as const) {
        const start = performance.now();
        let evidence = "";
        let error;
        try {
          const { objective, search_queries } = task;
          if (variant === "legacy-2k") {
            const response = await globalThis.fetch(
              "https://api.parallel.ai/v1beta/search",
              {
                method: "POST",
                headers: {
                  "x-api-key": process.env.PARALLEL_API_KEY,
                  "content-type": "application/json",
                  "parallel-beta": "search-extract-2025-10-10",
                },
                body: JSON.stringify({
                  objective,
                  search_queries,
                  max_results: 10,
                  excerpts: { max_chars_per_result: 2000 },
                }),
                signal: AbortSignal.timeout(120000),
              },
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = (await response.json()) as {
              results?: Array<{
                title: string;
                url: string;
                excerpts: string[];
              }>;
            };
            if (!Array.isArray(data.results))
              throw new Error("missing legacy results");
            evidence = data.results
              .map((r) => `${r.title}\n${r.url}\n${r.excerpts.join("\n")}`)
              .join("\n\n");
          } else {
            const tool = createWebSearchTool({
              defaultMaxResults: 10,
              endpoint: "https://api.parallel.ai/v1/search",
              requestTimeoutSecs: 120,
              defaultMode: variant,
              maxRetries: 0,
            });
            evidence = (
              await execute(tool, { objective, search_queries }, context())
            ).text;
          }
        } catch (e) {
          error = String(e);
        }
        const outcome = {
          task: task.id,
          variant,
          repeat,
          milliseconds: Math.round(performance.now() - start),
          characters: evidence.length,
          sourcePresent: evidence.includes(task.source),
          factTerms: task.facts.map((fact) => ({
            fact,
            present: evidence.toLowerCase().includes(fact.toLowerCase()),
          })),
          error,
          evidence,
        };
        outcomes.push(outcome);
        const { evidence: _, ...summary } = outcome;
        console.log(JSON.stringify(summary));
        await writeFile(
          join(directory, "outcomes.json"),
          JSON.stringify(outcomes, null, 2),
          { mode: 0o600 },
        );
        if (error && /budget|HTTP 402|HTTP 401|HTTP 403/.test(error))
          throw new Error(error);
      }
    }
  const reader = createReadWebPageTool({ maxRetries: 0 });
  for (const params of [
    {
      url: "https://react.dev/reference/react/useEffect",
      objective: "cleanup behavior and dependencies",
      output: ["document", "excerpts"],
    },
    {
      url: "https://arxiv.org/pdf/1706.03762",
      objective: "scaled dot-product attention definition and sqrt dk",
      output: ["excerpts"],
    },
    {
      urls: [
        "https://docs.parallel.ai/search/modes",
        "https://docs.parallel.ai/search/advanced-search-settings",
      ],
      objective: "current modes and max results",
      output: ["excerpts"],
    },
    {
      url: "https://docs.parallel.ai/search/modes.md",
      output: ["raw", "document"],
    },
    {
      url: "https://docs.parallel.ai/search/modes.md",
      output: ["document"],
      forceRefetch: true,
    },
    {
      url: "https://docs.parallel.ai/search/advanced-search-settings",
      objective: "maximum public result count",
      output: ["document", "excerpts"],
      max_chars_total: 12000,
      max_chars_per_result: 10000,
      fetch_policy: { max_age_seconds: 600, timeout_seconds: 30 },
    },
  ] satisfies ReadWebPageParams[]) {
    const start = performance.now();
    try {
      const result = await execute(reader, params, context());
      outcomes.push({
        task: "extract",
        params,
        ...result,
        milliseconds: Math.round(performance.now() - start),
      });
      console.log(
        JSON.stringify({
          task: "extract",
          params,
          failed: result.failed,
          characters: result.text.length,
        }),
      );
    } catch (e) {
      outcomes.push({ task: "extract", params, error: String(e) });
      console.log(JSON.stringify({ task: "extract", error: String(e) }));
    }
  }
  for (const params of [
    {
      search_queries: [
        "Parallel Search query limits",
        "Parallel Search modes",
        "Parallel Search source policy",
        "Parallel Search result count",
        "Parallel Search excerpt budget",
      ],
      objective: "Find current search controls in official Parallel docs",
      mode: "advanced",
      max_results: 20,
      max_chars_total: 75000,
      max_chars_per_result: 20000,
      source_policy: { include_domains: ["docs.parallel.ai/search"] },
    },
    {
      search_queries: ["Pix Automático autorização Banco Central"],
      mode: "turbo",
      location: "br",
      source_policy: {
        exclude_domains: ["reddit.com"],
        after_date: "2026-01-01",
      },
    },
  ] satisfies WebSearchParams[]) {
    const tool = createWebSearchTool({
      defaultMaxResults: 10,
      endpoint: "https://api.parallel.ai/v1/search",
      requestTimeoutSecs: 120,
      defaultMode: "advanced",
      maxRetries: 0,
    });
    try {
      const result = await execute(tool, params, context("gpt-5.4"));
      outcomes.push({ task: "controls", params, ...result });
      console.log(
        JSON.stringify({
          task: "controls",
          params,
          failed: result.failed,
          characters: result.text.length,
        }),
      );
    } catch (e) {
      outcomes.push({ task: "controls", params, error: String(e) });
      console.log(JSON.stringify({ task: "controls", error: String(e) }));
    }
  }
} finally {
  globalThis.fetch = fetchOriginal;
  await writeFile(
    join(directory, "outcomes.json"),
    JSON.stringify(outcomes, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      directory,
      reservedMaximumUSD: Number(reserved.toFixed(6)),
      requests: records.length,
      note: "reserved published cost, not an account balance audit. keyword matches are screening signals, not answer correctness.",
    }),
  );
}
