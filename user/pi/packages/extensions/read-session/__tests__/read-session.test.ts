/**
 * SDK-backed integration tests for read-session extension.
 *
 * Tests extension lifecycle, session parsing, file handling, and pi-spawn integration.
 * Uses real tmpdir for file system tests, minimal tracking mocks for pi API.
 *
 * NOTE: Tests marked with it.todo() require deeper SDK understanding or
 * proper pi-spawn mocking.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import readSessionExtension, {
  CONFIG_DEFAULTS,
  createReadSessionExtension,
  DEFAULT_DEPS,
  findSessionFile,
  isNonEmptyString,
  isReadSessionConfig,
  READ_SESSION_CONFIG_SCHEMA,
  renderSessionTree,
} from "../index";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

describe("read-session extension (SDK integration)", () => {
  const tmpRoots: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-session-"));
    tmpRoots.push(dir);
    return dir;
  }

  function writeSessionJsonl(filePath: string, lines: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("extension registration", () => {
    it("does not register anything when disabled", () => {
      const mockConfig = vi.fn(() => ({
        enabled: false,
        config: CONFIG_DEFAULTS,
      }));

      const ext = createReadSessionExtension({
        ...DEFAULT_DEPS,
        getEnabledExtensionConfig: mockConfig as any,
      });

      const calls: string[] = [];
      const mockPi = {
        registerTool: () => calls.push("tool"),
      } as unknown as ExtensionAPI;

      ext(mockPi);

      expect(calls).toHaveLength(0);
    });

    it("registers read_session tool when enabled", () => {
      const mockConfig = vi.fn(() => ({
        enabled: true,
        config: CONFIG_DEFAULTS,
      }));

      const withPromptPatchSpy = vi.fn((tool) => tool);

      const ext = createReadSessionExtension({
        getEnabledExtensionConfig: mockConfig as any,
        withPromptPatch: withPromptPatchSpy as any,
      });

      const registeredTools: { name: string }[] = [];
      const mockPi = {
        registerTool: (tool: { name: string }) =>
          registeredTools.push(tool),
      } as unknown as ExtensionAPI;

      ext(mockPi);

      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(registeredTools).toHaveLength(1);
      expect(registeredTools[0].name).toBe("read_session");
    });

    it("passes config to tool factory when enabled", () => {
      const customConfig = {
        model: "custom-model",
        sessionsDir: "/custom/sessions",
        maxChars: 50_000,
      };
      const mockConfig = vi.fn(() => ({
        enabled: true,
        config: customConfig,
      }));

      const withPromptPatchSpy = vi.fn(
        (tool: { config?: { sessionsDir: string } }) => tool,
      );

      const ext = createReadSessionExtension({
        getEnabledExtensionConfig: mockConfig as any,
        withPromptPatch: withPromptPatchSpy as any,
      });

      const mockPi = {
        registerTool: () => {},
      } as unknown as ExtensionAPI;

      ext(mockPi);

      // Tool should be created with the custom config
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      const tool = withPromptPatchSpy.mock.calls[0][0];
      expect(tool.name).toBe("read_session");
    });
  });

  describe("config validation", () => {
    it("validates valid config", () => {
      expect(
        isReadSessionConfig({
          model: "openrouter/google/gemini-3-flash-preview",
          sessionsDir: "/home/user/.pi/agent/sessions",
          maxChars: 100_000,
        }),
      ).toBe(true);
    });

    it("rejects empty model", () => {
      expect(
        isReadSessionConfig({
          model: "",
          sessionsDir: "/sessions",
          maxChars: 1000,
        }),
      ).toBe(false);
    });

    it("rejects empty sessionsDir", () => {
      expect(
        isReadSessionConfig({
          model: "model",
          sessionsDir: "",
          maxChars: 1000,
        }),
      ).toBe(false);
    });

    it("rejects non-integer maxChars", () => {
      expect(
        isReadSessionConfig({
          model: "model",
          sessionsDir: "/sessions",
          maxChars: 1.5,
        }),
      ).toBe(false);
    });

    it("rejects maxChars less than 1", () => {
      expect(
        isReadSessionConfig({
          model: "model",
          sessionsDir: "/sessions",
          maxChars: 0,
        }),
      ).toBe(false);
    });

    it("uses schema for validation", () => {
      expect(
        READ_SESSION_CONFIG_SCHEMA.validate!({
          model: "model",
          sessionsDir: "/sessions",
          maxChars: 5000,
        }),
      ).toBe(true);
      expect(
        READ_SESSION_CONFIG_SCHEMA.validate!({
          model: "",
          sessionsDir: "/sessions",
          maxChars: 5000,
        }),
      ).toBe(false);
    });
  });

  describe("isNonEmptyString", () => {
    it("accepts non-empty strings", () => {
      expect(isNonEmptyString("hello")).toBe(true);
      expect(isNonEmptyString("  spaces  ")).toBe(true);
    });

    it("rejects empty strings", () => {
      expect(isNonEmptyString("")).toBe(false);
      expect(isNonEmptyString("   ")).toBe(false);
      expect(isNonEmptyString("\t\n")).toBe(false);
    });

    it("rejects non-strings", () => {
      expect(isNonEmptyString(null)).toBe(false);
      expect(isNonEmptyString(undefined)).toBe(false);
      expect(isNonEmptyString(123)).toBe(false);
      expect(isNonEmptyString({})).toBe(false);
    });
  });
});

describe("findSessionFile (file system tests)", () => {
  const tmpRoots: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-session-"));
    tmpRoots.push(dir);
    return dir;
  }

  function writeSessionJsonl(filePath: string, lines: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when sessions dir does not exist", () => {
    expect(findSessionFile("any-id", "/nonexistent/path")).toBeNull();
  });

  it("finds sessions by filename (fast path)", () => {
    const sessionsDir = makeTmpDir();
    const filePath = path.join(
      sessionsDir,
      "2026",
      "2026-03-06T17-00-00-000Z_alpha-session.jsonl",
    );
    writeSessionJsonl(filePath, [
      {
        type: "session",
        id: "alpha-session",
        timestamp: "2026-03-06T17:00:00.000Z",
        cwd: "/repo/app",
      },
    ]);

    expect(findSessionFile("alpha-session", sessionsDir)).toBe(filePath);
  });

  it("falls back to parsing headers when filename does not contain session id", () => {
    const sessionsDir = makeTmpDir();
    const filePath = path.join(sessionsDir, "nested", "session-log.jsonl");
    writeSessionJsonl(filePath, [
      {
        type: "session",
        id: "beta-session",
        timestamp: "2026-03-06T17:10:00.000Z",
        cwd: "/repo/app",
      },
    ]);

    expect(findSessionFile("beta-session", sessionsDir)).toBe(filePath);
  });

  it("returns null when session id not found", () => {
    const sessionsDir = makeTmpDir();
    writeSessionJsonl(path.join(sessionsDir, "session.jsonl"), [
      {
        type: "session",
        id: "other-session",
        timestamp: "2026-03-06T17:00:00.000Z",
        cwd: "/repo/app",
      },
    ]);

    expect(findSessionFile("nonexistent", sessionsDir)).toBeNull();
  });

  it("handles malformed jsonl files gracefully", () => {
    const sessionsDir = makeTmpDir();
    const filePath = path.join(sessionsDir, "session.jsonl");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(filePath, "not valid json\nalso not json\n");

    // Should not throw, should return null
    expect(findSessionFile("any-id", sessionsDir)).toBeNull();
  });

  it("handles empty jsonl files", () => {
    const sessionsDir = makeTmpDir();
    const filePath = path.join(sessionsDir, "session.jsonl");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(filePath, "");

    expect(findSessionFile("any-id", sessionsDir)).toBeNull();
  });

  it("stops at first match (fast path)", () => {
    const sessionsDir = makeTmpDir();
    // Create multiple files, one with target in filename
    const targetPath = path.join(
      sessionsDir,
      "2026-03-06T17-00-00-000Z_target-id.jsonl",
    );
    const otherPath = path.join(sessionsDir, "other-session.jsonl");
    writeSessionJsonl(targetPath, [{ type: "session", id: "target-id" }]);
    writeSessionJsonl(otherPath, [{ type: "session", id: "other-id" }]);

    expect(findSessionFile("target-id", sessionsDir)).toBe(targetPath);
  });
});

describe("renderSessionTree (file system tests)", () => {
  const tmpRoots: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-session-"));
    tmpRoots.push(dir);
    return dir;
  }

  function writeSessionJsonl(filePath: string, lines: unknown[]): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    return filePath;
  }

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders basic session with user and assistant messages", () => {
    const dir = makeTmpDir();
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", timestamp: "2026-03-06T17:00:00.000Z", cwd: "/workspace" },
      { type: "session_info", name: "Test Session" },
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello, agent!" }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello, user!" }],
        },
      },
    ]);

    const result = renderSessionTree(filePath, undefined, 100_000);

    expect(result.sessionId).toBe("test-session");
    expect(result.sessionName).toBe("Test Session");
    expect(result.markdown).toContain("# session: Test Session");
    expect(result.markdown).toContain("id: test-session");
    expect(result.markdown).toContain("workspace: /workspace");
    expect(result.markdown).toContain("## user");
    expect(result.markdown).toContain("Hello, agent!");
    expect(result.markdown).toContain("## assistant");
    expect(result.markdown).toContain("Hello, user!");
  });

  it("renders tool calls with truncated arguments", () => {
    const dir = makeTmpDir();
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", cwd: "/workspace" },
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { path: "/some/very/long/path/that/should/be/truncated" },
            },
          ],
        },
      },
    ]);

    const result = renderSessionTree(filePath, undefined, 100_000);

    expect(result.markdown).toContain("tool calls: read(");
    expect(result.markdown).toContain("truncated");
  });

  it("renders tool results with truncation for long outputs", () => {
    const dir = makeTmpDir();
    const longText = "x".repeat(600);
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", cwd: "/workspace" },
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        message: {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: longText }],
        },
      },
    ]);

    const result = renderSessionTree(filePath, undefined, 100_000);

    expect(result.markdown).toContain("### read result");
    expect(result.markdown).toContain("(truncated)");
  });

  it("renders error tool results", () => {
    const dir = makeTmpDir();
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", cwd: "/workspace" },
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        message: {
          role: "toolResult",
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "Command failed" }],
        },
      },
    ]);

    const result = renderSessionTree(filePath, undefined, 100_000);

    expect(result.markdown).toContain("### bash result (ERROR)");
    expect(result.markdown).toContain("Command failed");
  });

  it("annotates target branch when leaf_id provided", () => {
    const dir = makeTmpDir();
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", cwd: "/workspace" },
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "root" }] },
      },
      {
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        message: { role: "user", content: [{ type: "text", text: "branch-a" }] },
      },
      {
        type: "message",
        id: "msg-3",
        parentId: "msg-1",
        message: { role: "user", content: [{ type: "text", text: "branch-b" }] },
      },
    ]);

    const result = renderSessionTree(filePath, "msg-3", 100_000);

    expect(result.markdown).toContain("target branch leaf: msg-3");
    expect(result.markdown).toContain("[TARGET BRANCH]");
    // msg-3 should be annotated, msg-2 should not
    const lines = result.markdown.split("\n");
    const branchALine = lines.find((l) => l.includes("branch-a"));
    const branchBLine = lines.find((l) => l.includes("branch-b"));
    expect(branchALine).toBeDefined();
    expect(branchBLine).toBeDefined();
  });

  it("identifies and marks branch points", () => {
    const dir = makeTmpDir();
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", cwd: "/workspace" },
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "root" }] },
      },
      {
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        message: { role: "assistant", content: [{ type: "text", text: "a1" }] },
      },
      {
        type: "message",
        id: "msg-3",
        parentId: "msg-1",
        message: { role: "assistant", content: [{ type: "text", text: "a2" }] },
      },
    ]);

    const result = renderSessionTree(filePath, undefined, 100_000);

    expect(result.markdown).toContain("--- branch point (2 paths) ---");
  });

  it("truncates markdown when exceeding maxChars", () => {
    const dir = makeTmpDir();
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", cwd: "/workspace" },
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "a".repeat(5000) }],
        },
      },
    ]);

    const result = renderSessionTree(filePath, undefined, 500);

    // headTailChars truncates to ~500 chars with "... N more" suffix
    expect(result.markdown.length).toBeLessThan(1000);
    expect(result.markdown).toContain("...");
  });

  it("renders model_change events", () => {
    const dir = makeTmpDir();
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", cwd: "/workspace" },
      { type: "model_change", id: "mc-1", parentId: null, modelId: "gpt-4" },
    ]);

    const result = renderSessionTree(filePath, undefined, 100_000);

    expect(result.markdown).toContain("*model changed to gpt-4*");
  });

  it("returns header-only markdown for session with no messages", () => {
    const dir = makeTmpDir();
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", cwd: "/workspace" },
    ]);

    const result = renderSessionTree(filePath, undefined, 100_000);

    // Header is always rendered, only message content is empty
    expect(result.markdown).toContain("# session: test-session");
    expect(result.markdown).not.toContain("## user");
    expect(result.markdown).not.toContain("## assistant");
  });

  it("handles session without session_info", () => {
    const dir = makeTmpDir();
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", cwd: "/workspace", timestamp: "2026-03-06T17:00:00.000Z" },
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ]);

    const result = renderSessionTree(filePath, undefined, 100_000);

    expect(result.sessionName).toBe("");
    expect(result.markdown).toContain("# session: test-session");
  });

  it("skips entries without id", () => {
    const dir = makeTmpDir();
    const filePath = writeSessionJsonl(path.join(dir, "session.jsonl"), [
      { type: "session", id: "test-session", cwd: "/workspace" },
      { type: "noise", data: "ignored" }, // no id
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "visible" }] },
      },
    ]);

    const result = renderSessionTree(filePath, undefined, 100_000);

    expect(result.markdown).toContain("visible");
    expect(result.markdown).not.toContain("ignored");
  });
});

describe("read_session tool execution", () => {
  it.todo("returns error when session not found");

  it.todo("returns '(session is empty)' for empty sessions");

  it.todo("spawns sub-agent with rendered markdown");

  it.todo("passes session context via task parameter");

  it.todo("handles pi-spawn abort signal");

  it.todo("reports progress via onUpdate callback");

  it.todo("returns sub-agent output on success");

  it.todo("returns error message on sub-agent failure");
});

describe("read_session tool rendering", () => {
  it.todo("renders call with truncated goal");

  it.todo("shows session id prefix when provided");

  it.todo("renders result as agent tree widget");

  it.todo("shows status-only header in collapsed mode");
});

describe("pi-spawn integration", () => {
  it.todo("uses custom model from config");

  it.todo("passes system prompt body to pi-spawn");

  it.todo("tracks usage metrics from sub-agent");

  it.todo("extracts sessionId from context.sessionManager");

  it.todo("handles missing sessionManager gracefully");
});
