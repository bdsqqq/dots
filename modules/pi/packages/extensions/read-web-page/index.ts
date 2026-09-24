/**
 * Evidence only: output implementations own selection, acquisition and rendering.
 * Direct HTTP and Extract are distinct snapshots, never interchangeable fallbacks.
 */
import { isIP } from "node:net";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  Type,
  type Static,
  type TObject,
  type TOptional,
  type TString,
  type TArray,
  type TUnsafe,
  type TInteger,
  type TBoolean,
} from "typebox";
import { Assert } from "typebox/value";
import { htmlToMarkdown } from "@bds_pi/html-to-md";
import { getEnabledExtensionConfig } from "@bds_pi/config";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { framedTextRenderer, renderLifecycleCall } from "@bds_pi/box-format";
import {
  parallelRequest,
  retrievalIdentity,
  formatWarnings,
  usageCost,
  publishResult,
  continueResult,
  fetchPolicySchema,
  resolveFetchPolicy,
} from "@bds_pi/web-retrieval";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
type Direct = {
  text: string;
  content_type: string;
  status: number;
  final_url: string;
  acquired_at: string;
};
type Evidence = { direct?: Direct; extracted?: RecordValue };
type OutputImplementation = {
  description: string;
  focused?: boolean;
  defaultFor?: "focused" | "unfocused";
  acquisition: (force: boolean) => "direct" | "extract";
  extractOptions?: RecordValue;
  render: (evidence: Evidence) => Promise<string>;
};
const outputRegistry = {
  raw: {
    description: "unconverted direct HTTP response text (not necessarily HTML)",
    acquisition: (): "direct" => "direct",
    render: async ({ direct }: Evidence): Promise<string> => {
      if (!direct) throw new Error("missing direct response");
      return direct.text;
    },
  },
  document: {
    description:
      "unfiltered extracted document (not certified original-page completeness); forceRefetch makes a new direct request",
    defaultFor: "unfocused",
    acquisition: (force: boolean): "direct" | "extract" =>
      force ? "direct" : "extract",
    extractOptions: { full_content: true },
    render: async ({ direct, extracted }: Evidence): Promise<string> => {
      if (direct) {
        if (/html/i.test(direct.content_type)) {
          const markdown = await htmlToMarkdown(direct.text);
          if (!markdown)
            throw new Error(
              "HTML document conversion failed; request raw explicitly to inspect source",
            );
          return markdown;
        }
        if (!/^text\/(plain|markdown)(?:;|$)/i.test(direct.content_type))
          throw new Error("document requires HTML, plain text or markdown");
        return direct.text;
      }
      if (typeof extracted?.full_content !== "string")
        throw new Error(
          "missing full_content; excerpts cannot substitute for a document",
        );
      return extracted.full_content;
    },
  },
  excerpts: {
    description: "Extract excerpts relevant to objective or search_queries",
    focused: true,
    defaultFor: "focused",
    acquisition: (): "extract" => "extract",
    render: async ({ extracted }: Evidence): Promise<string> => {
      if (
        !Array.isArray(extracted?.excerpts) ||
        !extracted.excerpts.length ||
        !extracted.excerpts.every((x) => typeof x === "string")
      )
        throw new Error("missing or malformed excerpts");
      return extracted.excerpts.join("\n\n");
    },
  },
} as const;
type OutputName = keyof typeof outputRegistry;
const outputs: Record<OutputName, OutputImplementation> = outputRegistry;
const outputNames = Object.keys(outputRegistry) as OutputName[];
const outputEnum = Type.Unsafe<OutputName>({
  type: "string",
  enum: outputNames,
});
const readWebPageSchema: TObject<{
  url: TOptional<TString>;
  urls: TOptional<TArray<TString>>;
  objective: TOptional<TString>;
  search_queries: TOptional<TArray<TString>>;
  output: TOptional<TArray<TUnsafe<OutputName>>>;
  max_chars_total: TOptional<TInteger>;
  max_chars_per_result: TOptional<TInteger>;
  max_document_chars_per_result: TOptional<TInteger>;
  fetch_policy: TOptional<typeof fetchPolicySchema>;
  session_id: TOptional<TString>;
  cursor: TOptional<TString>;
  start_index: TOptional<TInteger>;
  max_length: TOptional<TInteger>;
  raw: TOptional<TBoolean>;
  forceRefetch: TOptional<TBoolean>;
  prompt: TOptional<TString>;
}> = Type.Object(
  {
    url: Type.Optional(
      Type.String({
        description: "One public URL. Mutually exclusive with urls and cursor.",
      }),
    ),
    urls: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 20,
        description:
          "Batch of up to 20 public URLs; per-URL failures preserve successful outputs.",
      }),
    ),
    objective: Type.Optional(
      Type.String({
        maxLength: 5000,
        description:
          "What evidence to extract. Defaults output to excerpts; an explicit output array takes precedence.",
      }),
    ),
    search_queries: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        maxItems: 5,
        description:
          "Optional terms focusing excerpts; up to five queries, no hidden three-query restriction.",
      }),
    ),
    output: Type.Optional(
      Type.Array(outputEnum, {
        minItems: 1,
        uniqueItems: true,
        description: outputNames
          .map((name) => `${name}: ${outputs[name].description}`)
          .join("; "),
      }),
    ),
    max_chars_total: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Total excerpt-character budget; never limits document output. Omit for adaptive sizing.",
      }),
    ),
    max_chars_per_result: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Excerpt budget per URL; not a document size limit.",
      }),
    ),
    max_document_chars_per_result: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Explicit upstream document prefix limit per URL. Omit for full-content extraction; cannot be recovered by a local cursor.",
      }),
    ),
    fetch_policy: Type.Optional(fetchPolicySchema),
    session_id: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    cursor: Type.Optional(
      Type.String({
        description:
          "Read an existing snapshot in this session branch, without fetching again. Exclusive with retrieval inputs; max_length allowed. 24h lifetime.",
      }),
    ),
    start_index: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Legacy character offset into a newly acquired formatted result. Prefer cursor to continue the same snapshot.",
      }),
    ),
    max_length: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Visible page length, not an upstream extraction budget. Remainder is retained and accessible by cursor.",
      }),
    ),
    raw: Type.Optional(
      Type.Boolean({
        description:
          "deprecated alias for output: [raw], only when output is omitted",
      }),
    ),
    forceRefetch: Type.Optional(
      Type.Boolean({
        description:
          "new direct HTTP request; does not bypass origin/CDN caches; unsupported for excerpts",
      }),
    ),
    prompt: Type.Optional(
      Type.String({
        description:
          "removed: reader returns evidence; ask calling agent to reason",
      }),
    ),
  },
  { additionalProperties: false },
);
export type ReadWebPageParams = Static<typeof readWebPageSchema>;
export type ReadWebPageConfig = {
  fetch?: typeof globalThis.fetch;
  timeoutSeconds?: number;
  maxRetries?: number;
};

/** Literal-address checks enforce the external-only contract, not a DNS-rebinding firewall. */
export function publicUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    (!host.includes(".") && !isIP(host)) ||
    /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)
  )
    throw new Error(
      "URL must be public HTTP(S), without credentials; no localhost/local access",
    );
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224 ||
      (a === 198 && (b === 18 || b === 19))
    )
      throw new Error("private/reserved literal URL is not allowed");
  }
  if (isIP(host) === 6 && !/^2[0-9a-f]{3}:/.test(host))
    throw new Error("non-public IPv6 literal URL is not allowed");
  return url.href;
}
function validate(input: ReadWebPageParams): {
  params: ReadWebPageParams;
  names: OutputName[];
  urls: string[];
} {
  for (const key of Object.keys(input))
    if (!Object.hasOwn(readWebPageSchema.properties, key))
      throw new Error(`unknown parameter: ${key}`);
  const p = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value != null),
  );
  Assert(readWebPageSchema, p);
  if (p.prompt !== undefined)
    throw new Error(
      "prompt was removed: reader returns evidence; ask calling agent to reason",
    );
  if (p.cursor !== undefined) {
    if (
      !p.cursor ||
      Object.keys(p).some((key) => key !== "cursor" && key !== "max_length")
    )
      throw new Error(
        "cursor is exclusive with acquisition controls; only max_length is allowed",
      );
    return { params: p, names: [], urls: [] };
  }
  if ((p.url !== undefined) === (p.urls !== undefined))
    throw new Error("provide exactly one of url or urls");
  const urls = p.urls ?? [p.url!];
  urls.forEach(publicUrl);
  if (p.search_queries?.some((query) => !query.trim()))
    throw new Error("search_queries must contain nonempty terms");
  const focus =
    !!p.objective?.trim() || !!p.search_queries?.some((q) => q.trim());
  const names: OutputName[] =
    p.output ??
    (p.raw
      ? ["raw"]
      : outputNames.filter(
          (name) =>
            outputs[name].defaultFor === (focus ? "focused" : "unfocused"),
        ));
  if (p.raw && p.output !== undefined)
    throw new Error("raw alias cannot be combined with output");
  if (names.some((name) => outputs[name].focused) && !focus)
    throw new Error("focused output requires objective or search_queries");
  if (
    p.forceRefetch &&
    names.some((name) => outputs[name].acquisition(true) !== "direct")
  )
    throw new Error(
      "forceRefetch is unsupported for excerpts; no freshness fallback is performed",
    );
  const extracts = names.some(
    (name) => outputs[name].acquisition(!!p.forceRefetch) === "extract",
  );
  if (
    p.max_document_chars_per_result !== undefined &&
    !names.some((name) => outputs[name].extractOptions?.full_content)
  )
    throw new Error("max_document_chars_per_result requires document output");
  if (
    !extracts &&
    [
      p.objective,
      p.search_queries,
      p.fetch_policy,
      p.max_chars_total,
      p.max_chars_per_result,
      p.max_document_chars_per_result,
      p.session_id,
    ].some((x) => x !== undefined)
  )
    throw new Error("extraction-specific controls require an Extract output");
  return { params: p, names, urls };
}
async function directRequest(
  url: string,
  config: ReadWebPageConfig,
  signal?: AbortSignal,
): Promise<Direct> {
  const timeout = AbortSignal.timeout(
    Math.ceil((config.timeoutSeconds ?? 120) * 1000),
  );
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = publicUrl(url);
  for (let i = 0; i <= 5; i++) {
    combined.throwIfAborted();
    const response = await (config.fetch ?? globalThis.fetch)(current, {
      signal: combined,
      redirect: "manual",
      headers: { Accept: "text/html,*/*" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("redirect missing Location");
      current = publicUrl(new URL(location, current).href);
      continue;
    }
    if (response.url) publicUrl(response.url);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`direct HTTP ${response.status} for ${current}`);
    }
    const content_type =
      response.headers.get("content-type") ?? "application/octet-stream";
    if (
      !/^(text\/|application\/(json|xml|xhtml\+xml)(?:;|$))/i.test(content_type)
    ) {
      await response.body?.cancel();
      throw new Error(
        `raw text unavailable for binary/unsupported content type ${content_type}`,
      );
    }
    const charset =
      /charset\s*=\s*["']?([^;\s"']+)/i.exec(content_type)?.[1] ?? "utf-8";
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const abortRead = (): void => {
      void reader?.cancel().catch(() => {});
    };
    combined.addEventListener("abort", abortRead, { once: true });
    try {
      for (;;) {
        combined.throwIfAborted();
        const chunk = await reader?.read();
        combined.throwIfAborted();
        if (!chunk || chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 200 * 1024 * 1024)
          throw new Error(
            "direct response exceeds 200 MiB safety limit; no partial output returned",
          );
        chunks.push(chunk.value);
      }
    } finally {
      combined.removeEventListener("abort", abortRead);
      void reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
    const text = new TextDecoder(charset, { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    combined.throwIfAborted();
    if (text.includes("\0") || text.startsWith("%PDF-"))
      throw new Error("binary content cannot be returned as raw text");
    return {
      text,
      content_type,
      status: response.status,
      final_url: response.url || current,
      acquired_at: new Date().toISOString(),
    };
  }
  throw new Error("too many direct redirects");
}

export function createReadWebPageTool(
  config: ReadWebPageConfig = {},
): ToolDefinition<typeof readWebPageSchema> {
  return {
    name: "read_web_page",
    label: "Read Web Page",
    description:
      "Read evidence from public web URLs, without answering or hosted research. Outputs: " +
      outputNames
        .map((name) => `${name}: ${outputs[name].description}`)
        .join("; ") +
      ". Defaults to document, or excerpts with objective/search_queries. Explicit output overrides defaults. " +
      "Combine outputs as an array, e.g. [document, excerpts]; no generated answers. No automatic backend fallback. " +
      "Oversized results are retained for 24h: use cursor on this tool to continue the same acquisition without fetching again. " +
      "Do NOT use for localhost or local URLs — use curl via Bash instead.",
    parameters: readWebPageSchema,
    async execute(_id, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      const { params: p, names, urls } = validate(input);
      if (p.cursor)
        return continueResult(p.cursor, ctx, "read_web_page", p.max_length);
      const directNames = names.filter(
        (name) => outputs[name].acquisition(!!p.forceRefetch) === "direct",
      );
      const extractNames = names.filter(
        (name) => outputs[name].acquisition(!!p.forceRefetch) === "extract",
      );
      const appliedPolicy = resolveFetchPolicy(p.fetch_policy);
      const direct = new Map<string, Direct>();
      const failures = new Map<string, string>();
      const directWork = Promise.all(
        (directNames.length ? urls : []).map(async (url) => {
          try {
            direct.set(url, await directRequest(url, config, signal));
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && error.name === "AbortError")
              throw error;
            failures.set(url, message(error));
          }
        }),
      );
      let response: RecordValue = {};
      let extractError: string | undefined;
      const extractWork = async (): Promise<void> => {
        if (!extractNames.length) return;
        try {
          // v1 always returns excerpts. Selection controls our output, not a nonexistent
          // upstream excerpts=false switch. Full content has a separate prefix budget.
          const advanced: RecordValue = Object.assign(
            {},
            ...extractNames.map((name) => outputs[name].extractOptions),
          );
          if (appliedPolicy) advanced.fetch_policy = appliedPolicy;
          if (p.max_chars_per_result !== undefined)
            advanced.excerpt_settings = {
              max_chars_per_result: p.max_chars_per_result,
            };
          if (p.max_document_chars_per_result !== undefined)
            advanced.full_content = {
              max_chars_per_result: p.max_document_chars_per_result,
            };
          const body: RecordValue = {
            urls,
            ...retrievalIdentity(ctx, p.session_id),
            ...(Object.keys(advanced).length
              ? { advanced_settings: advanced }
              : {}),
          };
          if (p.objective !== undefined) body.objective = p.objective;
          if (p.search_queries !== undefined)
            body.search_queries = p.search_queries;
          if (p.max_chars_total !== undefined)
            body.max_chars_total = p.max_chars_total;
          response = await parallelRequest("/v1/extract", body, {
            ...config,
            signal,
            timeoutSeconds: Math.max(
              config.timeoutSeconds ?? 120,
              (p.fetch_policy?.timeout_seconds ?? 0) + 30,
            ),
          });
          if (
            !Array.isArray(response.results) ||
            !Array.isArray(response.errors) ||
            !response.results.every(
              (r) => record(r) && typeof r.url === "string",
            ) ||
            !response.errors.every(
              (e) => record(e) && typeof e.url === "string",
            )
          )
            throw new Error(
              "malformed Extract response: expected results and errors arrays with URL-bearing results",
            );
          for (const result of response.results)
            if (record(result)) publicUrl(String(result.url));
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof Error && error.name === "AbortError")
            throw error;
          extractError = message(error);
        }
      };
      await Promise.all([directWork, extractWork()]);
      const results =
        !extractError && Array.isArray(response.results)
          ? response.results.filter(record)
          : [];
      const errors = Array.isArray(response.errors)
        ? response.errors.filter(record)
        : [];
      const sections: string[] = [];
      const snapshots: RecordValue[] = [];
      let succeeded = 0;
      for (const url of urls) {
        const result = results.find(
          (r) =>
            r.url === url ||
            r.requested_url === url ||
            (typeof r.url === "string" &&
              new URL(r.url).href === new URL(url).href),
        );
        const raw = direct.get(url);
        const metadata = result
          ? Object.fromEntries(
              Object.entries(result).filter(
                ([key]) => key !== "full_content" && key !== "excerpts",
              ),
            )
          : undefined;
        const directMetadata = raw
          ? {
              ...raw,
              text: undefined,
              backend: "direct",
              freshness: "new HTTP request; origin/CDN caches may apply",
            }
          : undefined;
        snapshots.push({ url, direct: directMetadata, extract: metadata });
        sections.push(`# ${url}`);
        if (directNames.length && extractNames.length)
          sections.push(
            "warning: direct and Extract are separate acquisitions/snapshots; source versions may differ.",
          );
        for (const name of names) {
          const backend = outputs[name].acquisition(!!p.forceRefetch);
          sections.push(`## ${name} [${backend}]`);
          try {
            if (backend === "direct" && failures.has(url))
              throw new Error(failures.get(url));
            if (backend === "extract" && extractError)
              throw new Error(extractError);
            if (backend === "extract" && !result)
              throw new Error(
                `no Extract result: ${JSON.stringify(errors.filter((e) => e.url === url))}`,
              );
            const text = await outputs[name].render(
              backend === "direct" ? { direct: raw } : { extracted: result },
            );
            sections.push(
              `provenance: ${JSON.stringify(backend === "direct" ? directMetadata : { backend: "parallel/extract", ...metadata, fetch_policy: appliedPolicy, max_document_chars_per_result: p.max_document_chars_per_result })}`,
              text,
            );
            succeeded++;
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && error.name === "AbortError")
              throw error;
            sections.push(`error: ${message(error)}`);
          }
        }
      }
      if (errors.length)
        sections.push(`Extract per-URL errors: ${JSON.stringify(errors)}`);
      const metadata = Object.fromEntries(
        Object.entries(response).filter(
          ([key]) => key !== "results" && key !== "errors",
        ),
      );
      if (Object.keys(metadata).length)
        sections.push(`Extract request metadata: ${JSON.stringify(metadata)}`);
      const warnings = formatWarnings(response.warnings);
      if (warnings) sections.push(warnings);
      const cost = usageCost(
        response.usage,
        extractNames.length ? (extractError ? NaN : 0.001 * urls.length) : 0,
      );
      if (cost.unknownSkus?.length)
        sections.push(
          `cost unknown: unrecognized usage SKUs ${cost.unknownSkus.join(", ")}`,
        );
      signal?.throwIfAborted();
      if (!succeeded)
        sections.unshift("read_web_page: all requested outputs failed");
      return publishResult(
        sections.join("\n\n"),
        ctx,
        {
          ...metadata,
          snapshots,
          errors,
          retrievalFailed: succeeded === 0,
          ...cost,
        },
        "read_web_page",
        { start: p.start_index, length: p.max_length },
      );
    },
    renderCall(args, theme, context) {
      return renderLifecycleCall(
        new Text(
          theme.fg(
            "toolTitle",
            `read_web_page ${args.url ?? args.urls?.join(", ") ?? "continuation"}`,
          ),
          0,
          0,
        ),
        theme,
        context,
      );
    },
    renderResult(result, { expanded }) {
      return framedTextRenderer(
        result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n"),
        expanded,
      );
    },
  };
}

/** Legacy model/prompt settings are deliberately unused: this tool never spawns an agent. */
export default function readWebPageExtension(pi: ExtensionAPI): void {
  const { enabled } = getEnabledExtensionConfig("@bds_pi/read-web-page", {});
  if (!enabled) return;
  pi.registerTool(withPromptPatch(createReadWebPageTool()));
  // throwing discards details, including continuation authority. the result hook marks
  // failure after paginating diagnostics, so large error bodies remain recoverable.
  pi.on("tool_result", (event) => {
    if (
      event.toolName === "read_web_page" &&
      record(event.details) &&
      event.details.retrievalFailed
    )
      return { isError: true };
  });
}

if (import.meta.vitest) {
  const { describe, it, expect, vi, afterEach } = import.meta.vitest;
  type Context = Parameters<
    ReturnType<typeof createReadWebPageTool>["execute"]
  >[4];
  const ctx = {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => "reader-test-session",
      getSessionFile: () => undefined,
      getLeafId: () => "reader-test-leaf",
      getBranch: () => [{ id: "reader-test-leaf" }],
    },
  } as unknown as Context;
  const url = "https://example.com/page";
  const extracted = {
    url,
    title: "test page",
    full_content: "FULL document",
    excerpts: ["FOCUSED passage"],
    publish_date: "2026-01-01",
  };
  const run = (params: ReadWebPageParams, signal?: AbortSignal) =>
    createReadWebPageTool({ maxRetries: 0 }).execute(
      "test",
      params,
      signal,
      undefined,
      ctx,
    );
  const text = (result: Awaited<ReturnType<typeof run>>) =>
    result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  const requestUrl = (input: Parameters<typeof globalThis.fetch>[0]) =>
    new URL(input instanceof Request ? input.url : input).href;
  function network(
    payload: unknown = {
      results: [extracted],
      errors: [],
      request_id: "extract-request",
      warnings: [],
    },
  ) {
    vi.stubEnv("PARALLEL_API_KEY", "test-key-not-billed");
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      return requestUrl(input).includes("/v1/extract")
        ? new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          })
        : new Response("DIRECT response", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
    });
  }
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  describe("read_web_page evidence outputs", () => {
    it("derives schema choices from the implementation registry", () => {
      expect(
        (
          readWebPageSchema.properties.output.items as unknown as {
            enum: string[];
          }
        ).enum,
      ).toEqual(Object.keys(outputRegistry));
    });
    for (let mask = 1; mask < 1 << outputNames.length; mask++) {
      const selected = outputNames.filter((_, i) => mask & (1 << i));
      it(`executes ${selected.join("+")} without redundant acquisitions`, async () => {
        const fetch = network();
        const result = text(
          await run({
            url,
            output: selected,
            ...(selected.includes("excerpts")
              ? { objective: "find passage" }
              : {}),
          }),
        );
        for (const name of outputNames)
          expect(result.includes(`## ${name} [`)).toBe(selected.includes(name));
        expect(
          fetch.mock.calls.filter(([u]) =>
            requestUrl(u).includes("/v1/extract"),
          ),
        ).toHaveLength(selected.some((n) => n !== "raw") ? 1 : 0);
        expect(
          fetch.mock.calls.filter(
            ([u]) => !requestUrl(u).includes("/v1/extract"),
          ),
        ).toHaveLength(selected.includes("raw") ? 1 : 0);
        if (selected.includes("raw") && selected.length > 1)
          expect(result).toContain("source versions may differ");
      });
    }
    it("defaults by focus, but an explicit document never includes unrequested excerpts", async () => {
      network();
      expect(text(await run({ url }))).toContain("FULL document");
      expect(text(await run({ url, objective: "focus" }))).toContain(
        "FOCUSED passage",
      );
      const document = text(
        await run({ url, objective: "focus", output: ["document"] }),
      );
      expect(document).toContain("FULL document");
      expect(document).not.toContain("FOCUSED passage");
    });
    const invalid: RecordValue[] = [
      { url, urls: [url] },
      { url, output: [] },
      { url, output: ["document", "document"] },
      { url, output: ["both"] },
      { url, output: ["toString"] },
      { url, output: ["excerpts"] },
      { url, objective: "focus", forceRefetch: true },
      { url, raw: true, objective: "focus" },
      { url, raw: true, fetch_policy: {} },
      { url, raw: true, output: ["raw"] },
      { url, max_length: 1.5 },
      { url, start_index: -1 },
      { url, start_index: Number.MAX_SAFE_INTEGER + 1 },
      { url, prompt: "answer for me" },
      { url, cursor: "cursor" },
      { cursor: "cursor", output: ["raw"] },
      { url, fetch_policy: { max_age_seconds: 599 } },
      { url, fetch_policy: { timeout_seconds: 0 } },
      { url, fetch_policy: { timeout_seconds: 2_147_454 } },
      { url, search_queries: ["   "] },
      { url, output: "document" },
      { url, forceRefetch: "true" },
      { url, unknown: null },
      { url, objective: "x".repeat(5001) },
      { url, search_queries: ["x".repeat(201)] },
      { url, session_id: "x".repeat(1001) },
      { url: "http://127.0.0.1" },
      { url: "http://localhost" },
      { url: "http://[::ffff:127.0.0.1]" },
      { url: "file:///tmp/page" },
      { url: "https://user:password@example.com" },
      { url, unknown: true },
    ];
    for (const params of invalid)
      it(`rejects before network: ${JSON.stringify(params).slice(0, 100)}`, async () => {
        const fetch = network();
        await expect(run(params as ReadWebPageParams)).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
      });
    it("rejects prompt with migration guidance", async () => {
      await expect(run({ url, prompt: "why" })).rejects.toThrow(
        "reader returns evidence; ask calling agent to reason",
      );
    });
    it("forceRefetch performs a direct request, not an API request", async () => {
      const fetch = network();
      expect(text(await run({ url, forceRefetch: true }))).toContain(
        "DIRECT response",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[0]).toBe(url);
      expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
        Accept: "text/html,*/*",
      });
    });
    it("converts direct HTML and accepts negotiated markdown without substituting failed HTML", async () => {
      const fetch = vi.spyOn(globalThis, "fetch");
      fetch.mockResolvedValueOnce(
        new Response(
          "<!doctype html><html><body><h1>Title</h1><p>Evidence paragraph.</p></body></html>",
          { headers: { "content-type": "text/html" } },
        ),
      );
      const html = text(await run({ url, forceRefetch: true }));
      expect(html).toContain("# Title");
      expect(html).not.toContain("<h1>");
      fetch.mockResolvedValueOnce(
        new Response("# negotiated markdown", {
          headers: { "content-type": "text/markdown" },
        }),
      );
      expect(text(await run({ url, forceRefetch: true }))).toContain(
        "# negotiated markdown",
      );
      fetch.mockResolvedValueOnce(
        new Response("not HTML despite its header", {
          headers: { "content-type": "text/html" },
        }),
      );
      expect(text(await run({ url, forceRefetch: true }))).toContain(
        "HTML document conversion failed",
      );
    });
    it("passes both full-content and excerpt budgets without a hidden 2k cap", async () => {
      const fetch = network();
      await run({
        url,
        output: ["document", "excerpts"],
        objective: "focus",
        max_chars_total: 100000,
        max_chars_per_result: 50000,
        max_document_chars_per_result: 150000,
        fetch_policy: { max_age_seconds: 600, disable_cache_fallback: true },
      });
      const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
      expect(body).toEqual({
        urls: [url],
        session_id: expect.any(String),
        objective: "focus",
        max_chars_total: 100000,
        advanced_settings: {
          full_content: { max_chars_per_result: 150000 },
          excerpt_settings: { max_chars_per_result: 50000 },
          fetch_policy: { max_age_seconds: 600, disable_cache_fallback: true },
        },
      });
    });
    it("leaves GA budgets adaptive and does not send beta excerpt switches", async () => {
      const fetch = network();
      await run({ url });
      expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
        urls: [url],
        session_id: expect.any(String),
        advanced_settings: { full_content: true },
      });
      await run({ url, objective: "focus" });
      expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual({
        urls: [url],
        session_id: expect.any(String),
        objective: "focus",
      });
    });
    it("rejects stale fallback by default when freshness is requested", async () => {
      const fetch = network();
      await run({ url, fetch_policy: { max_age_seconds: 600 } });
      expect(
        JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).advanced_settings
          .fetch_policy,
      ).toEqual({ max_age_seconds: 600, disable_cache_fallback: true });
    });
    it("starts independent direct reads and Extract before waiting on any one source", async () => {
      vi.stubEnv("PARALLEL_API_KEY", "test-key");
      const pending: Array<() => void> = [];
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) => {
          await new Promise<void>((resolve) => pending.push(resolve));
          return requestUrl(input).includes("/v1/extract")
            ? new Response(JSON.stringify({ results: [extracted], errors: [] }))
            : new Response("raw", {
                headers: { "content-type": "text/plain" },
              });
        });
      const work = run({
        urls: [url, "https://example.com/other"],
        output: ["raw", "document"],
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
      pending.forEach((resolve) => resolve());
      expect(text(await work)).toContain("FULL document");
    });
    it("preserves successes and per-URL errors", async () => {
      network({
        results: [extracted],
        errors: [{ url: "https://example.com/missing", error: "not found" }],
      });
      const result = text(
        await run({ urls: [url, "https://example.com/missing"] }),
      );
      expect(result).toContain("FULL document");
      expect(result).toContain("not found");
    });
    it("reports missing full content instead of substituting excerpts", async () => {
      network({ results: [{ url, excerpts: ["passage"] }], errors: [] });
      const missing = await run({ url });
      expect(missing.details).toMatchObject({ retrievalFailed: true });
      expect(text(missing)).toContain("missing full_content");
      expect(
        text(
          await run({
            url,
            objective: "focus",
            output: ["document", "excerpts"],
          }),
        ),
      ).toContain("error: missing full_content");
    });
    for (const response of [
      {},
      { results: [] },
      { results: [{ url, full_content: ["wrong type"] }], errors: [] },
      { results: [], errors: [] },
    ]) {
      it(`rejects malformed/empty response ${JSON.stringify(response)}`, async () => {
        network(response);
        const result = await run({ url });
        expect(result.details).toMatchObject({ retrievalFailed: true });
        expect(text(result)).toContain("all requested outputs failed");
      });
    }
    it("keeps a raw success when Extract fails, with no backend fallback", async () => {
      const fetch = network({});
      const result = text(await run({ url, output: ["raw", "document"] }));
      expect(result).toContain("DIRECT response");
      expect(result).toContain("malformed Extract response");
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    it("marks retained HTTP failure diagnostics for the result normalization hook", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("denied", { status: 403 }),
      );
      const result = await run({ url, output: ["raw"] });
      expect(result.details).toMatchObject({ retrievalFailed: true });
      expect(text(result)).toContain("HTTP 403");
    });
    it("paginates huge all-failed diagnostics without losing their error marker", async () => {
      const fetch = network({
        results: [],
        errors: [{ url, error: "failure detail\n".repeat(15000) }],
      });
      const first = await run({ url });
      expect(Buffer.byteLength(text(first))).toBeLessThan(48000);
      expect(first.details).toMatchObject({ retrievalFailed: true });
      const cursor = (first.details as { webPage: { nextCursor: string } })
        .webPage.nextCursor;
      expect(cursor).toBeTruthy();
      const continuationContext = {
        ...ctx,
        sessionManager: {
          ...ctx.sessionManager,
          getBranch: () => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "read_web_page",
                details: first.details,
              },
            },
          ],
        },
      } as unknown as Context;
      const next = await createReadWebPageTool().execute(
        "continue-failure",
        { cursor },
        undefined,
        undefined,
        continuationContext,
      );
      expect(next.details).toMatchObject({ retrievalFailed: true, cost: 0 });
      expect(Buffer.byteLength(text(next))).toBeLessThan(48000);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    it("revalidates redirect destinations before requesting them", async () => {
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        }),
      );
      expect(text(await run({ url, raw: true }))).toContain("private/reserved");
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    it("rejects binary and invalid UTF-8 rather than corrupting raw text", async () => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response("%PDF-1.7", {
            headers: { "content-type": "application/pdf" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array([0xff]), {
            headers: { "content-type": "text/plain" },
          }),
        );
      expect(text(await run({ url, raw: true }))).toContain("binary");
      expect((await run({ url, raw: true })).details).toMatchObject({
        retrievalFailed: true,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    it("decodes the declared charset", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
          headers: { "content-type": "text/plain; charset=windows-1252" },
        }),
      );
      expect(text(await run({ url, raw: true }))).toContain("café");
    });
    it("retains middle source lines beyond the former 1000-line head/tail window", async () => {
      const source = Array.from(
        { length: 1200 },
        (_, i) => `line ${i} 🌍`,
      ).join("\n");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(source, { headers: { "content-type": "text/plain" } }),
      );
      const result = text(await run({ url, raw: true }));
      expect(result).toContain("line 600 🌍");
      expect(result).toContain("line 1199 🌍");
    });
    it("continues the same Unicode snapshot without network or another charge", async () => {
      const source = "🌍é evidence\n".repeat(8000);
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(source, { headers: { "content-type": "text/plain" } }),
        );
      const first = await run({ url, raw: true });
      const entries = [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "read_web_page",
            details: first.details,
          },
        },
      ];
      const continuationContext = {
        ...ctx,
        sessionManager: { ...ctx.sessionManager, getBranch: () => entries },
      } as unknown as Context;
      let current = first;
      let reconstructed = "";
      for (;;) {
        const page = (current.details as RecordValue).webPage as {
          start: number;
          end: number;
          nextCursor?: string;
        };
        reconstructed += text(current).slice(0, page.end - page.start);
        expect(Buffer.byteLength(text(current))).toBeLessThan(48000);
        if (!page.nextCursor) break;
        current = await createReadWebPageTool().execute(
          "continue",
          { cursor: page.nextCursor },
          undefined,
          undefined,
          continuationContext,
        );
        expect((current.details as RecordValue).cost).toBe(0);
      }
      expect(reconstructed.endsWith(source)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    it("cancellation cannot become a partial success", async () => {
      const abort = new AbortController();
      const fetch = network();
      fetch.mockImplementation(async (input) => {
        if (requestUrl(input).includes("/v1/extract")) {
          abort.abort();
          throw new DOMException("cancelled", "AbortError");
        }
        return new Response("raw success", {
          headers: { "content-type": "text/plain" },
        });
      });
      await expect(
        run({ url, output: ["raw", "document"] }, abort.signal),
      ).rejects.toThrow();
    });
  });
}
