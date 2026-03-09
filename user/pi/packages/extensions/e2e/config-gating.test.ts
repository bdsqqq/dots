import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  clearConfigCache,
  setGlobalSettingsPath,
} from "@bds_pi/config";
import {
  getMentionSource,
  type MentionSource,
} from "@bds_pi/mentions";
import handoffExtension from "@bds_pi/handoff";
import searchSessionsExtension from "@bds_pi/search-sessions";
import systemPromptExtension from "@bds_pi/system-prompt";
import toolHarnessExtension from "@bds_pi/tool-harness";
import bashExtension from "@bds_pi/bash";
import codeReviewExtension from "@bds_pi/code-review";
import finderExtension from "@bds_pi/finder";
import formatFileExtension from "@bds_pi/format-file";
import globExtension from "@bds_pi/glob";
import grepExtension from "@bds_pi/grep";
import librarianExtension from "@bds_pi/librarian";
import lookAtExtension from "@bds_pi/look-at";
import oracleExtension from "@bds_pi/oracle";
import readExtension from "@bds_pi/read";
import readSessionExtension from "@bds_pi/read-session";
import taskExtension from "@bds_pi/task";
import webSearchExtension from "@bds_pi/web-search";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(__dirname, "../../../..");

function writeTmpJson(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

async function createSession(
  extensionFactories: ExtensionFactory[],
): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: CWD,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: CWD,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  return session;
}

function getToolNames(session: AgentSession): string[] {
  return session.getAllTools().map((tool) => tool.name);
}

function getActiveToolNames(session: AgentSession): string[] {
  return session.getActiveToolNames();
}

function getTool(session: AgentSession, name: string): ToolDefinition {
  const tool = session.getAllTools().find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }
  return tool;
}

function getCommandNames(session: AgentSession): string[] {
  return session._extensionRunner.runtime.getCommands().map((command) => command.name);
}

function getMentionSourceOrThrow(kind: "session" | "handoff"): MentionSource {
  const source = getMentionSource(kind);
  if (!source) {
    throw new Error(`mention source not found: ${kind}`);
  }
  return source;
}

function getRegisteredHandlerNames(session: AgentSession): string[] {
  return session._extensionRunner.extensions.flatMap((ext) => [...ext.handlers.keys()]);
}

async function getSystemPromptForTurn(
  session: AgentSession,
  prompt = "ping",
): Promise<string> {
  const handler = session._extensionRunner.extensions
    .flatMap((ext) => ext.handlers.get("before_agent_start") ?? [])
    .at(0);

  if (!handler) {
    return session._baseSystemPrompt;
  }

  const result = await handler(
    {
      type: "before_agent_start",
      prompt,
      images: undefined,
      systemPrompt: session._baseSystemPrompt,
    },
    session._extensionRunner.createContext(),
  );

  return result?.systemPrompt ?? session._baseSystemPrompt;
}

describe("config gating integration", () => {
  const sessions: AgentSession[] = [];

  const SIMPLE_ADOPTERS: Array<{
    namespace: string;
    toolName: string;
    extension: ExtensionFactory;
    invalidConfig: Record<string, unknown>;
  }> = [
    {
      namespace: "@bds_pi/oracle",
      toolName: "oracle",
      extension: oracleExtension,
      invalidConfig: {
        model: "",
        extensionTools: ["read", 123],
        builtinTools: "bash",
        promptFile: 123,
        promptString: false,
      },
    },
    {
      namespace: "@bds_pi/code-review",
      toolName: "code_review",
      extension: codeReviewExtension,
      invalidConfig: {
        model: "",
        builtinTools: ["read", 123],
        extensionTools: "read",
        promptFile: 123,
        promptString: false,
        reportPromptFile: null,
        reportPromptString: 456,
      },
    },
    {
      namespace: "@bds_pi/librarian",
      toolName: "librarian",
      extension: librarianExtension,
      invalidConfig: {
        model: "",
        extensionTools: ["read_github", 123],
        builtinTools: "bash",
        promptFile: 123,
        promptString: false,
      },
    },
    {
      namespace: "@bds_pi/look-at",
      toolName: "look_at",
      extension: lookAtExtension,
      invalidConfig: {
        model: "",
        extensionTools: ["read", 123],
        builtinTools: "ls",
        promptFile: 123,
        promptString: false,
      },
    },
    {
      namespace: "@bds_pi/read-session",
      toolName: "read_session",
      extension: readSessionExtension,
      invalidConfig: {
        model: "",
        sessionsDir: "",
        maxChars: 0,
      },
    },
    {
      namespace: "@bds_pi/web-search",
      toolName: "web_search",
      extension: webSearchExtension,
      invalidConfig: {
        defaultMaxResults: 0,
        endpoint: "",
        curlTimeoutSecs: "fast",
      },
    },
    {
      namespace: "@bds_pi/finder",
      toolName: "finder",
      extension: finderExtension,
      invalidConfig: {
        model: "",
        extensionTools: ["read", 123],
        builtinTools: "grep",
        promptFile: 123,
        promptString: false,
      },
    },
    {
      namespace: "@bds_pi/task",
      toolName: "Task",
      extension: taskExtension,
      invalidConfig: {
        builtinTools: ["read", 123],
        extensionTools: "finder",
      },
    },
    {
      namespace: "@bds_pi/format-file",
      toolName: "format_file",
      extension: formatFileExtension,
      invalidConfig: {
        preferredFormatter: "nope",
        formatterLookupTimeoutMs: 0,
      },
    },
  ];

  /**
   * these adopters shadow pi built-ins, so disabling them should fall back to
   * the builtin definition instead of removing the tool name outright.
   */
  const BUILTIN_SHADOW_ADOPTERS: Array<{
    namespace: string;
    toolName: string;
    extension: ExtensionFactory;
    invalidConfig: Record<string, unknown>;
    customExpectation: (tool: ToolDefinition) => void;
    builtinExpectation: (tool: ToolDefinition) => void;
  }> = [
    {
      namespace: "@bds_pi/bash",
      toolName: "bash",
      extension: bashExtension,
      invalidConfig: {
        headLines: 0,
        tailLines: 0,
        sigkillDelayMs: -1,
      },
      customExpectation: (tool) => {
        expect(tool.description).toContain("Executes the given shell command using bash.");
        expect(tool.parameters).toMatchObject({
          required: ["cmd"],
          properties: expect.objectContaining({
            cwd: expect.any(Object),
          }),
        });
      },
      builtinExpectation: (tool) => {
        expect(tool.description).toContain("Execute a bash command in the current working directory.");
        expect(tool.parameters).toMatchObject({
          required: ["command"],
          properties: expect.objectContaining({
            timeout: expect.any(Object),
          }),
        });
      },
    },
    {
      namespace: "@bds_pi/grep",
      toolName: "grep",
      extension: grepExtension,
      invalidConfig: {
        maxTotalMatches: 0,
        maxPerFile: 0,
        maxLineChars: 0,
        contextLines: -1,
      },
      customExpectation: (tool) => {
        expect(tool.description).toContain("Search for exact text patterns in files using ripgrep");
        expect(tool.parameters).toMatchObject({
          required: ["pattern"],
          properties: expect.objectContaining({
            caseSensitive: expect.any(Object),
          }),
        });
      },
      builtinExpectation: (tool) => {
        expect(tool.description).toContain("Search file contents for a pattern.");
        expect(tool.parameters).toMatchObject({
          required: ["pattern"],
          properties: expect.objectContaining({
            ignoreCase: expect.any(Object),
            context: expect.any(Object),
            limit: expect.any(Object),
          }),
        });
      },
    },
    {
      namespace: "@bds_pi/read",
      toolName: "read",
      extension: readExtension,
      invalidConfig: {
        maxLines: 0,
        maxFileBytes: 0,
        maxLineBytes: 0,
        maxDirEntries: 0,
      },
      customExpectation: (tool) => {
        expect(tool.description).toContain("Read a file or list a directory from the file system.");
        expect(tool.parameters).toMatchObject({
          required: ["path"],
          properties: expect.objectContaining({
            read_range: expect.any(Object),
          }),
        });
      },
      builtinExpectation: (tool) => {
        expect(tool.description).toContain("Read the contents of a file.");
        expect(tool.parameters).toMatchObject({
          required: ["path"],
          properties: expect.objectContaining({
            offset: expect.any(Object),
            limit: expect.any(Object),
          }),
        });
      },
    },
    {
      namespace: "@bds_pi/glob",
      toolName: "find",
      extension: globExtension,
      invalidConfig: {
        defaultLimit: 0,
      },
      customExpectation: (tool) => {
        expect(tool.description).toContain("Fast file pattern matching tool that works with any codebase size.");
        expect(tool.parameters).toMatchObject({
          required: ["filePattern"],
          properties: expect.objectContaining({
            offset: expect.any(Object),
          }),
        });
      },
      builtinExpectation: (tool) => {
        expect(tool.description).toContain("Search for files by glob pattern.");
        expect(tool.parameters).toMatchObject({
          required: ["pattern"],
          properties: expect.objectContaining({
            path: expect.any(Object),
            limit: expect.any(Object),
          }),
        });
      },
    },
  ];

  afterEach(() => {
    for (const session of sessions.splice(0)) {
      session.dispose();
    }
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`));
  });

  it("registers all migrated simple adopters by default", async () => {
    const session = await createSession(SIMPLE_ADOPTERS.map(({ extension }) => extension));
    sessions.push(session);

    expect(getToolNames(session)).toEqual(
      expect.arrayContaining(SIMPLE_ADOPTERS.map(({ toolName }) => toolName)),
    );
    expect(getActiveToolNames(session)).toEqual(
      expect.arrayContaining(SIMPLE_ADOPTERS.map(({ toolName }) => toolName)),
    );
  });

  it("omits migrated simple adopters when disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gating-test-"));
    const settingsPath = writeTmpJson(
      dir,
      "bds-pi.json",
      Object.fromEntries(
        SIMPLE_ADOPTERS.map(({ namespace }) => [namespace, { enabled: false }]),
      ),
    );
    setGlobalSettingsPath(settingsPath);

    const session = await createSession(SIMPLE_ADOPTERS.map(({ extension }) => extension));
    sessions.push(session);

    for (const { toolName } of SIMPLE_ADOPTERS) {
      expect(getToolNames(session)).not.toContain(toolName);
      expect(getActiveToolNames(session)).not.toContain(toolName);
    }
  });

  it("falls back to defaults for invalid config and still registers migrated simple adopters", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gating-test-"));
    const settingsPath = writeTmpJson(
      dir,
      "bds-pi.json",
      Object.fromEntries(
        SIMPLE_ADOPTERS.map(({ namespace, invalidConfig }) => [namespace, invalidConfig]),
      ),
    );
    setGlobalSettingsPath(settingsPath);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const session = await createSession(SIMPLE_ADOPTERS.map(({ extension }) => extension));
    sessions.push(session);

    expect(getToolNames(session)).toEqual(
      expect.arrayContaining(SIMPLE_ADOPTERS.map(({ toolName }) => toolName)),
    );
    expect(getActiveToolNames(session)).toEqual(
      expect.arrayContaining(SIMPLE_ADOPTERS.map(({ toolName }) => toolName)),
    );
    for (const { namespace } of SIMPLE_ADOPTERS) {
      expect(errorSpy).toHaveBeenCalledWith(
        `[@bds_pi/config] invalid config for ${namespace}; falling back to defaults.`,
      );
    }
  });

  it("registers migrated built-in shadows by default", async () => {
    const session = await createSession(BUILTIN_SHADOW_ADOPTERS.map(({ extension }) => extension));
    sessions.push(session);

    expect(getToolNames(session)).toEqual(
      expect.arrayContaining(BUILTIN_SHADOW_ADOPTERS.map(({ toolName }) => toolName)),
    );
    expect(getActiveToolNames(session)).toEqual(
      expect.arrayContaining(BUILTIN_SHADOW_ADOPTERS.map(({ toolName }) => toolName)),
    );
    for (const { toolName, customExpectation } of BUILTIN_SHADOW_ADOPTERS) {
      customExpectation(getTool(session, toolName));
    }
  });

  it("falls back to pi built-ins when migrated built-in shadows are disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gating-test-"));
    const settingsPath = writeTmpJson(
      dir,
      "bds-pi.json",
      Object.fromEntries(
        BUILTIN_SHADOW_ADOPTERS.map(({ namespace }) => [namespace, { enabled: false }]),
      ),
    );
    setGlobalSettingsPath(settingsPath);

    const session = await createSession(BUILTIN_SHADOW_ADOPTERS.map(({ extension }) => extension));
    sessions.push(session);

    /**
     * disabled shadow extensions should stop overriding the built-in tool
     * definition, but they do not change pi's default active-tool set for a
     * top-level session. assert fallback on registration shape, not activity.
     */
    expect(getToolNames(session)).toEqual(
      expect.arrayContaining(BUILTIN_SHADOW_ADOPTERS.map(({ toolName }) => toolName)),
    );
    for (const { toolName, builtinExpectation } of BUILTIN_SHADOW_ADOPTERS) {
      builtinExpectation(getTool(session, toolName));
    }
  });

  it("falls back to defaults for invalid built-in shadow config and still registers custom tools", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gating-test-"));
    const settingsPath = writeTmpJson(
      dir,
      "bds-pi.json",
      Object.fromEntries(
        BUILTIN_SHADOW_ADOPTERS.map(({ namespace, invalidConfig }) => [namespace, invalidConfig]),
      ),
    );
    setGlobalSettingsPath(settingsPath);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const session = await createSession(BUILTIN_SHADOW_ADOPTERS.map(({ extension }) => extension));
    sessions.push(session);

    for (const { namespace, toolName, customExpectation } of BUILTIN_SHADOW_ADOPTERS) {
      expect(errorSpy).toHaveBeenCalledWith(
        `[@bds_pi/config] invalid config for ${namespace}; falling back to defaults.`,
      );
      customExpectation(getTool(session, toolName));
    }
  });

  it("registers startup-surface capabilities when search-sessions and handoff are enabled", async () => {
    const session = await createSession([searchSessionsExtension, handoffExtension]);
    sessions.push(session);

    expect(getToolNames(session)).toEqual(
      expect.arrayContaining(["search_sessions", "handoff"]),
    );
    expect(getActiveToolNames(session)).toEqual(
      expect.arrayContaining(["search_sessions", "handoff"]),
    );
    expect(getCommandNames(session)).toContain("handoff");

    const sessionSource = getMentionSourceOrThrow("session");
    expect(sessionSource.getSuggestions("alpha", {
      cwd: "/repo/app",
      sessions: [
        {
          sessionId: "alpha1234",
          sessionName: "alpha work",
          workspace: "/repo/app",
          filePath: "/sessions/alpha.jsonl",
          startedAt: "2026-03-06T17:00:00.000Z",
          updatedAt: "2026-03-06T17:10:00.000Z",
          firstUserMessage: "alpha task",
          searchableText: "alpha task",
          branchCount: 1,
          isHandoffCandidate: false,
        },
      ],
    })).toEqual([
      {
        value: "@session/alpha1234",
        label: "@session/alpha1234",
        description: "alpha work",
      },
    ]);

    const handoffSource = getMentionSourceOrThrow("handoff");
    expect(handoffSource.getSuggestions("handoff", {
      cwd: "/repo/app",
      sessions: [
        {
          sessionId: "handoffabcd",
          sessionName: "handoff alpha",
          workspace: "/repo/app",
          filePath: "/sessions/handoff.jsonl",
          startedAt: "2026-03-06T17:00:00.000Z",
          updatedAt: "2026-03-06T17:20:00.000Z",
          firstUserMessage: "resume alpha",
          searchableText: "resume alpha",
          branchCount: 1,
          parentSessionPath: "/sessions/parent.jsonl",
          isHandoffCandidate: true,
        },
      ],
    })).toEqual([
      {
        value: "@handoff/handoffabcd",
        label: "@handoff/handoffabcd",
        description: "handoff alpha",
      },
    ]);
  });

  it("removes startup-surface capabilities when search-sessions and handoff are disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gating-test-"));
    const settingsPath = writeTmpJson(dir, "bds-pi.json", {
      "@bds_pi/search-sessions": { enabled: false },
      "@bds_pi/handoff": { enabled: false },
    });
    setGlobalSettingsPath(settingsPath);

    const previousSessionSource = getMentionSource("session");
    const previousHandoffSource = getMentionSource("handoff");
    const session = await createSession([searchSessionsExtension, handoffExtension]);
    sessions.push(session);

    expect(getToolNames(session)).not.toContain("search_sessions");
    expect(getActiveToolNames(session)).not.toContain("search_sessions");
    expect(getToolNames(session)).not.toContain("handoff");
    expect(getActiveToolNames(session)).not.toContain("handoff");
    expect(getCommandNames(session)).not.toContain("handoff");
    expect(getRegisteredHandlerNames(session)).not.toEqual(
      expect.arrayContaining(["agent_end", "session_before_compact", "session_start", "session_switch"]),
    );
    expect(getMentionSource("session")).toBe(previousSessionSource);
    expect(getMentionSource("handoff")).toBe(previousHandoffSource);
  });

  it("applies hook-only startup surface when system-prompt is enabled and removes it when disabled", async () => {
    const enabledDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gating-test-"));
    const enabledSettingsPath = writeTmpJson(enabledDir, "bds-pi.json", {
      "@bds_pi/system-prompt": { promptString: "UNIQUE_MARKER" },
    });
    setGlobalSettingsPath(enabledSettingsPath);

    const enabledSession = await createSession([systemPromptExtension]);
    sessions.push(enabledSession);

    expect(getRegisteredHandlerNames(enabledSession)).toContain("before_agent_start");
    expect(await getSystemPromptForTurn(enabledSession, "ping")).toContain("UNIQUE_MARKER");

    const disabledDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gating-test-"));
    const disabledSettingsPath = writeTmpJson(disabledDir, "bds-pi.json", {
      "@bds_pi/system-prompt": { enabled: false, promptString: "UNIQUE_MARKER" },
    });
    setGlobalSettingsPath(disabledSettingsPath);

    const disabledSession = await createSession([systemPromptExtension]);
    sessions.push(disabledSession);

    expect(getRegisteredHandlerNames(disabledSession)).not.toContain("before_agent_start");
    expect(await getSystemPromptForTurn(disabledSession, "ping")).not.toContain("UNIQUE_MARKER");
  });

  it("keeps builtin-shadow fallback stable under sub-agent tool filtering", async () => {
    const originalPiIncludeTools = process.env.PI_INCLUDE_TOOLS;
    process.env.PI_INCLUDE_TOOLS = "bash";

    try {
      const enabledSession = await createSession([bashExtension, toolHarnessExtension]);
      sessions.push(enabledSession);
      expect(getActiveToolNames(enabledSession)).toContain("bash");
      expect(getTool(enabledSession, "bash").parameters).toMatchObject({
        required: ["cmd"],
      });

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gating-test-"));
      const settingsPath = writeTmpJson(dir, "bds-pi.json", {
        "@bds_pi/bash": { enabled: false },
      });
      setGlobalSettingsPath(settingsPath);

      const disabledSession = await createSession([bashExtension, toolHarnessExtension]);
      sessions.push(disabledSession);
      expect(getActiveToolNames(disabledSession)).toContain("bash");
      expect(getTool(disabledSession, "bash").parameters).toMatchObject({
        required: ["command"],
      });
    } finally {
      if (originalPiIncludeTools === undefined) {
        delete process.env.PI_INCLUDE_TOOLS;
      } else {
        process.env.PI_INCLUDE_TOOLS = originalPiIncludeTools;
      }
    }
  });
});
