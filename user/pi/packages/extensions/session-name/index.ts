/**
 * auto session naming — generates a short title from conversation context.
 *
 * fires on the `input` event so the name appears while the agent is still
 * thinking. names the session on the first message, then re-evaluates
 * every `renameInterval` messages (default 10) as the conversation topic
 * may drift. uses gemini flash for speed/cost.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as piAi from "@mariozechner/pi-ai";
import type { Api, Model, Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";

type SessionNameExtConfig = {
  model: { provider: string; id: string };
  renameInterval: number;
};

const CONFIG_DEFAULTS: SessionNameExtConfig = {
  model: {
    provider: "openrouter",
    id: "google/gemini-3-flash-preview",
  },
  renameInterval: 10,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionNameConfig(
  value: Record<string, unknown>,
): value is SessionNameExtConfig {
  const renameInterval = value.renameInterval;
  if (
    typeof renameInterval !== "number" ||
    !Number.isInteger(renameInterval) ||
    renameInterval < 1
  ) {
    return false;
  }

  if (!isPlainObject(value.model)) {
    return false;
  }

  return (
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

function sessionNameExtension(pi: ExtensionAPI): void {
  const { enabled, config: cfg } = getEnabledExtensionConfig(
    "@bds_pi/session-name",
    CONFIG_DEFAULTS,
    { schema: SESSION_NAME_CONFIG_SCHEMA },
  );
  if (!enabled) return;

  let messageCount = 0;
  let pending = false;

  pi.on("input", async (event, ctx) => {
    const text = event.text.trim();
    if (text.startsWith("/") || text.length < 10) return;

    messageCount++;

    const isFirst = messageCount === 1;
    const isInterval =
      messageCount > 1 && (messageCount - 1) % cfg.renameInterval === 0;
    if (!isFirst && !isInterval) return;
    if (pending) return;

    const model =
      ctx.modelRegistry.find(cfg.model.provider, cfg.model.id) ?? ctx.model;
    if (!model) return;

    pending = true;

    const currentName = pi.getSessionName() || undefined;

    generateName(model, ctx.modelRegistry, text, currentName, isFirst, ctx.signal)
      .then((name) => {
        if (name) pi.setSessionName(name);
      })
      .catch(() => {})
      .finally(() => {
        pending = false;
      });
  });

  pi.on("session_start", async (event) => {
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
      messageCount = 0;
      pending = false;
    }
  });
}

export default sessionNameExtension;

async function generateName(
  model: Model<Api>,
  registry: {
    getApiKeyAndHeaders(
      model: Model<Api>,
    ): Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
    >;
  },
  userMessage: string,
  currentName: string | undefined,
  isFirst: boolean,
  signal?: AbortSignal,
): Promise<string | null> {
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) return null;
  if (!auth.apiKey && !auth.headers) return null;

  const prompt = isFirst
    ? `Generate a 3-5 word title for a coding session that starts with this message. Return ONLY the title, no quotes, no punctuation, no explanation. Lowercase.\n\n${userMessage.slice(0, 500)}`
    : `The current session title is "${currentName}". Based on this latest message, decide if the title still fits. If the topic has shifted, generate a new 3-5 word title. If it still fits, return the EXACT current title. Return ONLY the title, no quotes, no punctuation, no explanation. Lowercase.\n\n${userMessage.slice(0, 500)}`;

  const message: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  const response = await piAi.complete(
    model,
    { messages: [message] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      maxTokens: 20,
    },
  );
  if (response.stopReason === "aborted") return null;

  const title = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  return title || null;
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;

  describe("isPlainObject", () => {
    it("returns true for plain objects", () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ foo: "bar" })).toBe(true);
    });

    it("returns false for non-objects", () => {
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
      expect(isPlainObject(42)).toBe(false);
      expect(isPlainObject("string")).toBe(false);
    });

    it("returns false for arrays", () => {
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject([1, 2, 3])).toBe(false);
    });
  });

  describe("isSessionNameConfig", () => {
    it("validates correct config", () => {
      expect(
        isSessionNameConfig({
          renameInterval: 10,
          model: { provider: "openrouter", id: "gemini-3-flash" },
        }),
      ).toBe(true);
    });

    it("rejects invalid renameInterval", () => {
      expect(isSessionNameConfig({ renameInterval: 0 })).toBe(false);
      expect(isSessionNameConfig({ renameInterval: -1 })).toBe(false);
      expect(isSessionNameConfig({ renameInterval: 1.5 })).toBe(false);
      expect(isSessionNameConfig({ renameInterval: "10" })).toBe(false);
    });

    it("rejects missing or invalid model", () => {
      expect(isSessionNameConfig({ renameInterval: 10 })).toBe(false);
      expect(
        isSessionNameConfig({ renameInterval: 10, model: "not-an-object" }),
      ).toBe(false);
    });

    it("rejects empty/missing provider or id", () => {
      expect(
        isSessionNameConfig({
          renameInterval: 10,
          model: { provider: "", id: "gemini" },
        }),
      ).toBe(false);
      expect(
        isSessionNameConfig({
          renameInterval: 10,
          model: { provider: "openrouter", id: "  " },
        }),
      ).toBe(false);
    });
  });

  const tmpdir = os.tmpdir();

  function writeTmpJson(dir: string, filename: string, data: unknown): string {
    const filePath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  function createMockExtensionApiHarness() {
    const handlers = new Map<
      string,
      (event: any, ctx: any) => Promise<void> | void
    >();
    let sessionName = "";

    const pi = {
      on(
        event: string,
        handler: (event: any, ctx: any) => Promise<void> | void,
      ) {
        handlers.set(event, handler);
      },
      getSessionName() {
        return sessionName;
      },
      setSessionName(next: string) {
        sessionName = next;
      },
    } as unknown as ExtensionAPI;

    return { pi, handlers, getSessionName: () => sessionName };
  }

  async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  });

  describe("session-name extension", () => {
    it("skips hook registration when disabled in config", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-session-name-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/session-name": { enabled: false },
      });
      setGlobalSettingsPath(settingsPath);
      const harness = createMockExtensionApiHarness();

      sessionNameExtension(harness.pi);

      expect(harness.handlers.size).toBe(0);
    });

    it("registers hooks with default config when enabled", () => {
      setGlobalSettingsPath(
        path.join(tmpdir, `nonexistent-${Date.now()}.json`),
      );
      const harness = createMockExtensionApiHarness();

      sessionNameExtension(harness.pi);

      expect([...harness.handlers.keys()].sort()).toEqual([
        "input",
        "session_start",
      ]);
    });

    it("falls back to defaults when schema validation fails", async () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-session-name-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/session-name": {
          renameInterval: "fast",
          model: { provider: 123, id: false },
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const harness = createMockExtensionApiHarness();
      const model = { id: "fallback-model" } as unknown as Model<Api>;
      const findSpy = vi.fn(() => model);
      const ctx = {
        model,
        modelRegistry: {
          find: findSpy,
          getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: undefined })),
        },
      };

      sessionNameExtension(harness.pi);

      expect([...harness.handlers.keys()].sort()).toEqual([
        "input",
        "session_start",
      ]);

      const inputHandler = harness.handlers.get("input");
      expect(inputHandler).toBeDefined();

      for (let i = 0; i < 11; i++) {
        await inputHandler?.(
          { text: `message body ${i} with enough chars` },
          ctx,
        );
        await flushAsyncWork();
      }

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/session-name; falling back to defaults.",
      );
      expect(findSpy).toHaveBeenCalledWith(
        CONFIG_DEFAULTS.model.provider,
        CONFIG_DEFAULTS.model.id,
      );
      expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledTimes(2);
      expect(harness.getSessionName()).toBe("");
    });
  });
}
