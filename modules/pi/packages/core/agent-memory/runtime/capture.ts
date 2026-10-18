import type * as C from "./contracts.js";
import { sameValue } from "./identity.js";
import { parseWindow } from "./wire.js";
import { redact } from "../evidence.js";

function checkWindows(
  windows: readonly C.SourceWindow[],
  scope: C.MemoryScope,
): void {
  const seen = new Set<C.WindowId>();
  for (const value of windows) {
    const window = parseWindow(value);
    if (!sameValue(window.scope, scope))
      throw new Error("capture scope mismatch");
    if (seen.has(window.windowId))
      throw new Error("duplicate source window in page");
    seen.add(window.windowId);
    // redaction changes identity and byte offsets: require the producer to do it.
    if (window.excerpts.some((e) => redact(e.text).text !== e.text))
      throw new Error(
        "source must be redacted before window identity is assigned",
      );
  }
}

/** supplied windows own their data; no source producer or index is consulted. */
export const capture: C.CaptureHandler = async (
  input: C.CaptureInput,
  deps: {
    readonly store: C.MemoryStore;
    readonly producer?: C.SourceProducer;
    readonly signal?: AbortSignal;
  },
): Promise<C.CaptureOutcome> => {
  const retry = (reason: string): C.CaptureOutcome => ({
    kind: "retry",
    reason,
    retryAt: new Date(Date.parse(input.now) + 30_000).toISOString(),
  });
  let windows: readonly C.SourceWindow[];
  let continuation: C.SourceSpan | null = null;
  try {
    if (input.source.kind === "provided") {
      windows = input.source.windows;
    } else {
      const { request } = input.source;
      if (!sameValue(request.scope, input.scope))
        return {
          kind: "ineligible",
          reason: "request scope differs from authorized capture scope",
        };
      if (
        !Number.isSafeInteger(request.maxWindows) ||
        request.maxWindows < 1 ||
        !Number.isSafeInteger(request.maxWindowBytes) ||
        request.maxWindowBytes < 1
      )
        return { kind: "ineligible", reason: "invalid source limits" };
      if (!deps.producer || !deps.signal)
        throw new Error("read capture requires a source producer and signal");
      const collected: C.SourceWindow[] = [];
      let after = request.after;
      while (collected.length < request.maxWindows) {
        deps.signal.throwIfAborted();
        const page = await deps.producer.read(
          {
            ...request,
            after,
            maxWindows: request.maxWindows - collected.length,
          },
          deps.signal,
        );
        if (page.windows.length > request.maxWindows - collected.length)
          throw new Error("producer exceeded window budget");
        checkWindows(page.windows, input.scope);
        if (
          page.windows.some(
            (w) =>
              !sameValue(w.source, request.source) ||
              w.excerpts.reduce((n, e) => n + Buffer.byteLength(e.text), 0) >
                request.maxWindowBytes,
          )
        )
          throw new Error(
            "producer changed source identity or exceeded byte budget",
          );
        const last = page.windows.at(-1)?.excerpts.at(-1)?.span;
        if (
          (!page.complete &&
            (!last ||
              !sameValue(page.next, last) ||
              sameValue(after, page.next))) ||
          (page.complete && page.next !== null)
        )
          throw new Error("producer returned an invalid continuation");
        // contiguous byte parts cannot silently skip a segment within this page.
        let previous = after;
        for (const w of page.windows)
          for (const e of w.excerpts) {
            if (
              previous &&
              e.span.entryId === previous.entryId &&
              e.span.partId === previous.partId &&
              e.span.start !== previous.end
            )
              throw new Error("source byte coverage gap");
            previous = e.span;
          }
        collected.push(...page.windows);
        continuation = page.next;
        if (page.complete) break;
        after = page.next;
      }
      windows = collected;
    }
    checkWindows(windows, input.scope);
  } catch (error) {
    return retry(
      error instanceof Error ? error.message : "source capture failed",
    );
  }
  if (!windows.length) return { kind: "unchanged", windows: [], continuation };
  try {
    const result = await deps.store.commit({
      commitId: input.commitId,
      now: input.now,
      windows,
      edits: [],
      suppressions: [],
      outcomes: [],
      lease: null,
    });
    if (result.kind === "locally-committed")
      return result.replay
        ? {
            kind: "unchanged",
            windows: windows.map((w) => w.windowId),
            continuation,
          }
        : {
            kind: "locally-committed",
            commitId: input.commitId,
            windows: windows.map((w) => w.windowId),
            continuation,
          };
    return retry(`capture ${result.kind}`);
  } catch (error) {
    // publication may already be durable. replay the same id/payload; never ack a cursor here.
    return retry(
      error instanceof Error ? error.message : "capture acceptance failed",
    );
  }
};

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FileMemoryStore } = await import("./store.js");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { nativeSourceProducer, nativeSourceSnapshot } =
    await import("./pi-source.js");
  const now = "2026-01-01T00:00:00.000Z";
  const scope: C.MemoryScope = { kind: "personal", ownerId: "fixture" };
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "memory-capture-"));
    const config = {
      root: join(dir, "notes"),
      data: join(dir, "data"),
      state: join(dir, "state"),
      replicaId: "fixture" as C.ReplicaId,
      owner: "fixture",
    };
    const manager = SessionManager.inMemory(dir);
    const entry = manager.appendMessage({
      role: "user",
      content: "i chose the quiet room because sleep matters 🌿".repeat(8),
      timestamp: Date.parse(now),
    });
    const producer = nativeSourceProducer(
      { kind: "provided", snapshot: nativeSourceSnapshot(manager) },
      { capturedAt: now },
    );
    const request: C.SourceReadRequest = {
      source: {
        sourceId: "source" as C.SourceId,
        producer: "pi-native",
        origin: {
          kind: "session",
          sessionId: manager.getSessionId() as C.SessionId,
        },
      },
      scope,
      after: null,
      throughEntryId: entry as C.EntryId,
      maxWindowBytes: 40,
      maxWindows: 3,
    };
    return { config, producer, request, store: new FileMemoryStore(config) };
  }
  const signal = () => new AbortController().signal;
  const policy: C.BacklogPolicy = {
    minWindows: 1,
    maxPendingAgeMs: 1,
    maxBatchBytes: 100_000,
    maxBatchWindows: 100,
    leaseMs: 60_000,
  };
  it("provided data needs no producer; duplicate capture clocks retain one pending window", async () => {
    const f = fixture();
    try {
      const page = await f.producer.read(
        { ...f.request, maxWindows: 1 },
        signal(),
      );
      const input = {
        source: { kind: "provided" as const, windows: page.windows },
        scope,
        now,
        commitId: "capture" as C.CommitId,
      };
      expect((await capture(input, { store: f.store })).kind).toBe(
        "locally-committed",
      );
      expect((await capture(input, { store: f.store })).kind).toBe("unchanged");
      const later = "2026-01-01T00:01:00.000Z";
      expect(
        (
          await capture(
            {
              ...input,
              now: later,
              commitId: "duplicate" as C.CommitId,
              source: {
                kind: "provided",
                windows: page.windows.map((w) => ({ ...w, capturedAt: later })),
              },
            },
            { store: f.store },
          )
        ).kind,
      ).toBe("locally-committed");
      const plan = await f.store.plan({
        jobId: "job" as C.JobId,
        owner: "fixture",
        scope,
        now: later,
        policy,
      });
      expect(plan.kind).toBe("eligible");
      if (plan.kind === "eligible") {
        expect(plan.batch.windows).toHaveLength(1);
        expect(plan.batch.windows[0].pendingSince).toBe(now);
      }
      expect(
        await capture({ ...input, now: later }, { store: f.store }),
      ).toMatchObject({ kind: "retry", reason: "capture identity-conflict" });
    } finally {
      f.store.close();
    }
  });
  it("read mode caps total windows and returns the exact durable continuation", async () => {
    const f = fixture();
    try {
      const result = await capture(
        {
          source: { kind: "read", request: f.request },
          scope,
          now,
          commitId: "page" as C.CommitId,
        },
        { store: f.store, producer: f.producer, signal: signal() },
      );
      expect(result.kind).toBe("locally-committed");
      const page = await f.producer.read(f.request, signal());
      if (result.kind === "locally-committed") {
        expect(result.windows).toEqual(page.windows.map((w) => w.windowId));
        expect(result.continuation).toEqual(page.next);
      }
      const next = await capture(
        {
          source: { kind: "read", request: { ...f.request, after: page.next } },
          scope,
          now,
          commitId: "page2" as C.CommitId,
        },
        { store: f.store, producer: f.producer, signal: signal() },
      );
      expect(next.kind).toBe("locally-committed");
      const plan = await f.store.plan({
        jobId: "job" as C.JobId,
        owner: "fixture",
        scope,
        now,
        policy,
      });
      if (plan.kind !== "eligible") throw new Error("missing captured windows");
      expect(plan.batch.windows).toHaveLength(6);
    } finally {
      f.store.close();
    }
  });
  it("ambiguous crash after acceptance returns no cursor, then exact replay recovers coverage", async () => {
    const f = fixture();
    f.store.close();
    let fail = true;
    f.store = new FileMemoryStore({
      ...f.config,
      publicationBoundary: (boundary) => {
        if (boundary === "manifest" && fail) {
          fail = false;
          throw new Error("fixture crash after manifest");
        }
      },
    });
    const input = {
      source: { kind: "read" as const, request: f.request },
      scope,
      now,
      commitId: "crash" as C.CommitId,
    };
    expect(
      await capture(input, {
        store: f.store,
        producer: f.producer,
        signal: signal(),
      }),
    ).toMatchObject({ kind: "retry" });
    f.store.close();
    f.store = new FileMemoryStore(f.config);
    try {
      const replay = await capture(input, {
        store: f.store,
        producer: f.producer,
        signal: signal(),
      });
      expect(replay.kind).toBe("unchanged");
      const plan = await f.store.plan({
        jobId: "job" as C.JobId,
        owner: "fixture",
        scope,
        now,
        policy,
      });
      if (plan.kind !== "eligible")
        throw new Error("lost capture after restart");
      expect(plan.batch.windows).toHaveLength(3);
    } finally {
      f.store.close();
    }
  });
  it("coverage and scope negative controls reject isolated bad producer payloads", async () => {
    const f = fixture();
    try {
      const page = await f.producer.read(f.request, signal());
      const bad: C.SourceProducer = {
        read: async () => ({
          ...page,
          windows: [page.windows[0]!, page.windows[2]!],
          next: page.windows[2]!.excerpts[0].span,
        }),
      };
      const input = {
        source: { kind: "read" as const, request: f.request },
        scope,
        now,
        commitId: "bad" as C.CommitId,
      };
      expect(
        await capture(input, {
          store: f.store,
          producer: bad,
          signal: signal(),
        }),
      ).toMatchObject({ kind: "retry", reason: "source byte coverage gap" });
      expect(
        await capture(
          { ...input, scope: { kind: "project", repositoryId: "injected" } },
          { store: f.store, producer: f.producer, signal: signal() },
        ),
      ).toMatchObject({ kind: "ineligible" });
      expect(
        await f.store.plan({
          jobId: "job" as C.JobId,
          owner: "fixture",
          scope,
          now,
          policy,
        }),
      ).toMatchObject({ kind: "idle", reason: "empty" });
    } finally {
      f.store.close();
    }
  });
}
