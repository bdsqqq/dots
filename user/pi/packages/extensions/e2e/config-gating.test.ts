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
} from "@mariozechner/pi-coding-agent";
import {
  clearConfigCache,
  setGlobalSettingsPath,
} from "@bds_pi/config";
import codeReviewExtension from "@bds_pi/code-review";
import librarianExtension from "@bds_pi/librarian";
import lookAtExtension from "@bds_pi/look-at";
import oracleExtension from "@bds_pi/oracle";
import readSessionExtension from "@bds_pi/read-session";

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
});
