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
import oracleExtension from "@bds_pi/oracle";

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

  afterEach(() => {
    for (const session of sessions.splice(0)) {
      session.dispose();
    }
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`));
  });

  it("registers oracle and code_review by default", async () => {
    const session = await createSession([oracleExtension, codeReviewExtension]);
    sessions.push(session);

    expect(getToolNames(session)).toEqual(
      expect.arrayContaining(["oracle", "code_review"]),
    );
    expect(getActiveToolNames(session)).toEqual(
      expect.arrayContaining(["oracle", "code_review"]),
    );
  });

  it("omits oracle and code_review when disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gating-test-"));
    const settingsPath = writeTmpJson(dir, "bds-pi.json", {
      "@bds_pi/oracle": { enabled: false },
      "@bds_pi/code-review": { enabled: false },
    });
    setGlobalSettingsPath(settingsPath);

    const session = await createSession([oracleExtension, codeReviewExtension]);
    sessions.push(session);

    expect(getToolNames(session)).not.toContain("oracle");
    expect(getToolNames(session)).not.toContain("code_review");
    expect(getActiveToolNames(session)).not.toContain("oracle");
    expect(getActiveToolNames(session)).not.toContain("code_review");
  });

  it("falls back to defaults for invalid config and still registers both tools", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gating-test-"));
    const settingsPath = writeTmpJson(dir, "bds-pi.json", {
      "@bds_pi/oracle": {
        model: "",
        extensionTools: ["read", 123],
        builtinTools: "bash",
        promptFile: 123,
        promptString: false,
      },
      "@bds_pi/code-review": {
        model: "",
        builtinTools: ["read", 123],
        extensionTools: "read",
        promptFile: 123,
        promptString: false,
        reportPromptFile: null,
        reportPromptString: 456,
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const session = await createSession([oracleExtension, codeReviewExtension]);
    sessions.push(session);

    expect(getToolNames(session)).toEqual(
      expect.arrayContaining(["oracle", "code_review"]),
    );
    expect(getActiveToolNames(session)).toEqual(
      expect.arrayContaining(["oracle", "code_review"]),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[@bds_pi/config] invalid config for @bds_pi/oracle; falling back to defaults.",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[@bds_pi/config] invalid config for @bds_pi/code-review; falling back to defaults.",
    );
  });
});
