import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  unlink,
  rmdir,
  chmod,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Type,
  type Static,
  type TObject,
  type TOptional,
  type TInteger,
  type TNumber,
  type TBoolean,
} from "typebox";

export const fetchPolicySchema: TObject<{
  max_age_seconds: TOptional<TInteger>;
  timeout_seconds: TOptional<TNumber>;
  disable_cache_fallback: TOptional<TBoolean>;
}> = Type.Object(
  {
    max_age_seconds: Type.Optional(
      Type.Integer({
        minimum: 600,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Refresh cached content older than this; minimum 600. Explicit age defaults to rejecting stale fallback.",
      }),
    ),
    timeout_seconds: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        maximum: 2_147_453,
        description:
          "Upstream live-fetch deadline; transport allows additional overhead.",
      }),
    ),
    disable_cache_fallback: Type.Optional(
      Type.Boolean({
        description:
          "true rejects older cache after a failed live fetch. Explicit false permits stale fallback.",
      }),
    ),
  },
  { additionalProperties: false },
);
type FetchPolicy = Static<typeof fetchPolicySchema>;

/** An explicit age must not silently become stale evidence after a failed refresh. */
export function resolveFetchPolicy(
  policy?: FetchPolicy,
): FetchPolicy | undefined {
  if (policy?.max_age_seconds === undefined) return policy;
  return {
    ...policy,
    disable_cache_fallback: policy.disable_cache_fallback ?? true,
  };
}

export type RetrievalContext = Pick<
  ExtensionContext,
  "model" | "sessionManager"
>;
type ToolName = "web_search" | "read_web_page";
interface Result {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}
interface Snapshot {
  id: string;
  toolName: ToolName;
  originSession: string;
  expiresAt: number;
  length: number;
  sha256: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const digest = (value: string): string =>
  createHash("sha256").update(value, "utf16le").digest("hex");
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TTL = 24 * 60 * 60 * 1000;
const MAX_STORAGE = 200 * 1024 * 1024;
const MAX_RESPONSE = 200 * 1024 * 1024;
class RetrievalError extends Error {}

/** Retries may incur additional upstream charges; disable with maxRetries: 0 for evaluations. */
export async function parallelRequest(
  endpoint: string,
  body: Record<string, unknown>,
  options: {
    signal?: AbortSignal;
    timeoutSeconds?: number;
    fetch?: typeof globalThis.fetch;
    maxRetries?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const timeout = options.timeoutSeconds ?? 120;
  const retries = options.maxRetries ?? 2;
  if (
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout * 1000 > 2_147_483_647 ||
    !Number.isInteger(retries) ||
    retries < 0 ||
    retries > 2
  )
    throw new Error("invalid retrieval deadline or retry count");
  let url: URL;
  try {
    url = new URL(endpoint, "https://api.parallel.ai");
  } catch {
    throw new Error("invalid parallel endpoint");
  }
  if (url.origin !== "https://api.parallel.ai" || url.username || url.password)
    throw new Error("untrusted parallel endpoint");
  const key = process.env.PARALLEL_API_KEY;
  if (!key) throw new Error("PARALLEL_API_KEY is required");
  let payload: string;
  try {
    payload = JSON.stringify(body);
  } catch {
    throw new Error("invalid parallel request body");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.ceil(timeout * 1000));
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: payload,
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (
          (response.status === 429 ||
            (response.status >= 500 && response.status <= 599)) &&
          attempt < retries
        ) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter === null ? NaN : Number(retryAfter);
          const date = retryAfter === null ? NaN : Date.parse(retryAfter);
          const delay = Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : Number.isFinite(date)
              ? Math.max(0, date - Date.now())
              : 500 * 2 ** attempt;
          // A longer Retry-After exhausts the deadline rather than becoming an early retry.
          await sleep(Math.min(delay, Math.ceil(timeout * 1000)), undefined, {
            signal,
          });
          continue;
        }
        throw new RetrievalError(`parallel HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new RetrievalError("parallel response has no JSON body");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const abortRead = (): void => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abortRead, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE)
            throw new RetrievalError(
              "parallel response exceeds 200 MiB safety limit; no partial result returned",
            );
          chunks.push(value);
        }
      } finally {
        signal.removeEventListener("abort", abortRead);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new RetrievalError("parallel response is not valid JSON");
      }
      if (!record(parsed))
        throw new RetrievalError("parallel response must be a JSON object");
      return parsed;
    }
  } catch (error) {
    if (signal.aborted)
      throw new Error("retrieval cancelled or deadline exceeded");
    // Native transport/body errors may contain credentials or response content.
    if (error instanceof RetrievalError) throw error;
    throw new Error("parallel transport failed");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * only opaque lineage IDs leave the machine. fork-choice edges separate branches even
 * when /tree diverges after a shared assistant/tool result. discovering a later fork
 * can rotate an older branch's group; isolation takes precedence over context reuse.
 * an explicit ID intentionally overrides this grouping.
 */
export function retrievalIdentity(
  ctx: RetrievalContext,
  sessionId?: string,
): { client_model?: string; session_id: string } {
  if (
    sessionId !== undefined &&
    (sessionId.length < 1 || sessionId.length > 1000)
  )
    throw new Error("session_id must contain 1–1000 characters");
  let user = "";
  let assistant = "";
  const branch = ctx.sessionManager.getBranch();
  const children = new Map<string | null, number>();
  for (const entry of ctx.sessionManager.getEntries?.() ?? branch)
    if (entry.parentId !== undefined)
      children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
  const forkChoices = branch
    .filter((entry) => (children.get(entry.parentId) ?? 0) > 1)
    .map((entry) => entry.id);
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") {
      user = entry.id;
      assistant = "";
    } else if (entry.message.role === "assistant" && !assistant)
      assistant = entry.id;
  }
  return {
    ...(ctx.model?.id ? { client_model: ctx.model.id } : {}),
    session_id:
      sessionId ??
      digest(
        JSON.stringify([
          ctx.sessionManager.getSessionId(),
          user,
          assistant,
          forkChoices,
        ]),
      ),
  };
}

export function formatWarnings(value: unknown): string {
  if (value === undefined || value === null) return "";
  return (Array.isArray(value) ? value : [value])
    .map((item) => {
      if (typeof item === "string") return item;
      try {
        return JSON.stringify(item) ?? String(item);
      } catch {
        return String(item);
      }
    })
    .join("\n");
}

/** Known rates only: https://docs.parallel.ai/pricing. Unknown SKUs invalidate a partial total. */
export function usageCost(
  usage: unknown,
  fallback: number,
  searchPrice: 0.001 | 0.005 = 0.005,
): { cost?: number; costEstimated: boolean; unknownSkus?: string[] } {
  if (
    usage === undefined ||
    usage === null ||
    (Array.isArray(usage) && !usage.length)
  ) {
    return Number.isFinite(fallback) && fallback >= 0
      ? { cost: fallback, costEstimated: true }
      : { costEstimated: true };
  }
  // v1 returns the same sku_search for fast and advanced; price follows the
  // requested mode, not the SKU name alone. observed in the opt-in live evaluation.
  const prices: Record<string, number> = {
    sku_search: searchPrice,
    sku_search_additional_results: 0.001,
    sku_extract_excerpts: 0.001,
  };
  const unknown = new Set<string>();
  let cost = 0;
  for (const item of Array.isArray(usage) ? usage : [usage]) {
    if (!record(item) || typeof item.name !== "string") {
      unknown.add("unrecognized usage");
      continue;
    }
    const price = Object.hasOwn(prices, item.name)
      ? prices[item.name]
      : undefined;
    if (
      price === undefined ||
      typeof item.count !== "number" ||
      !Number.isFinite(item.count) ||
      item.count < 0
    ) {
      unknown.add(item.name);
      continue;
    }
    cost += price * item.count;
  }
  return unknown.size
    ? { costEstimated: false, unknownSkus: [...unknown] }
    : Number.isFinite(cost)
      ? { cost, costEstimated: false }
      : { costEstimated: false, unknownSkus: ["usage overflow"] };
}

function windowText(
  text: string,
  start = 0,
  length = text.length,
): { text: string; end: number } {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > text.length ||
    !Number.isSafeInteger(length) ||
    length < 1
  ) {
    if (!(text.length === 0 && start === 0 && length === 0))
      throw new Error(
        "invalid snapshot window: use nonnegative UTF-16 start and positive length within the text",
      );
  }
  // Explicit legacy windows may bisect a surrogate pair; default pages never do.
  const requestedEnd = Math.min(text.length, start + length);
  let end = start;
  let bytes = 0;
  let lines = 1;
  while (end < requestedEnd) {
    const point = text.codePointAt(end)!;
    const width = point > 0xffff && end + 1 < requestedEnd ? 2 : 1;
    const chunk = text.slice(end, end + width);
    const size = Buffer.byteLength(chunk);
    if (bytes + size > 44_000 || (chunk === "\n" && lines >= 1700)) break;
    bytes += size;
    if (chunk === "\n") lines++;
    end += width;
  }
  return { text: text.slice(start, end), end };
}

function snapshotValue(value: unknown): value is Snapshot {
  return (
    record(value) &&
    typeof value.id === "string" &&
    UUID.test(value.id) &&
    (value.toolName === "web_search" || value.toolName === "read_web_page") &&
    typeof value.originSession === "string" &&
    /^[a-f0-9]{64}$/.test(value.originSession) &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    typeof value.length === "number" &&
    Number.isSafeInteger(value.length) &&
    value.length >= 0 &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  );
}

/**
 * Disk is shared across module copies, authority is not: only current-ancestry tool results
 * grant access. Retention is 24h, lazily swept per session; 200 MiB/session rejects new
 * snapshots instead of evicting live evidence. Forked sessions must retrieve anew.
 * Session directories use a hash (SDK session IDs need not be filesystem-safe UUIDs).
 * A crashed writer's lock fails closed; it is not stolen from a potentially live writer.
 */
function snapshotStore(
  root: string,
  now: () => number = Date.now,
): {
  publish: (
    text: string,
    ctx: RetrievalContext,
    details: Record<string, unknown>,
    toolName: ToolName,
    page?: { start?: number; length?: number },
  ) => Promise<Result>;
  continue: (
    cursor: string,
    ctx: RetrievalContext,
    toolName: ToolName,
    length?: number,
  ) => Promise<Result>;
} {
  const directory = (ctx: RetrievalContext): string =>
    join(root, digest(ctx.sessionManager.getSessionId()));
  async function privateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("snapshot storage is not a private directory");
    await chmod(path, 0o700);
  }
  function render(
    text: string,
    snapshot: Snapshot,
    details: Record<string, unknown>,
    start?: number,
    length?: number,
  ): Result {
    const offset = start ?? 0;
    const page = windowText(text, offset, length ?? text.length);
    const nextCursor =
      page.end < text.length ? `${snapshot.id}:${page.end}` : undefined;
    const footer = `\n\n[snapshot ${snapshot.id}; UTF-16 offsets ${offset}..${page.end}/${text.length}; expires ${new Date(snapshot.expiresAt).toISOString()} (24h retention).${nextCursor ? ` next cursor: ${nextCursor}.` : ""}${offset > 0 ? ` beginning cursor: ${snapshot.id}:0.` : ""}]`;
    return {
      content: [{ type: "text", text: page.text + footer }],
      details: {
        ...details,
        webSnapshot: snapshot,
        webPage: {
          start: offset,
          end: page.end,
          total: text.length,
          nextCursor,
          beginningCursor: `${snapshot.id}:0`,
        },
      },
    };
  }
  return {
    async publish(text, ctx, details, toolName, page) {
      windowText(text, page?.start, page?.length);
      const session = ctx.sessionManager.getSessionId();
      const snapshot: Snapshot = {
        id: randomUUID(),
        toolName,
        originSession: digest(session),
        expiresAt: now() + TTL,
        length: text.length,
        sha256: digest(text),
      };
      const serialized = JSON.stringify({ snapshot, text });
      if (Buffer.byteLength(serialized) > MAX_STORAGE)
        throw new Error(
          "snapshot exceeds 200 MiB/session storage limit; no evidence truncated",
        );
      await privateDirectory(root);
      const dir = join(root, snapshot.originSession);
      await privateDirectory(dir);
      const lock = join(dir, ".write-lock");
      for (let attempt = 0; ; attempt++) {
        try {
          await mkdir(lock, { mode: 0o700 });
          break;
        } catch (error) {
          if (!record(error) || error.code !== "EEXIST")
            throw new Error("snapshot storage unavailable");
          if (attempt >= 100)
            throw new Error(
              "snapshot storage busy; publication failed without overwriting retained evidence",
            );
          await sleep(25);
        }
      }
      try {
        let size = 0;
        for (const name of await readdir(dir)) {
          if (
            !UUID.test(name.replace(/\.json$/, "")) ||
            !name.endsWith(".json")
          )
            continue;
          const path = join(dir, name);
          const stat = await lstat(path);
          if (stat.isSymbolicLink() || !stat.isFile())
            throw new Error("snapshot storage contains an unsafe entry");
          if (stat.mtimeMs + TTL <= now()) await unlink(path);
          else size += stat.size;
        }
        if (size + Buffer.byteLength(serialized) > MAX_STORAGE)
          throw new Error(
            "snapshot storage full (200 MiB/session); live evidence was not evicted",
          );
        await writeFile(join(dir, `${snapshot.id}.json`), serialized, {
          flag: "wx",
          mode: 0o600,
        });
      } finally {
        await rmdir(lock);
      }
      if (ctx.sessionManager.getSessionId() !== session)
        throw new Error(
          "session changed during snapshot publication; result not published",
        );
      return render(text, snapshot, details, page?.start, page?.length);
    },
    async continue(cursor, ctx, toolName, length) {
      const match = /^([0-9a-f-]+):(0|[1-9][0-9]*)$/.exec(cursor);
      if (!match || !UUID.test(match[1]!))
        throw new Error("invalid snapshot cursor");
      const id = match[1]!;
      let authorized: Snapshot | undefined;
      let sourceDetails: Record<string, unknown> = {};
      for (const entry of ctx.sessionManager.getBranch()) {
        if (
          entry.type !== "message" ||
          entry.message.role !== "toolResult" ||
          entry.message.toolName !== toolName
        )
          continue;
        const details: unknown = entry.message.details;
        if (
          record(details) &&
          snapshotValue(details.webSnapshot) &&
          details.webSnapshot.id === id &&
          details.webSnapshot.toolName === toolName
        ) {
          authorized = details.webSnapshot;
          sourceDetails = details;
          break;
        }
      }
      if (!authorized)
        throw new Error(
          "snapshot is not authorized in the current branch for this tool",
        );
      if (
        authorized.originSession !== digest(ctx.sessionManager.getSessionId())
      )
        throw new Error(
          "snapshot belongs to another session; forked-session continuation is not supported",
        );
      if (authorized.expiresAt <= now())
        throw new Error("snapshot expired; continuation never refetches");
      let stored: unknown;
      try {
        const path = join(directory(ctx), `${id}.json`);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORAGE)
          throw new Error("unsafe snapshot");
        stored = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error(
          "snapshot missing or corrupt; continuation never refetches",
        );
      }
      if (
        !record(stored) ||
        !snapshotValue(stored.snapshot) ||
        typeof stored.text !== "string" ||
        stored.snapshot.id !== authorized.id ||
        stored.snapshot.originSession !== authorized.originSession ||
        stored.snapshot.toolName !== authorized.toolName ||
        stored.snapshot.expiresAt !== authorized.expiresAt ||
        stored.snapshot.length !== authorized.length ||
        stored.snapshot.sha256 !== authorized.sha256 ||
        stored.text.length !== authorized.length ||
        digest(stored.text) !== authorized.sha256
      )
        throw new Error("snapshot corrupt; continuation never refetches");
      return render(
        stored.text,
        authorized,
        {
          ...sourceDetails,
          sourceCost: sourceDetails.sourceCost ?? {
            cost: sourceDetails.cost,
            costEstimated: sourceDetails.costEstimated,
            usage: sourceDetails.usage,
          },
          cost: 0,
          costEstimated: false,
          continuation: true,
        },
        Number(match[2]),
        length,
      );
    },
  };
}

const snapshots = snapshotStore(
  join(tmpdir(), `pi-web-retrieval-${process.getuid?.() ?? "user"}`),
);

export async function publishResult(
  text: string,
  ctx: RetrievalContext,
  details: Record<string, unknown>,
  toolName: ToolName,
  page?: { start?: number; length?: number },
): Promise<Result> {
  try {
    return await snapshots.publish(text, ctx, details, toolName, page);
  } catch (error) {
    // Filesystem diagnostics include local paths, which must not enter model-visible results.
    if (record(error) && "code" in error)
      throw new Error("snapshot storage unavailable; result not published");
    throw error;
  }
}

export async function continueResult(
  cursor: string,
  ctx: RetrievalContext,
  toolName: ToolName,
  length?: number,
): Promise<Result> {
  return snapshots.continue(cursor, ctx, toolName, length);
}

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;
  const context = (
    entries: unknown[] = [],
    session = "test-session",
  ): RetrievalContext =>
    ({
      model: { id: "test-model" },
      sessionManager: { getSessionId: () => session, getBranch: () => entries },
    }) as RetrievalContext;
  const message = (id: string, role: string, rest = {}): unknown => ({
    type: "message",
    id,
    message: { role, ...rest },
  });
  describe("web retrieval", () => {
    it("defaults stale fallback only for an explicit age and preserves caller overrides", () => {
      expect(resolveFetchPolicy()).toBeUndefined();
      expect(resolveFetchPolicy({})).toEqual({});
      expect(resolveFetchPolicy({ timeout_seconds: 20 })).toEqual({
        timeout_seconds: 20,
      });
      expect(resolveFetchPolicy({ max_age_seconds: 600 })).toEqual({
        max_age_seconds: 600,
        disable_cache_fallback: true,
      });
      const explicit = Object.freeze({
        max_age_seconds: 600,
        disable_cache_fallback: false,
      });
      expect(resolveFetchPolicy(explicit)).toEqual(explicit);
    });
    it("isolates sibling identity without changing related calls or sending prompts", () => {
      const user = message("u", "user", { content: "private prompt" });
      const a = retrievalIdentity(context([user, message("a", "assistant")]));
      expect(a).toEqual(
        retrievalIdentity(
          context([
            user,
            message("a", "assistant"),
            message("later", "assistant"),
          ]),
        ),
      );
      expect(a.session_id).not.toBe(
        retrievalIdentity(context([user, message("b", "assistant")]))
          .session_id,
      );
      expect(a.session_id).toMatch(/^[a-f0-9]{64}$/);
      expect(retrievalIdentity(context(), "explicit").session_id).toBe(
        "explicit",
      );
      expect(() => retrievalIdentity(context(), "")).toThrow();
    });
    it("isolates forks after a shared assistant and tool result", () => {
      const entries = [
        {
          type: "message",
          id: "user",
          parentId: null,
          message: { role: "user" },
        },
        {
          type: "message",
          id: "shared",
          parentId: "user",
          message: { role: "assistant" },
        },
        {
          type: "message",
          id: "result",
          parentId: "shared",
          message: { role: "toolResult" },
        },
        {
          type: "message",
          id: "left",
          parentId: "result",
          message: { role: "assistant" },
        },
        {
          type: "message",
          id: "right",
          parentId: "result",
          message: { role: "assistant" },
        },
        {
          type: "message",
          id: "later",
          parentId: "left",
          message: { role: "assistant" },
        },
      ];
      const base = context();
      const withBranch = (ids: string[]): RetrievalContext =>
        ({
          ...base,
          sessionManager: {
            ...base.sessionManager,
            getEntries: () => entries,
            getBranch: () => entries.filter((entry) => ids.includes(entry.id)),
          },
        }) as RetrievalContext;
      const left = retrievalIdentity(
        withBranch(["user", "shared", "result", "left"]),
      );
      expect(left).not.toEqual(
        retrievalIdentity(withBranch(["user", "shared", "result", "right"])),
      );
      expect(left).toEqual(
        retrievalIdentity(
          withBranch(["user", "shared", "result", "left", "later"]),
        ),
      );
    });
    it("does not invent prices for unknown usage", () => {
      expect(usageCost(undefined, 0.005)).toEqual({
        cost: 0.005,
        costEstimated: true,
      });
      expect(usageCost([{ name: "sku_search", count: 2 }], 0)).toEqual({
        cost: 0.01,
        costEstimated: false,
      });
      expect(usageCost([{ name: "sku_search", count: 2 }], 0, 0.001)).toEqual({
        cost: 0.002,
        costEstimated: false,
      });
      expect(
        usageCost(
          [
            { name: "sku_search", count: 1 },
            { name: "sku_fast", count: 1 },
          ],
          0,
        ),
      ).toEqual({ costEstimated: false, unknownSkus: ["sku_fast"] });
      expect(
        usageCost([{ name: "toString", count: 1 }], 0).cost,
      ).toBeUndefined();
      expect(
        formatWarnings([{ message: "warning", code: 1 }, false]),
      ).toContain("warning");
    });
    it("bounds UTF-8 bytes and lines while reconstructing all evidence", () => {
      for (const text of [
        "😀é".repeat(40_000),
        "x\n".repeat(4000),
        "a".repeat(100_000),
      ]) {
        let start = 0;
        let reconstructed = "";
        while (start < text.length) {
          const page = windowText(text, start);
          expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(44_000);
          expect(page.text.split("\n").length).toBeLessThanOrEqual(1700);
          expect(page.end).toBeGreaterThan(start);
          reconstructed += page.text;
          start = page.end;
        }
        expect(reconstructed).toBe(text);
      }
      expect(windowText("a😀b", 1, 2).text).toBe("😀");
      expect(() => windowText("a", 2)).toThrow();
    });
    it("continues across store copies using current-branch authority, without network", async () => {
      const { mkdtemp, rm, stat } = await import("node:fs/promises");
      const root = await mkdtemp(join(tmpdir(), "pi-web-test-"));
      let clock = Date.now();
      const store = snapshotStore(root, () => clock);
      const entries: unknown[] = [];
      const ctx = context(entries);
      try {
        const text = "😀long evidence\n".repeat(7000);
        const result = await store.publish(
          text,
          ctx,
          { cost: 0.005 },
          "web_search",
        );
        entries.push(
          message("result", "toolResult", {
            toolName: "web_search",
            details: result.details,
          }),
        );
        const descriptor = result.details.webSnapshot as Snapshot;
        expect(
          (
            await stat(
              join(root, descriptor.originSession, `${descriptor.id}.json`),
            )
          ).mode & 0o777,
        ).toBe(0o600);
        let reconstructed = "";
        let cursor: string | undefined = `${descriptor.id}:0`;
        while (cursor) {
          const next = await snapshotStore(root, () => clock).continue(
            cursor,
            ctx,
            "web_search",
          );
          const page = next.details.webPage as {
            start: number;
            end: number;
            nextCursor?: string;
          };
          reconstructed += next.content[0]!.text.slice(
            0,
            page.end - page.start,
          );
          expect(next.details.cost).toBe(0);
          expect(next.details.sourceCost).toEqual({
            cost: 0.005,
            costEstimated: undefined,
            usage: undefined,
          });
          expect(Buffer.byteLength(next.content[0]!.text)).toBeLessThan(48_000);
          cursor = page.nextCursor;
        }
        expect(reconstructed).toBe(text);
        const first = `${descriptor.id}:0`;
        await expect(
          store.continue(first, context(), "web_search"),
        ).rejects.toThrow("authorized");
        await expect(
          store.continue(first, ctx, "read_web_page"),
        ).rejects.toThrow("authorized");
        await expect(
          store.continue(first, context(entries, "fork"), "web_search"),
        ).rejects.toThrow("another session");
        await expect(
          store.continue(`${descriptor.id}:99999999`, ctx, "web_search"),
        ).rejects.toThrow("window");
        clock += TTL;
        await expect(store.continue(first, ctx, "web_search")).rejects.toThrow(
          "expired",
        );
        clock -= TTL;
        await writeFile(
          join(root, descriptor.originSession, `${descriptor.id}.json`),
          "{}",
        );
        await expect(store.continue(first, ctx, "web_search")).rejects.toThrow(
          "corrupt",
        );
        await unlink(
          join(root, descriptor.originSession, `${descriptor.id}.json`),
        );
        await expect(store.continue(first, ctx, "web_search")).rejects.toThrow(
          "missing",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it("serializes independent writers and refuses quota overflow without evicting evidence", async () => {
      const { mkdtemp, rm, open, utimes } = await import("node:fs/promises");
      const root = await mkdtemp(join(tmpdir(), "pi-web-quota-test-"));
      const ctx = context();
      const store = snapshotStore(root);
      try {
        const results = await Promise.all([
          store.publish("a", ctx, {}, "web_search"),
          snapshotStore(root).publish("b", ctx, {}, "web_search"),
        ]);
        expect((results[0]!.details.webSnapshot as Snapshot).id).not.toBe(
          (results[1]!.details.webSnapshot as Snapshot).id,
        );
        const dir = join(root, digest(ctx.sessionManager.getSessionId()));
        const blocker = join(dir, `${randomUUID()}.json`);
        const file = await open(blocker, "wx", 0o600);
        try {
          await file.truncate(MAX_STORAGE);
        } finally {
          await file.close();
        }
        await expect(store.publish("c", ctx, {}, "web_search")).rejects.toThrow(
          "storage full",
        );
        expect(
          (await readdir(dir)).filter((name) => name.endsWith(".json")),
        ).toHaveLength(3);
        const expired = new Date(Date.now() - TTL - 1000);
        await utimes(blocker, expired, expired);
        await store.publish("c", ctx, {}, "web_search");
        expect((await readdir(dir)).includes(blocker.split("/").at(-1)!)).toBe(
          false,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it("retries only retryable HTTP errors and sanitizes failures", async () => {
      vi.stubEnv("PARALLEL_API_KEY", "secret-test-key");
      try {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(
            new Response("secret", {
              status: 429,
              headers: { "retry-after": "0" },
            }),
          )
          .mockResolvedValueOnce(new Response('{"results":[]}'));
        expect(await parallelRequest("/v1/search", {}, { fetch })).toEqual({
          results: [],
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        for (const status of [400, 401, 403, 422]) {
          const fail = vi
            .fn<typeof globalThis.fetch>()
            .mockImplementation(
              async () => new Response("secret-test-key", { status }),
            );
          await expect(
            parallelRequest("/v1/search", {}, { fetch: fail }),
          ).rejects.toThrow(`HTTP ${status}`);
          expect(fail).toHaveBeenCalledTimes(1);
        }
        for (const body of ["secret-test-key", "[]", "null"]) {
          await expect(
            parallelRequest(
              "/v1/search",
              {},
              { fetch: vi.fn().mockResolvedValue(new Response(body)) },
            ),
          ).rejects.toThrow(/parallel response/);
        }
        const disabled = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(new Response("", { status: 503 }));
        await expect(
          parallelRequest("/v1/search", {}, { fetch: disabled, maxRetries: 0 }),
        ).rejects.toThrow("HTTP 503");
        expect(disabled).toHaveBeenCalledTimes(1);
        const exhausted = vi.fn<typeof globalThis.fetch>().mockImplementation(
          async () =>
            new Response("secret-test-key", {
              status: 503,
              headers: { "retry-after": "0" },
            }),
        );
        await expect(
          parallelRequest("/v1/search", {}, { fetch: exhausted }),
        ).rejects.toThrow("HTTP 503");
        expect(exhausted).toHaveBeenCalledTimes(3);
        const leaking = vi
          .fn<typeof globalThis.fetch>()
          .mockRejectedValue(new Error("secret-test-key response body"));
        await expect(
          parallelRequest("/v1/search", {}, { fetch: leaking }),
        ).rejects.toThrow(/^parallel transport failed$/);
        expect(leaking).toHaveBeenCalledTimes(1);
        await expect(
          parallelRequest("https://example.com", {}, { fetch }),
        ).rejects.toThrow("untrusted");
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it("cancels retry waits and stalled response reads under one deadline", async () => {
      vi.stubEnv("PARALLEL_API_KEY", "test-key");
      try {
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
          async () =>
            new Response("", {
              status: 429,
              headers: { "retry-after": "100" },
            }),
        );
        await expect(
          parallelRequest("/v1/search", {}, { fetch, timeoutSeconds: 0.02 }),
        ).rejects.toThrow("deadline");
        expect(fetch).toHaveBeenCalledTimes(1);
        const stalled = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(new Response(new ReadableStream({ start() {} })));
        await expect(
          parallelRequest(
            "/v1/search",
            {},
            { fetch: stalled, timeoutSeconds: 0.02 },
          ),
        ).rejects.toThrow("deadline");
        const abort = new AbortController();
        abort.abort();
        const unused = vi.fn<typeof globalThis.fetch>();
        await expect(
          parallelRequest(
            "/v1/search",
            {},
            { fetch: unused, signal: abort.signal },
          ),
        ).rejects.toThrow("cancelled");
        expect(unused).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
}
