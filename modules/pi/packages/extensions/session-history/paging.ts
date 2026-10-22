import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SessionHistory, SessionSummary } from "@bds_pi/sessions";

// Leave room for the SDK envelope and the escaped JSON text alongside structured
// output. The final transport check covers both copies, not only visible text.
export const MAX_HISTORY_PAYLOAD_BYTES: number = 16 * 1024;
export const MAX_HISTORY_TOOL_BYTES: number = 64 * 1024;
const PREVIEW_CHARS = 512;
const CONTENT_CHARS = 2048;

export interface Page {
  /** Indices count native records examined, including explicitly omitted ones. */
  offset: number;
  nextOffset: number | null;
  total: number;
}

export interface OmittedEntry {
  entryId: string;
  type: string;
  bytes: number;
}

interface HistoryFailure {
  ok: false;
  error: { code: string; message: string };
}

interface HistoryContent {
  ok: true;
  value: SessionHistory;
  content: {
    entryId: string;
    offset: number;
    nextOffset: number | null;
    total: number;
    text: string;
  };
}

type PreviewSession = SessionSummary & { truncatedFields?: string[] };
type HistoryToolResult = AgentToolResult<undefined> & { isError: boolean };

export const byteSize = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

export function historyFailure(code: string, message: string): HistoryFailure {
  return { ok: false as const, error: { code, message } };
}

function outputLimit() {
  return historyFailure(
    "output_limit",
    "History identity or error metadata exceeds the response budget; narrow the request or inspect the native file outside codemode.",
  );
}

export function validIndex(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

export function validPage(offset?: number, limit?: number): boolean {
  return (
    validIndex(offset) &&
    (limit === undefined ||
      (Number.isSafeInteger(limit) && limit >= 1 && limit <= 100))
  );
}

/** Don't cut a surrogate pair; offsets otherwise use JavaScript string indices. */
function endAt(text: string, end: number): number {
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  )
    return end - 1;
  return end;
}

export function previewSession(session: SessionSummary): PreviewSession {
  const fields = ["name", "firstMessage"] as const;
  const result: PreviewSession = { ...session };
  for (const field of fields) {
    const text = session[field];
    if (text !== null && text.length > PREVIEW_CHARS) {
      result[field] = text.slice(0, endAt(text, PREVIEW_CHARS));
      (result.truncatedFields ??= []).push(field);
    }
  }
  return result;
}

/** Oversized records advance the cursor; a merely full page does not consume
 * its next record. Native storage and entry shapes remain untouched. */
export function historyPage<T, R extends { ok: true }>(
  items: readonly T[],
  offset: number,
  limit: number,
  wrap: (values: T[], page: Page, omitted: OmittedEntry[]) => R,
  describeOmitted?: (item: T, bytes: number) => OmittedEntry,
): R | ReturnType<typeof historyFailure> {
  if (offset > items.length)
    return historyFailure(
      "invalid_argument",
      "offset exceeds the selected result length",
    );
  const values: T[] = [];
  const omitted: OmittedEntry[] = [];
  let next = offset;
  const pageAt = (end: number): Page => ({
    offset,
    nextOffset: end < items.length ? end : null,
    total: items.length,
  });
  for (; next < items.length && next - offset < limit; next++) {
    const item = items[next]!;
    if (
      byteSize(wrap([item], pageAt(next + 1), [])) > MAX_HISTORY_PAYLOAD_BYTES
    ) {
      if (!describeOmitted) return outputLimit();
      omitted.push(describeOmitted(item, byteSize(item)));
      if (
        byteSize(wrap(values, pageAt(next + 1), omitted)) <=
        MAX_HISTORY_PAYLOAD_BYTES
      )
        continue;
      omitted.pop();
    } else {
      values.push(item);
      if (
        byteSize(wrap(values, pageAt(next + 1), omitted)) <=
        MAX_HISTORY_PAYLOAD_BYTES
      )
        continue;
      values.pop();
    }
    if (next === offset) return outputLimit();
    break;
  }
  return wrap(values, pageAt(next), omitted);
}

export function historyContent(
  history: SessionHistory,
  id: string,
  offset: number,
): HistoryContent | HistoryFailure {
  const entry = history.entries.find((item) => item.id === id);
  if (!entry)
    return historyFailure(
      "entry_not_found",
      "contentId is not on the selected branch",
    );
  const text = JSON.stringify(entry);
  if (offset > text.length || endAt(text, offset) !== offset)
    return historyFailure(
      "invalid_argument",
      "contentOffset is outside the entry or splits a surrogate pair",
    );
  // Shrink for long routing metadata or escaping; each chunk independently fits.
  let end = endAt(text, Math.min(text.length, offset + CONTENT_CHARS));
  for (;;) {
    if (end === offset && offset < text.length) return outputLimit();
    const result = {
      ok: true as const,
      value: { ...history, entries: [] },
      content: {
        entryId: id,
        offset,
        nextOffset: end < text.length ? end : null,
        total: text.length,
        text: text.slice(offset, end),
      },
    };
    if (byteSize(result) <= MAX_HISTORY_PAYLOAD_BYTES) return result;
    if (end === offset) return outputLimit();
    end = endAt(text, offset + Math.floor((end - offset) / 2));
  }
}

/** This is the last gate before any data enters the codemode bridge. Never put
 * the original unbounded result in details, even when visible text is bounded. */
export function historyToolResult(result: { ok: boolean }): HistoryToolResult {
  const bounded =
    byteSize(result) <= MAX_HISTORY_PAYLOAD_BYTES ? result : outputLimit();
  const text = JSON.stringify(bounded);
  const output: HistoryToolResult = {
    content: [{ type: "text", text }],
    structuredContent: JSON.parse(text),
    details: undefined,
    isError: !bounded.ok,
  };
  if (byteSize(output) > MAX_HISTORY_TOOL_BYTES) {
    const fallback = outputLimit();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(fallback) }],
      structuredContent: { ...fallback },
      details: undefined,
      isError: true,
    };
  }
  return output;
}

export async function historyResponse(
  operation: () => Promise<{ ok: boolean }>,
): Promise<HistoryToolResult> {
  try {
    return historyToolResult(await operation());
  } catch (error) {
    return historyToolResult(
      historyFailure(
        "io",
        error instanceof Error
          ? error.message.slice(0, 1024)
          : "History request failed",
      ),
    );
  }
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;

  it("validates scalar page controls without allowing an unbounded limit", () => {
    expect(validPage()).toBe(true);
    expect(validPage(0, 100)).toBe(true);
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(validPage(bad, 1)).toBe(false);
    for (const bad of [0, -1, 1.5, 101, Infinity])
      expect(validPage(0, bad)).toBe(false);
  });

  it("bounds the complete SDK envelope, including escaping and error metadata", () => {
    const huge = { ok: true, value: '"\\\n😀'.repeat(100_000) };
    // Known-failure control: the former raw wrapper exceeds the transport bound.
    expect(
      byteSize({
        content: [{ type: "text", text: JSON.stringify(huge) }],
        structuredContent: huge,
        details: huge,
      }),
    ).toBeGreaterThan(MAX_HISTORY_TOOL_BYTES);
    for (const input of [
      huge,
      historyFailure("io", "x".repeat(100_000)),
      {
        ok: false,
        error: {
          code: "ambiguous",
          candidates: Array(5000).fill({ path: "x" }),
        },
      },
    ]) {
      const result = historyToolResult(input);
      expect(byteSize(result)).toBeLessThanOrEqual(MAX_HISTORY_TOOL_BYTES);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "output_limit" },
      });
      expect(result.details).toBeUndefined();
    }
  });

  it("keeps admissible records for the next page instead of losing them", () => {
    const items = Array.from({ length: 8 }, (_, id) => ({
      id,
      text: "x".repeat(5000),
    }));
    const wrap = (value: typeof items, page: Page) => ({
      ok: true as const,
      value,
      page,
    });
    let offset = 0;
    const seen: number[] = [];
    do {
      const result = historyPage(items, offset, 100, wrap);
      if (!result.ok) throw new Error(result.error.message);
      seen.push(...result.value.map((item) => item.id));
      expect(byteSize(historyToolResult(result))).toBeLessThanOrEqual(
        MAX_HISTORY_TOOL_BYTES,
      );
      if (result.page.nextOffset === null) break;
      expect(result.page.nextOffset).toBeGreaterThan(offset);
      offset = result.page.nextOffset;
    } while (true);
    expect(seen).toEqual(items.map((item) => item.id));
  });

  it("pages past a huge native entry and retrieves its exact escaped Unicode content", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const manager = SessionManager.inMemory("/fixture");
    const first = manager.appendMessage({
      role: "user",
      content: "start",
      timestamp: 1,
    });
    const large = manager.appendMessage({
      role: "toolResult",
      toolCallId: "large",
      toolName: "fixture",
      content: [{ type: "text", text: '\"\\\\\\n😀'.repeat(6000) }],
      isError: false,
      timestamp: 2,
    });
    const correction = manager.appendMessage({
      role: "user",
      content: "later correction",
      timestamp: 3,
    });
    manager.branch(first);
    const sibling = manager.appendMessage({
      role: "user",
      content: "other branch",
      timestamp: 4,
    });
    const entries = manager.getBranch(correction);
    const history: SessionHistory = {
      sessionId: manager.getSessionId(),
      workspace: "/fixture",
      sessionFile: null,
      sessionDir: null,
      parentSessionFile: null,
      selection: "entry",
      leafId: correction,
      rootEntryId: first,
      entries,
    };
    const original = JSON.stringify(manager.getEntries());
    const wrap = (
      entries: typeof history.entries,
      page: Page,
      omitted: OmittedEntry[],
    ) => ({ ok: true as const, value: { ...history, entries }, page, omitted });
    const describe = (entry: (typeof entries)[number], bytes: number) => ({
      entryId: entry.id,
      type: entry.type,
      bytes,
    });
    const page = historyPage(entries, 0, 2, wrap, describe);
    if (!page.ok) throw new Error(page.error.message);
    expect(page.value.entries.map((entry) => entry.id)).toEqual([first]);
    expect(page.omitted).toMatchObject([{ entryId: large, type: "message" }]);
    expect(page.page.nextOffset).toBe(2);
    const next = historyPage(entries, 2, 2, wrap, describe);
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value.entries.map((entry) => entry.id)).toEqual([correction]);
    expect(next.page.nextOffset).toBeNull();
    expect(historyContent(history, sibling, 0)).toMatchObject({
      ok: false,
      error: { code: "entry_not_found" },
    });
    expect(
      historyContent(history, large, Number.MAX_SAFE_INTEGER),
    ).toMatchObject({ ok: false });
    let offset = 0;
    let reconstructed = "";
    for (;;) {
      const chunk = historyContent(history, large, offset);
      if (!chunk.ok) throw new Error(chunk.error.message);
      expect(byteSize(historyToolResult(chunk))).toBeLessThanOrEqual(
        MAX_HISTORY_TOOL_BYTES,
      );
      reconstructed += chunk.content.text;
      const last = chunk.content.text.charCodeAt(chunk.content.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      if (chunk.content.nextOffset === null) break;
      expect(chunk.content.nextOffset).toBeGreaterThan(offset);
      offset = chunk.content.nextOffset;
    }
    expect(reconstructed).toBe(
      JSON.stringify(entries.find((entry) => entry.id === large)),
    );
    expect(
      historyContent(history, large, reconstructed.indexOf("😀") + 1),
    ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(JSON.stringify(manager.getEntries())).toBe(original);
    manager.branch(correction);
    const appended = manager.appendMessage({
      role: "user",
      content: "newer activity",
      timestamp: 5,
    });
    const continued = historyPage(
      manager.getBranch(history.leafId!),
      2,
      2,
      wrap,
      describe,
    );
    if (!continued.ok) throw new Error(continued.error.message);
    expect(continued.value.entries.map((entry) => entry.id)).toEqual([
      correction,
    ]);
    expect(continued.value.entries.some((entry) => entry.id === appended)).toBe(
      false,
    );
    // A huge routing identity must fail closed, not loop on an empty chunk.
    expect(
      historyContent({ ...history, workspace: "x".repeat(100_000) }, large, 0),
    ).toMatchObject({ ok: false, error: { code: "output_limit" } });
    expect(historyPage([], 1, 1, wrap, describe)).toMatchObject({ ok: false });
  });

  it("bounds unexpected exceptions as well as native error outcomes", async () => {
    const output = await historyResponse(async () => {
      throw new Error("x".repeat(100_000));
    });
    expect(byteSize(output)).toBeLessThanOrEqual(MAX_HISTORY_TOOL_BYTES);
    expect(output.structuredContent).toMatchObject({
      ok: false,
      error: { code: "io" },
    });
  });

  it("marks preview truncation without corrupting routing identity or Unicode", () => {
    const input = {
      sessionId: "id",
      name: "n".repeat(600),
      firstMessage: "x".repeat(511) + "😀tail",
    } as SessionSummary;
    const result = previewSession(input);
    expect(result.sessionId).toBe("id");
    expect(result.firstMessage).toBe("x".repeat(511));
    expect(result.truncatedFields).toEqual(["name", "firstMessage"]);
    expect(input.firstMessage).toContain("😀tail");
  });
}
