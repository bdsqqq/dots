import {
  InMemoryTelemetryContext,
  NOOP_TELEMETRY_CONTEXT,
  type SpanOptions,
  type StoredSpan,
  type TelemetryCarrier,
  type TelemetryContext,
  type TelemetrySpan,
} from "@earendil-works/pi-telemetry";

export const MAX_SPANS = 2048;
export const MAX_ACTIVE = 128;

/** A recorder per operation avoids retaining finished spans for the process lifetime.
 * The reference runtime owns settlement, clocks, identities, links and propagation.
 * This adapter owns admission and the native journal sink, not another span format.
 */
export class JournalTelemetry implements TelemetryContext {
  private readonly codec = new InMemoryTelemetryContext();
  private readonly handles = new WeakMap<TelemetryContext, TelemetryContext>();
  private allocated = 0;
  private active = 0;
  dropped = 0;
  sinkFailures = 0;
  readonly propagation: {
    inject: (context: TelemetryContext) => TelemetryCarrier | undefined;
    extract: (carrier: TelemetryCarrier | undefined) => TelemetryContext;
  } = {
    inject: (context) =>
      this.codec.inject(this.handles.get(context) ?? context),
    extract: (carrier) => this.context(this.codec.extract(carrier)),
  };

  constructor(private readonly append: (span: StoredSpan) => void) {}

  private context(
    parent?: TelemetryContext,
    settled = () => false,
  ): TelemetryContext {
    const context: TelemetryContext = {
      propagation: this.propagation,
      startSpan: (options, callback) =>
        this.start(options, callback, parent, settled()),
    };
    if (parent) this.handles.set(context, parent);
    return context;
  }

  startSpan<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    return this.start(options, callback);
  }

  private async start<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
    parent?: TelemetryContext,
    inert = false,
  ): Promise<T> {
    if (inert || this.allocated >= MAX_SPANS || this.active >= MAX_ACTIVE) {
      if (!inert) this.dropped++;
      const noop = (): TelemetrySpan => ({
        ...NOOP_TELEMETRY_CONTEXT,
        metrics: undefined,
        propagation: this.propagation,
        startSpan: async (_options, cb) => cb(noop()),
        addLink() {},
        addEvent() {},
        setAttributes() {},
        setStatus() {},
      });
      return callback(noop());
    }
    this.allocated++;
    this.active++;
    const recorder = new InMemoryTelemetryContext();
    let ended = false;
    const result = recorder
      .extract(parent ? this.propagation.inject(parent) : undefined)
      .startSpan(
        {
          ...options,
          links: options.links?.map((link) => ({
            ...link,
            context: this.handles.get(link.context) ?? link.context,
          })),
        },
        (raw) => {
          const span: TelemetrySpan = {
            ...this.context(raw, () => ended),
            addLink: (link) =>
              raw.addLink({
                ...link,
                context: this.handles.get(link.context) ?? link.context,
              }),
            addEvent: (name, attributes) => raw.addEvent(name, attributes),
            setAttributes: (attributes) => raw.setAttributes(attributes),
            setStatus: (status) => raw.setStatus(status),
          };
          this.handles.set(span, raw);
          return callback(span);
        },
      );
    try {
      return await result;
    } finally {
      ended = true;
      this.active--;
      // Exactly one span lives in this recorder; copying it is constant work.
      const stored = (await recorder.findTraces()).traces[0]?.spans[0];
      if (stored) {
        try {
          this.append(stored);
        } catch {
          this.sinkFailures++;
        }
      }
    }
  }
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  const { createTelemetryAdapterConformance } =
    await import("@earendil-works/pi-telemetry/testing");
  const { renderTrace } = await import("@earendil-works/pi-telemetry/render");
  const cases = createTelemetryAdapterConformance(async () => {
    const stored: StoredSpan[] = [];
    const context = new JournalTelemetry((span) => stored.push(span));
    const ids = new Map<string, number>();
    const local = (id: string) => {
      if (!ids.has(id)) ids.set(id, ids.size + 1);
      return ids.get(id)!;
    };
    const carrier = (id: string, trace: string): TelemetryCarrier => {
      const split = id.lastIndexOf(":");
      return {
        "pi-memory-scope": id.slice(0, split),
        "pi-memory-span": id.slice(split + 1),
        "pi-memory-trace": trace,
      };
    };
    return {
      context,
      propagation: context.propagation,
      getSpans: async () =>
        stored.map((span, index) => ({
          id: local(span.id),
          parentId: span.parentId ? local(span.parentId) : null,
          context: carrier(span.id, span.traceId),
          parentContext: span.parentId
            ? carrier(span.parentId, span.traceId)
            : null,
          name: span.name,
          attributes: span.attributes,
          events: span.events.map(({ name, attributes }) => ({
            name,
            attributes,
          })),
          links: span.links.map((link) => ({
            context: carrier(link.spanId, link.traceId),
            attributes: link.attributes ?? {},
          })),
          status: span.status,
          settled: true,
          endSequence: index + 1,
        })),
      async [Symbol.asyncDispose]() {},
    };
  });
  for (const c of cases) it(`${c.group}: ${c.name}`, () => c.run());
  it("bounds admission, keeps callback results, and contains sink failure", async () => {
    const spans: StoredSpan[] = [];
    const context = new JournalTelemetry((span) => spans.push(span));
    for (let i = 0; i < MAX_SPANS + 5; i++)
      expect(await context.startSpan({ name: "bounded" }, () => 42)).toBe(42);
    expect(spans).toHaveLength(MAX_SPANS);
    expect(context.dropped).toBe(5);
    expect(renderTrace(spans.slice(0, 1))).toContain("bounded");
    const failing = new JournalTelemetry(() => {
      throw new Error("PRIVATE_SINK");
    });
    expect(await failing.startSpan({ name: "safe" }, () => 7)).toBe(7);
    expect(failing.sinkFailures).toBe(1);
  });
}
