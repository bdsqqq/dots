/** renders a private recap after a settled session remains idle. */

import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  completeBackgroundText,
  type BackgroundComplete,
} from "@bds_pi/background-completion";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
  updateGlobalExtensionConfig,
} from "@bds_pi/config";

const CONFIG_NAMESPACE = "@bds_pi/session-recap";
const ENTRY_TYPE = "@bds_pi/session-recap";
const AUTHORED_INPUT_CHARS = 12_000;
const RECAP_PROMPT = `Write only a terse session recap.

Hard constraints:
- At most {{maxWords}} words in one plain-text paragraph.
- Use lowercase prose; preserve exact casing only for code, paths, commands, branches, and product names.
- Lead with concrete completed work or current state. End with "next: ..." only when the transcript states a next step.
- Include verification, commit state, failures, and blockers only when explicitly stated and relevant.
- No first or second person. Never say "the agent".
- No praise, framing, throat-clearing, hedging, filler, headings, bullets, markdown, or instructions to the reader.
- Never infer progress, intent, causality, success, or a next step. Omit anything unsupported.`;

type SessionRecapConfig = {
  idleMs: number;
  maxWords: number;
  model: { provider: string; id: string };
};

type RecapEntryData = {
  version: 1;
  throughLeafId: string;
  text: string;
  idleMs: number;
  title?: string;
};

const CONFIG_DEFAULTS: SessionRecapConfig = {
  idleMs: 120_000,
  maxWords: 55,
  model: { provider: "openai-codex", id: "gpt-5.6-luna" },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionRecapConfig(
  value: Record<string, unknown>,
): value is SessionRecapConfig {
  return (
    Number.isInteger(value.idleMs) &&
    (value.idleMs as number) >= 1_000 &&
    Number.isInteger(value.maxWords) &&
    (value.maxWords as number) >= 20 &&
    (value.maxWords as number) <= 100 &&
    isPlainObject(value.model) &&
    typeof value.model.provider === "string" &&
    value.model.provider.trim().length > 0 &&
    typeof value.model.id === "string" &&
    value.model.id.trim().length > 0
  );
}

const CONFIG_SCHEMA: ExtensionConfigSchema<SessionRecapConfig> = {
  validate: isSessionRecapConfig,
};

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isPlainObject(part) &&
        part.type === "text" &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function authoredText(entries: SessionEntry[]): string {
  const sections: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentText(entry.message.content);
    if (text) sections.push(`${role}:\n${text}`);
  }
  return sections.join("\n\n");
}

function authoredLeafId(entries: SessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (
      entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant")
    )
      return entry.id;
  }
  return null;
}

function recapEntryData(value: unknown): RecapEntryData | null {
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    typeof value.throughLeafId !== "string" ||
    typeof value.text !== "string" ||
    !Number.isInteger(value.idleMs) ||
    (value.idleMs as number) < 1_000 ||
    (value.title !== undefined && typeof value.title !== "string")
  )
    return null;
  return value as RecapEntryData;
}

function hasRecap(entries: SessionEntry[], throughLeafId: string): boolean {
  return entries.some(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === ENTRY_TYPE &&
      recapEntryData(entry.data)?.throughLeafId === throughLeafId,
  );
}

function parseRecap(text: string, maxWords: number): string | null {
  const normalized = text
    .trim()
    .replace(/^(?:※\s*)?recap\s*:\s*/i, "")
    .replace(/\s+/g, " ");
  if (!normalized) return null;
  const words = normalized.split(" ");
  return words.length > maxWords
    ? `${words.slice(0, maxWords).join(" ")}…`
    : normalized;
}

function idleLabel(idleMs: number): string {
  if (idleMs < 60_000) return `${Math.round(idleMs / 1_000)}s idle`;
  return `${Math.round(idleMs / 60_000)}m idle`;
}

type GenerateOutcome =
  | "appended"
  | "current"
  | "failed"
  | "stale"
  | "unavailable";

export function createSessionRecapExtension(
  deps: {
    complete?: BackgroundComplete;
    updateConfig?: typeof updateGlobalExtensionConfig;
  } = {},
): (pi: ExtensionAPI) => void {
  return function sessionRecapExtension(pi: ExtensionAPI): void {
    const initial = getEnabledExtensionConfig(
      CONFIG_NAMESPACE,
      CONFIG_DEFAULTS,
      { schema: CONFIG_SCHEMA },
    );
    const config = initial.config;
    let enabled = initial.enabled;
    let timer: NodeJS.Timeout | undefined;
    let generation = 0;
    let controller: AbortController | undefined;

    const cancelPending = (): void => {
      generation++;
      if (timer) clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      controller = undefined;
    };

    const generate = async (
      ctx: ExtensionContext,
      expectedGeneration: number,
    ): Promise<GenerateOutcome> => {
      if (generation !== expectedGeneration || !ctx.isIdle()) return "stale";
      const branch = ctx.sessionManager.getBranch();
      const throughLeafId = authoredLeafId(branch);
      if (!throughLeafId) return "unavailable";
      const authoredLeaf = branch.find((entry) => entry.id === throughLeafId);
      if (
        authoredLeaf?.type !== "message" ||
        authoredLeaf.message.role !== "assistant" ||
        authoredLeaf.message.stopReason !== "stop" ||
        !contentText(authoredLeaf.message.content)
      )
        return "unavailable";
      if (hasRecap(branch, throughLeafId)) return "current";
      const transcript = authoredText(branch).slice(-AUTHORED_INPUT_CHARS);
      if (!transcript) return "unavailable";
      const sessionId = ctx.sessionManager.getSessionId();
      const model =
        ctx.modelRegistry.find(config.model.provider, config.model.id) ??
        ctx.model;
      if (!model) return "unavailable";

      const activeController = new AbortController();
      controller = activeController;
      let output: string | null;
      try {
        output = await completeBackgroundText(
          deps.complete,
          model,
          ctx.modelRegistry,
          `${RECAP_PROMPT.replace("{{maxWords}}", String(config.maxWords))}\n\nTranscript:\n${transcript}`,
          180,
          activeController.signal,
        );
      } catch {
        return activeController.signal.aborted ? "stale" : "failed";
      } finally {
        if (controller === activeController) controller = undefined;
      }
      const text = output && parseRecap(output, config.maxWords);
      if (!text) return "failed";
      if (generation !== expectedGeneration || !ctx.isIdle()) return "stale";
      const currentBranch = ctx.sessionManager.getBranch();
      if (
        ctx.sessionManager.getSessionId() !== sessionId ||
        authoredLeafId(currentBranch) !== throughLeafId ||
        !currentBranch.some((entry) => entry.id === throughLeafId) ||
        hasRecap(currentBranch, throughLeafId)
      )
        return "stale";

      const title = pi.getSessionName()?.trim() || undefined;
      pi.appendEntry(ENTRY_TYPE, {
        version: 1,
        throughLeafId,
        text,
        idleMs: config.idleMs,
        ...(title ? { title } : {}),
      } satisfies RecapEntryData);
      return "appended";
    };

    const schedule = (ctx: ExtensionContext): void => {
      cancelPending();
      if (!enabled || !ctx.isIdle()) return;
      const branch = ctx.sessionManager.getBranch();
      const throughLeafId = authoredLeafId(branch);
      if (!throughLeafId || hasRecap(branch, throughLeafId)) return;
      const expectedGeneration = generation;
      timer = setTimeout(() => {
        timer = undefined;
        void generate(ctx, expectedGeneration).catch(() => {});
      }, config.idleMs);
      timer.unref();
    };

    pi.registerEntryRenderer<RecapEntryData>(
      ENTRY_TYPE,
      (entry, _options, theme) => {
        const data = recapEntryData(entry.data);
        if (!data) return undefined;
        const metadata = [
          "※ recap",
          data.title?.trim(),
          idleLabel(data.idleMs),
        ].filter((part): part is string => Boolean(part));
        const content = new Container();
        content.addChild(
          new Text(theme.fg("muted", metadata.join(" · ")), 0, 0),
        );
        content.addChild(
          new Text(
            theme.fg("dim", `${data.text}  /recap off`),
            2,
            0,
          ),
        );
        return content;
      },
    );

    pi.registerCommand("recap", {
      description: "Show or configure idle session recaps",
      getArgumentCompletions: (prefix) => {
        const values = ["now", "on", "off", "status"];
        const matches = values
          .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
          .map((value) => ({ value, label: value }));
        return matches.length ? matches : null;
      },
      handler: async (args, ctx) => {
        const action = args.trim().toLowerCase() || "status";
        if (action === "status") {
          ctx.ui.notify(
            `recaps ${enabled ? "on" : "off"} · ${idleLabel(config.idleMs)} · ${config.model.provider}/${config.model.id}`,
            "info",
          );
          return;
        }
        if (action === "on" || action === "off") {
          const nextEnabled = action === "on";
          try {
            (deps.updateConfig ?? updateGlobalExtensionConfig)(
              CONFIG_NAMESPACE,
              {
                enabled: nextEnabled,
              },
            );
          } catch (error) {
            ctx.ui.notify(
              `could not persist recap setting: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            return;
          }
          enabled = nextEnabled;
          if (enabled) schedule(ctx);
          else cancelPending();
          ctx.ui.notify(`recaps ${action}`, "info");
          return;
        }
        if (action === "now") {
          cancelPending();
          await ctx.waitForIdle();
          cancelPending();
          const outcome = await generate(ctx, generation).catch(
            () => "failed" as const,
          );
          if (outcome === "current")
            ctx.ui.notify("recap already current", "info");
          else if (outcome !== "appended") {
            ctx.ui.notify("could not generate recap", "warning");
            if (enabled) schedule(ctx);
          }
          return;
        }
        schedule(ctx);
        ctx.ui.notify("usage: /recap now|on|off|status", "warning");
      },
    });

    pi.on("input", cancelPending);
    pi.on("before_agent_start", cancelPending);
    pi.on("agent_settled", (_event, ctx) => schedule(ctx));
    pi.on("session_before_switch", (_event, ctx) => schedule(ctx));
    pi.on("session_before_fork", (_event, ctx) => schedule(ctx));
    pi.on("session_tree", (_event, ctx) => schedule(ctx));
    pi.on("session_start", (_event, ctx) => schedule(ctx));
    pi.on("session_shutdown", cancelPending);
  };
}

const sessionRecapExtension: (pi: ExtensionAPI) => void =
  createSessionRecapExtension();
export default sessionRecapExtension;

if (import.meta.vitest) {
  const { afterEach, beforeEach, describe, expect, it, vi } = import.meta
    .vitest;
  const missingConfig = path.join(
    os.tmpdir(),
    `pi-session-recap-missing-${process.pid}.json`,
  );

  function user(id: string, text: string): SessionEntry {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: 1,
      },
    } as SessionEntry;
  }

  function assistant(id: string, text: string): SessionEntry {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        timestamp: 1,
      },
    } as SessionEntry;
  }

  function harness(branch: SessionEntry[]) {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    const renderers = new Map<string, (...args: any[]) => any>();
    const commands = new Map<string, any>();
    const appended: Array<{ customType: string; data: RecapEntryData }> = [];
    const model = { id: "test", provider: "test" } as Model<Api>;
    let idle = true;
    const pi = {
      on: (event: string, handler: (event: any, ctx: any) => any) =>
        handlers.set(event, handler),
      registerEntryRenderer: (
        type: string,
        renderer: (...args: any[]) => any,
      ) => renderers.set(type, renderer),
      registerCommand: (name: string, command: any) =>
        commands.set(name, command),
      getSessionName: () => "async metal execution",
      appendEntry: (customType: string, data: RecapEntryData) => {
        appended.push({ customType, data });
        branch.push({
          type: "custom",
          id: `recap-${appended.length}`,
          parentId: branch.at(-1)?.id ?? null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        });
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      model,
      isIdle: () => idle,
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "session-1",
      },
      modelRegistry: {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
      },
      waitForIdle: async () => {},
      ui: { notify: vi.fn() },
    };
    return {
      pi,
      ctx,
      handlers,
      renderers,
      commands,
      appended,
      setIdle: (value: boolean) => {
        idle = value;
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clearConfigCache();
    setGlobalSettingsPath(missingConfig);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearConfigCache();
  });

  describe("session recap", () => {
    it("appends and renders a private recap only after two idle minutes", async () => {
      const branch = [
        user("u1", "implement the async slice"),
        assistant("a1", "implemented it; checks pass; next open the pr"),
      ];
      const complete = vi.fn().mockResolvedValue({
        stopReason: "stop",
        content: [
          { type: "text", text: "work is complete; next open the pr." },
        ],
      });
      const h = harness(branch);
      createSessionRecapExtension({
        complete: complete as BackgroundComplete,
      })(h.pi);

      h.handlers.get("agent_settled")?.({}, h.ctx);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(complete).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(h.appended).toEqual([
        {
          customType: ENTRY_TYPE,
          data: {
            version: 1,
            throughLeafId: "a1",
            text: "work is complete; next open the pr.",
            idleMs: 120_000,
            title: "async metal execution",
          },
        },
      ]);
      const component = h.renderers.get(ENTRY_TYPE)?.(
        { data: h.appended[0]!.data },
        { expanded: false },
        { fg: (_color: string, text: string) => text },
      );
      expect(
        component.render(100).map((line: string) => line.trimEnd()),
      ).toEqual([
        "※ recap · async metal execution · 2m idle",
        "  work is complete; next open the pr.  /recap off",
      ]);
      expect(
        component.render(43).map((line: string) => line.trimEnd()),
      ).toEqual([
        "※ recap · async metal execution · 2m idle",
        "  work is complete; next open the pr.",
        "  /recap off",
      ]);
    });

    it("does not spend a model call after new submitted activity", async () => {
      const branch = [user("u1", "goal"), assistant("a1", "done")];
      const complete = vi.fn();
      const h = harness(branch);
      createSessionRecapExtension({
        complete: complete as BackgroundComplete,
      })(h.pi);

      h.handlers.get("agent_settled")?.({}, h.ctx);
      await vi.advanceTimersByTimeAsync(60_000);
      h.handlers.get("input")?.({}, h.ctx);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(complete).not.toHaveBeenCalled();
      expect(h.appended).toEqual([]);
    });

    it("does not infer progress without a visible final response", async () => {
      const branch = [user("u1", "goal")];
      const complete = vi.fn();
      const h = harness(branch);
      createSessionRecapExtension({
        complete: complete as BackgroundComplete,
      })(h.pi);

      h.handlers.get("agent_settled")?.({}, h.ctx);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(complete).not.toHaveBeenCalled();
      expect(h.appended).toEqual([]);
    });

    it("does not treat an aborted partial response as completed work", async () => {
      const partial = assistant("a1", "partially changed the implementation");
      if (partial.type === "message" && partial.message.role === "assistant")
        partial.message.stopReason = "aborted";
      const branch = [user("u1", "goal"), partial];
      const complete = vi.fn();
      const h = harness(branch);
      createSessionRecapExtension({
        complete: complete as BackgroundComplete,
      })(h.pi);

      h.handlers.get("agent_settled")?.({}, h.ctx);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(complete).not.toHaveBeenCalled();
      expect(h.appended).toEqual([]);
    });

    it("keeps the idle timer armed when checking recap status", async () => {
      const branch = [user("u1", "goal"), assistant("a1", "done")];
      const complete = vi.fn().mockResolvedValue({
        stopReason: "stop",
        content: [{ type: "text", text: "done; next verify." }],
      });
      const h = harness(branch);
      createSessionRecapExtension({
        complete: complete as BackgroundComplete,
      })(h.pi);

      h.handlers.get("agent_settled")?.({}, h.ctx);
      await vi.advanceTimersByTimeAsync(60_000);
      await h.commands.get("recap").handler("status", h.ctx);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(complete).toHaveBeenCalledOnce();
      expect(h.appended).toHaveLength(1);
    });

    it("restarts the idle window after successful tree navigation", async () => {
      const branch = [user("u1", "goal"), assistant("a1", "done")];
      const complete = vi.fn().mockResolvedValue({
        stopReason: "stop",
        content: [{ type: "text", text: "done; next verify." }],
      });
      const h = harness(branch);
      createSessionRecapExtension({
        complete: complete as BackgroundComplete,
      })(h.pi);

      h.handlers.get("agent_settled")?.({}, h.ctx);
      await vi.advanceTimersByTimeAsync(60_000);
      h.handlers.get("session_tree")?.({}, h.ctx);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(complete).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(complete).toHaveBeenCalledOnce();
      expect(h.appended).toHaveLength(1);
    });

    it("arms a resumed settled session", async () => {
      const branch = [user("u1", "goal"), assistant("a1", "done")];
      const complete = vi.fn().mockResolvedValue({
        stopReason: "stop",
        content: [{ type: "text", text: "done; next verify." }],
      });
      const h = harness(branch);
      createSessionRecapExtension({
        complete: complete as BackgroundComplete,
      })(h.pi);

      h.handlers.get("session_start")?.({ reason: "resume" }, h.ctx);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(complete).toHaveBeenCalledOnce();
      expect(h.appended).toHaveLength(1);
    });

    it("keeps an enabled timer when a toggle cannot be persisted", async () => {
      const branch = [user("u1", "goal"), assistant("a1", "done")];
      const complete = vi.fn().mockResolvedValue({
        stopReason: "stop",
        content: [{ type: "text", text: "done; next verify." }],
      });
      const h = harness(branch);
      createSessionRecapExtension({
        complete: complete as BackgroundComplete,
        updateConfig: () => {
          throw new Error("read-only");
        },
      })(h.pi);

      h.handlers.get("agent_settled")?.({}, h.ctx);
      await vi.advanceTimersByTimeAsync(60_000);
      await h.commands.get("recap").handler("off", h.ctx);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(complete).toHaveBeenCalledOnce();
      expect(h.appended).toHaveLength(1);
    });

    it("rearms automatic generation after /recap now fails", async () => {
      const branch = [user("u1", "goal"), assistant("a1", "done")];
      const complete = vi
        .fn()
        .mockResolvedValueOnce({
          stopReason: "error",
          content: [],
        })
        .mockResolvedValueOnce({
          stopReason: "stop",
          content: [{ type: "text", text: "done; next verify." }],
        });
      const h = harness(branch);
      createSessionRecapExtension({
        complete: complete as BackgroundComplete,
      })(h.pi);

      await h.commands.get("recap").handler("now", h.ctx);
      expect(h.appended).toEqual([]);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(complete).toHaveBeenCalledTimes(2);
      expect(h.appended).toHaveLength(1);
    });

    it("discards a completion aborted by a new agent run", async () => {
      const branch = [user("u1", "goal"), assistant("a1", "done")];
      const complete = vi.fn(
        (
          _model: Model<Api>,
          _context: unknown,
          options: { signal?: AbortSignal },
        ) =>
          new Promise((resolve) => {
            options.signal?.addEventListener("abort", () =>
              resolve({
                stopReason: "stop",
                content: [{ type: "text", text: "stale recap" }],
              }),
            );
          }),
      );
      const h = harness(branch);
      createSessionRecapExtension({
        complete: complete as BackgroundComplete,
      })(h.pi);

      h.handlers.get("agent_settled")?.({}, h.ctx);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(complete).toHaveBeenCalledOnce();
      h.setIdle(false);
      h.handlers.get("before_agent_start")?.({}, h.ctx);
      await vi.waitFor(() => expect(h.appended).toEqual([]));
    });
  });
}
