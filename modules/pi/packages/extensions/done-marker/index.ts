import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "@bds_pi/done-marker";

type DoneMarkerData = {
  durationMs: number;
};

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${seconds}s`]
    .filter(Boolean)
    .join(" ");
}

function formatDoneTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  });
}

export default function doneMarkerExtension(pi: ExtensionAPI): void {
  let startedAt: number | undefined;

  pi.registerEntryRenderer<DoneMarkerData>(
    ENTRY_TYPE,
    (entry, _options, theme) => {
      const durationMs = entry.data?.durationMs;
      if (typeof durationMs !== "number" || !Number.isFinite(durationMs))
        return undefined;
      return new Text(
        theme.fg(
          "dim",
          `${formatDuration(durationMs)} · done ${formatDoneTime(entry.timestamp)}`,
        ),
        0,
        0,
      );
    },
  );

  pi.on("agent_start", () => {
    startedAt ??= Date.now();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (startedAt === undefined || !ctx.isIdle()) return;
    const durationMs = Date.now() - startedAt;
    startedAt = undefined;
    pi.appendEntry<DoneMarkerData>(ENTRY_TYPE, { durationMs });
  });
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;

  function harness() {
    const handlers = new Map<string, (...args: any[]) => void>();
    const entries: Array<{
      customType: string;
      data: DoneMarkerData;
      timestamp: string;
    }> = [];
    let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
    const pi = {
      on: (event: string, handler: (...args: any[]) => void) =>
        handlers.set(event, handler),
      appendEntry: (customType: string, data: DoneMarkerData) =>
        entries.push({
          customType,
          data,
          timestamp: new Date().toISOString(),
        }),
      registerEntryRenderer: (
        _customType: string,
        nextRenderer: (entry: any, options: any, theme: any) => any,
      ) => {
        renderer = nextRenderer;
      },
    } as unknown as ExtensionAPI;
    doneMarkerExtension(pi);
    return { entries, handlers, renderer: () => renderer! };
  }

  afterEach(() => vi.useRealTimers());

  describe("done marker", () => {
    it("renders one marker only after the complete run becomes idle", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 26, 1, 21, 10));
      const h = harness();
      let idle = true;
      const ctx = { isIdle: () => idle };

      h.handlers.get("agent_settled")!({}, ctx);
      h.handlers.get("agent_start")!({});
      vi.advanceTimersByTime(10_000);
      h.handlers.get("agent_start")!({});
      vi.advanceTimersByTime(100_000);

      idle = false;
      h.handlers.get("agent_settled")!({}, ctx);
      expect(h.entries).toHaveLength(0);
      idle = true;
      h.handlers.get("agent_settled")!({}, ctx);
      h.handlers.get("agent_settled")!({}, ctx);

      expect(h.entries).toHaveLength(1);
      const component = h.renderer()(
        h.entries[0],
        {},
        { fg: (_color: string, text: string) => text },
      );
      expect(
        component.render(80).map((line: string) => line.trimEnd()),
      ).toEqual(["1m 50s · done 01:23"]);
    });
  });
}
