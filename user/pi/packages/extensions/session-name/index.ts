/** auto-names sessions immediately, then checkpoints and summarizes settled turns. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import type { Api, Model, Message } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { clearSessionMentionCache } from "@bds_pi/mentions";

type SessionNameExtConfig = {
  model: { provider: string; id: string };
  renameInterval: number;
};

const CONFIG_DEFAULTS: SessionNameExtConfig = {
  model: { provider: "openai-codex", id: "gpt-5.6-luna" },
  renameInterval: 10,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionNameConfig(
  value: Record<string, unknown>,
): value is SessionNameExtConfig {
  return (
    Number.isInteger(value.renameInterval) &&
    (value.renameInterval as number) >= 1 &&
    isPlainObject(value.model) &&
    typeof value.model.provider === "string" &&
    value.model.provider.trim().length > 0 &&
    typeof value.model.id === "string" &&
    value.model.id.trim().length > 0
  );
}

const SESSION_NAME_CONFIG_SCHEMA: ExtensionConfigSchema<SessionNameExtConfig> =
  {
    validate: isSessionNameConfig,
  };
const CHECKPOINT_ENTRY_TYPE = "@bds_pi/agent-memory/checkpoint";
const SUMMARY_ENTRY_TYPE = "@bds_pi/session-name/summary";
const SUMMARY_MAX_CHARS = 8_000;

type SessionSummaryEntryData = {
  version: 1;
  title: string;
  summary: string;
  throughLeafId: string;
  acceptedUserTurns: number;
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

function acceptedUserTurnCount(entries: SessionEntry[]): number {
  return entries.filter(
    (entry) => entry.type === "message" && entry.message.role === "user",
  ).length;
}

function completedAuthoredLeafId(entries: SessionEntry[]): string | null {
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

function alreadyCheckpointed(
  entries: SessionEntry[],
  throughLeafId: string,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === CHECKPOINT_ENTRY_TYPE &&
      isPlainObject(entry.data) &&
      entry.data.version === 1 &&
      entry.data.throughLeafId === throughLeafId,
  );
}

function validSummary(entry: SessionEntry): SessionSummaryEntryData | null {
  if (
    entry.type !== "custom" ||
    entry.customType !== SUMMARY_ENTRY_TYPE ||
    !isPlainObject(entry.data)
  ) {
    return null;
  }
  const data = entry.data;
  return data.version === 1 &&
    typeof data.title === "string" &&
    typeof data.summary === "string" &&
    typeof data.throughLeafId === "string" &&
    Number.isInteger(data.acceptedUserTurns) &&
    (data.acceptedUserTurns as number) >= 1
    ? (data as SessionSummaryEntryData)
    : null;
}

function latestSummary(
  entries: SessionEntry[],
): SessionSummaryEntryData | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const summary = validSummary(entries[index]!);
    if (summary) return summary;
  }
  return null;
}

function summaryDue(
  acceptedUserTurns: number,
  previous: SessionSummaryEntryData | null,
  interval: number,
): boolean {
  return previous
    ? acceptedUserTurns - previous.acceptedUserTurns >= interval
    : (acceptedUserTurns - 1) % interval === 0;
}

function visibleAuthoredText(entries: SessionEntry[]): string {
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

function buildSummaryInput(branch: SessionEntry[]): string {
  return visibleAuthoredText(branch);
}

function parseTitle(text: string): string | null {
  const title = text
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, " ");
  const words = title.split(" ");
  return words.length >= 3 && words.length <= 5 && title.length <= 80
    ? title.toLowerCase()
    : null;
}

function parseSummary(text: string): string | null {
  const summary = text.trim();
  return summary ? summary.slice(0, SUMMARY_MAX_CHARS) : null;
}

type Complete = typeof piAiCompat.complete;

async function modelText(
  complete: Complete,
  model: Model<Api>,
  registry: ExtensionContext["modelRegistry"],
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || (!auth.apiKey && !auth.headers)) return null;
  const message: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };
  const response = await complete(
    model,
    { messages: [message] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      maxTokens,
      reasoningEffort: "low",
    },
  );
  if (response.stopReason !== "stop") return null;
  return response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function sessionNameExtension(
  pi: ExtensionAPI,
  complete: Complete = piAiCompat.complete,
): void {
  const { enabled, config: cfg } = getEnabledExtensionConfig(
    "@bds_pi/session-name",
    CONFIG_DEFAULTS,
    { schema: SESSION_NAME_CONFIG_SCHEMA },
  );
  if (!enabled) return;

  let titleController: AbortController | undefined;
  let titleGeneration = 0;
  const abortTitle = () => {
    titleGeneration++;
    titleController?.abort();
    titleController = undefined;
  };

  pi.on("input", (event, ctx) => {
    const pendingPrompt = event.text.trim();
    if (pendingPrompt.startsWith("/") || pendingPrompt.length < 10) return;
    const branch = ctx.sessionManager.getBranch();
    const predictedTurns = acceptedUserTurnCount(branch) + 1;
    if (predictedTurns !== 1 && (predictedTurns - 1) % cfg.renameInterval !== 0)
      return;
    const model =
      ctx.modelRegistry.find(cfg.model.provider, cfg.model.id) ?? ctx.model;
    if (!model) return;
    abortTitle();
    const generation = titleGeneration;
    const controller = new AbortController();
    titleController = controller;
    const originalName = pi.getSessionName() || undefined;
    const branchText =
      `${visibleAuthoredText(branch)}\n\nuser:\n${pendingPrompt}`.slice(
        -12_000,
      );
    const input =
      predictedTurns === 1 ? pendingPrompt.slice(0, 2_000) : branchText;
    void modelText(
      complete,
      model,
      ctx.modelRegistry,
      `Return only a 3-5 word lowercase coding-session title.\n\n${input}`,
      20,
      controller.signal,
    )
      .then((output) => {
        const title = output && parseTitle(output);
        if (
          title &&
          generation === titleGeneration &&
          (pi.getSessionName() || undefined) === originalName
        )
          pi.setSessionName(title);
      })
      .catch(() => {})
      .finally(() => {
        if (generation === titleGeneration) titleController = undefined;
      });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const throughLeafId = completedAuthoredLeafId(branch);
    if (!throughLeafId) return;
    const acceptedUserTurns = acceptedUserTurnCount(branch);
    if (acceptedUserTurns < 1) return;
    if (alreadyCheckpointed(branch, throughLeafId)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
      version: 1,
      throughLeafId,
      acceptedUserTurns,
    });

    const previous = latestSummary(branch);
    if (!summaryDue(acceptedUserTurns, previous, cfg.renameInterval)) return;
    const model =
      ctx.modelRegistry.find(cfg.model.provider, cfg.model.id) ?? ctx.model;
    if (!model) return;
    let output: string | null = null;
    try {
      output = await modelText(
        complete,
        model,
        ctx.modelRegistry,
        `Write only a concise plain-markdown durable session summary. Preserve goals, constraints, decisions, completed work, verification, failures, and next steps. Do not infer facts.\n\n${buildSummaryInput(branch)}`,
        1200,
        ctx.signal,
      );
    } catch {
      return;
    }
    const summary = output && parseSummary(output);
    if (!summary) return;
    const currentBranch = ctx.sessionManager.getBranch();
    if (
      ctx.sessionManager.getSessionId() !== sessionId ||
      !currentBranch.some((entry) => entry.id === throughLeafId) ||
      completedAuthoredLeafId(currentBranch) !== throughLeafId ||
      acceptedUserTurnCount(currentBranch) !== acceptedUserTurns
    )
      return;
    const title =
      pi.getSessionName() || previous?.title || "session progress summary";
    pi.appendEntry(SUMMARY_ENTRY_TYPE, {
      version: 1,
      title,
      summary,
      throughLeafId,
      acceptedUserTurns,
    } satisfies SessionSummaryEntryData);
  });

  pi.on("session_start", abortTitle);
  pi.on("session_before_tree", abortTitle);
  pi.on("session_shutdown", abortTitle);
  pi.on("session_info_changed", clearSessionMentionCache);
}

export default sessionNameExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const tmpdir = os.tmpdir();

  function writeConfig(data: unknown): string {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-session-name-test-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
  }

  function harness(branch: SessionEntry[] = []) {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    const appended: Array<{ customType: string; data: any }> = [];
    let name = "";
    const pi = {
      on: (event: string, handler: (event: any, ctx: any) => any) =>
        handlers.set(event, handler),
      appendEntry: (customType: string, data: any) => {
        appended.push({ customType, data });
        branch.push({
          type: "custom",
          id: `custom-${appended.length}`,
          parentId: branch.at(-1)?.id ?? null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        });
      },
      getSessionName: () => name,
      setSessionName: (value: string) => {
        name = value;
      },
    } as unknown as ExtensionAPI;
    return { pi, handlers, appended, getName: () => name };
  }

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

  function assistant(id: string): SessionEntry {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          {
            type: "toolCall",
            id: "c",
            name: "read",
            arguments: { path: "secret" },
          },
          { type: "text", text: "complete turn answer" },
        ],
        timestamp: 1,
      },
    } as SessionEntry;
  }

  function context(branch: SessionEntry[], auth = true) {
    const model = { id: "test" } as Model<Api>;
    return {
      model,
      signal: undefined,
      sessionManager: {
        getBranch: () => branch,
        getLeafId: () => branch.at(-1)?.id ?? null,
        getSessionId: () => "session-1",
      },
      modelRegistry: {
        find: () => model,
        getApiKeyAndHeaders: async () =>
          auth ? { ok: true, apiKey: "key" } : { ok: false, error: "no auth" },
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `missing-${Date.now()}`));
  });

  describe("session-name", () => {
    it("registers settlement and lifecycle hooks", () => {
      const h = harness();
      sessionNameExtension(h.pi);
      expect([...h.handlers.keys()].sort()).toEqual([
        "agent_settled",
        "input",
        "session_before_tree",
        "session_info_changed",
        "session_shutdown",
        "session_start",
      ]);
    });

    it("persists a checkpoint when summary auth fails", async () => {
      const branch = [user("u1", "goal"), assistant("a1")];
      const h = harness(branch);
      sessionNameExtension(h.pi, vi.fn());
      await h.handlers.get("agent_settled")?.({}, context(branch, false));
      expect(h.appended).toEqual([
        {
          customType: CHECKPOINT_ENTRY_TYPE,
          data: { version: 1, throughLeafId: "a1", acceptedUserTurns: 1 },
        },
      ]);
    });

    it("retries a missing first summary at the next interval", async () => {
      setGlobalSettingsPath(
        writeConfig({
          "@bds_pi/session-name": {
            enabled: true,
            renameInterval: 2,
            model: CONFIG_DEFAULTS.model,
          },
        }),
      );
      const branch = [
        user("u1", "one"),
        assistant("a1"),
        user("u2", "two"),
        assistant("a2"),
        user("u3", "three"),
        assistant("a3"),
      ];
      const h = harness(branch);
      const complete = vi.fn().mockResolvedValue({
        stopReason: "stop",
        content: [{ type: "text", text: "recovered summary" }],
      });
      sessionNameExtension(h.pi, complete as Complete);
      await h.handlers.get("agent_settled")?.({}, context(branch));
      expect(complete).toHaveBeenCalledOnce();
      expect(h.appended.at(-1)?.data.summary).toBe("recovered summary");
    });

    it("does not checkpoint the same completed leaf twice", async () => {
      const branch = [user("u1", "goal"), assistant("a1")];
      const h = harness(branch);
      sessionNameExtension(h.pi, vi.fn());
      await h.handlers.get("agent_settled")?.({}, context(branch, false));
      await h.handlers.get("agent_settled")?.({}, context(branch, false));
      expect(h.appended).toHaveLength(1);
      expect(h.appended[0]?.customType).toBe(CHECKPOINT_ENTRY_TYPE);
    });

    it("summarizes the complete authored turn without tools or reasoning", async () => {
      const branch = [user("u1", "user goal"), assistant("a1")];
      const h = harness(branch);
      const complete = vi.fn().mockResolvedValue({
        stopReason: "stop",
        content: [{ type: "text", text: "durable result" }],
      });
      sessionNameExtension(h.pi, complete as Complete);
      await h.handlers.get("agent_settled")?.({}, context(branch));
      const prompt = complete.mock.calls[0]![1].messages[0].content[0].text;
      expect(prompt).toContain("user goal");
      expect(prompt).toContain("complete turn answer");
      expect(prompt).not.toContain("private reasoning");
      expect(prompt).not.toContain("secret");
      expect(h.appended.at(-1)?.data).toMatchObject({
        summary: "durable result",
        throughLeafId: "a1",
        acceptedUserTurns: 1,
      });
    });

    it("derives interval eligibility from summaries on the branch", async () => {
      setGlobalSettingsPath(
        writeConfig({
          "@bds_pi/session-name": {
            enabled: true,
            renameInterval: 2,
            model: CONFIG_DEFAULTS.model,
          },
        }),
      );
      const previous: SessionEntry = {
        type: "custom",
        id: "s1",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: SUMMARY_ENTRY_TYPE,
        data: {
          version: 1,
          title: "prior branch summary",
          summary: "prior",
          throughLeafId: "a1",
          acceptedUserTurns: 1,
        },
      };
      const branch = [
        user("u1", "one"),
        assistant("a1"),
        previous,
        user("u2", "two"),
        assistant("a2"),
        user("u3", "three"),
        assistant("a3"),
      ];
      const h = harness(branch);
      const complete = vi.fn().mockResolvedValue({
        stopReason: "stop",
        content: [{ type: "text", text: "new summary" }],
      });
      sessionNameExtension(h.pi, complete as Complete);
      await h.handlers.get("agent_settled")?.({}, context(branch));
      expect(complete).toHaveBeenCalledOnce();
      const prompt = complete.mock.calls[0]![1].messages[0].content[0].text;
      expect(prompt).toContain("user:\none");
      expect(prompt).toContain("user:\nthree");
      expect(h.appended.at(-1)?.data.acceptedUserTurns).toBe(3);
    });

    it("keeps a valid summary when a stale title is blocked", async () => {
      const branch = [
        user("u1", "long enough initial prompt"),
        assistant("a1"),
      ];
      const h = harness(branch);
      let resolveTitle: (value: unknown) => void = () => {};
      const complete = vi
        .fn()
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveTitle = resolve)),
        )
        .mockResolvedValueOnce({
          stopReason: "stop",
          content: [{ type: "text", text: "valid summary" }],
        });
      sessionNameExtension(h.pi, complete as Complete);
      h.handlers.get("input")?.(
        { text: "long enough initial prompt" },
        context([]),
      );
      h.pi.setSessionName("manual title");
      const settled = h.handlers.get("agent_settled")?.({}, context(branch));
      resolveTitle({
        stopReason: "stop",
        content: [{ type: "text", text: "stale generated title" }],
      });
      await settled;
      expect(h.getName()).toBe("manual title");
      expect(h.appended.at(-1)?.data).toMatchObject({
        title: "manual title",
        summary: "valid summary",
      });
    });
  });
}
