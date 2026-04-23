/**
 * system-prompt — injects an extended system prompt body into pi's agent prompt.
 *
 * pi's built-in system prompt only provides date + cwd. this extension appends
 * a configurable body with runtime-interpolated template vars: workspace root,
 * OS info, git remote, session ID, and directory listing.
 *
 * uses before_agent_start return value { systemPrompt } to modify the
 * system prompt per-turn. handlers chain — each receives the previous handler's
 * systemPrompt via event.systemPrompt.
 *
 * identity/harness decoupling: {identity} and {harness} are interpolated with
 * configurable values. {harness_docs_section} comes from inline defaults unless
 * config overrides provide prompt content explicitly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { interpolatePromptVars } from "@bds_pi/interpolate";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { resolvePrompt } from "@bds_pi/pi-spawn";

type SystemPromptExtConfig = {
  identity: string;
  harness: string;
  promptFile: string;
  promptString: string;
  harnessDocsPromptFile: string;
  harnessDocsPromptString: string;
};

type SystemPromptExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
};

const DEFAULT_SYSTEM_PROMPT_BODY = String.raw`
You are {identity}, a powerful AI coding agent. You help the user with software engineering tasks. Use the instructions below and the tools available to you to help the user.

# Agency

The user will primarily request you perform software engineering tasks, but you should do your best to help with any task requested of you.

You take initiative when the user asks you to do something, but try to maintain an appropriate balance between:
1. Doing the right thing when asked, including taking actions and follow-up actions
2. Not surprising the user with actions you take without asking (for example, if the user asks you how to approach something or how to plan something, you should do your best to answer their question first, and not immediately jump into taking actions)
3. Do not add additional code explanation summary unless requested by the user

# Tool usage

- Use specialized tools instead of Bash for file operations. Use Read instead of \`cat\`/\`head\`/\`tail\`, edit_file instead of \`sed\`/\`awk\`, and create_file instead of echo redirection or heredoc. Reserve Bash for actual system commands. Never use bash echo or similar to communicate with the user.
- When exploring the codebase to gather context, prefer finder over running search commands directly. It reduces context usage and provides better results.
- Call multiple tools in a single response when there are no dependencies between them. Maximize parallel tool calls for read-only operations (Grep, finder, Read). Only call tools sequentially when one depends on the result of another.
- Never use placeholders or guess missing parameters in tool calls.
- Do NOT use the Task tool unless the task genuinely requires independent, parallelizable work across different parts of an application. Prefer doing the work directly and sequentially yourself — you retain full context and produce better results. Never spawn a single Task call for work you can do yourself. Never use Task for simple or small changes.
- Only use the task_list tool for complex, multi-step tasks that genuinely benefit from structured tracking. Most tasks are simple enough to complete directly without planning overhead. Do not create tasks for straightforward work.
- Only for complex tasks requiring deep analysis, planning, or debugging across multiple files, consider using the oracle tool to get expert guidance before proceeding. Treat the oracle's response as an advisory opinion, not a directive. After receiving the oracle's response, do an independent investigation using the oracle's opinion as a starting point, then come up with an updated approach which you should act on.

## Editing files

- NEVER create files unless they're absolutely necessary for achieving the goal. ALWAYS prefer editing an existing file to creating a new one.
- When changing an existing file, use edit_file. Only use create_file for files that do not exist yet.
- Make the smallest reasonable diff. Do not rewrite whole files to change a few lines.

# Doing tasks

- NEVER propose changes to code you haven't read. If a user asks about or wants you to modify a file, read it first. Understand existing code before suggesting modifications.
- Avoid over-engineering. Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused.
  - Don't add features, refactor code, or make "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability.
  - Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).
  - Don't create helpers, utilities, or abstractions for one-time operations. Don't design for hypothetical future requirements. The right amount of complexity is the minimum needed for the current task.
- Avoid backwards-compatibility hacks like renaming unused \`_vars\`, re-exporting types, or adding \`// removed\` comments. If something is unused, delete it completely.
- Work incrementally. Make a small change, verify it works, then continue. Prefer a sequence of small, validated edits over one large change. Do not attempt to rewrite or restructure large portions of a codebase in a single step.

# Following conventions

- When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume a given library is available. Before using a library or framework, check that this codebase already uses it (e.g., check neighboring files, \`package.json\`, \`cargo.toml\`, etc.).
- When creating a new component, first look at existing components to see how they're written; then follow framework choice, naming conventions, typing, and other conventions.
- When editing code, first look at the surrounding context (especially imports) to understand the code's choice of frameworks and libraries. Make changes in the most idiomatic way.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys.
- Do not add comments to code unless the user asks or the code is complex and requires additional context.

AGENTS.md guidance files are delivered dynamically in the conversation context after file operations (Read, create_file) and user file mentions. They appear with a descriptive header like "Contents of [path] (directory-specific instructions for [scope]):" followed by <instructions> tags. These guidance files provide directory-specific instructions that take precedence for files in that directory and should be followed carefully.
Contents of AGENTS.md (project instructions):

<instructions>
- if you want to smoke-test the harness, run \`pi\` from the repo with a tiny prompt (e.g. ask the oracle to add 2+2) instead of a full build.

</instructions>
# Environment

Here is useful information about the environment you are running in:

Today's date: {date}

Working directory: {cwd}

Workspace root folder: {wsroot}

Operating system: {os}

Repository: {repo}

Session ID: {sessionId}

## Directory listing
List of files (top-level only) in the user's workspace:
{ls}


The following skills provide specialized instructions for specific tasks.
Use the skill tool to load a skill when the task matches its description.

Loaded skills appear as \`<loaded_skill name="...">\` in the conversation.

<available_skills>
  <skill>
    <name>building-skills</name>
    <description>Use when creating any skill or agent skill. Load FIRST—before researching existing skills or writing SKILL.md. Provides required structure, naming conventions, and frontmatter format.</description>
    <location>builtin:///skills/SKILL.md</location>
  </skill>
  <skill>
    <name>code-review</name>
    <description>Review code changes, diffs, outstanding changes, or modified files. Use when asked to review, check, or analyze code quality, changes, uncommitted work, or changes since diverging from a branch (e.g., main).</description>
    <location>builtin:///skills/SKILL.md</location>
  </skill>
  <skill>
    <name>setup-tmux</name>
    <description>Configure tmux for optimal pi TUI compatibility. Use when setting up tmux, troubleshooting tmux issues (images, clipboard, Shift+Enter), or asked to check/fix tmux configuration.</description>
    <location>builtin:///skills/SKILL.md</location>
  </skill>
  <skill>
    <name>walkthrough</name>
    <description>Explore and visualize codebase architecture. Use when asked to "walk me through", "show how X works", "explain the flow", "diagram the architecture", or understand how components connect and interact.</description>
    <location>builtin://skills/SKILL.md</location>
  </skill>
</available_skills>
You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless the user asks for more detail.
`;

const DEFAULT_HARNESS_DOCS = {
  pi: String.raw`# Responding to Queries about Pi

Pi is a minimal terminal coding harness. Key points when describing it:

**Philosophy:** Aggressively extensible so it doesn't dictate your workflow. Features other tools bake in can be built with extensions, skills, or installed from third-party packages.

**What pi does NOT have (by design):**
- No MCP — build CLI tools with READMEs (skills) or extensions
- No sub-agents — spawn pi instances via tmux or build your own with extensions
- No permission popups — run in a container or build your own confirmation flow
- No plan mode — write plans to files or build it with extensions
- No built-in to-dos — use a TODO.md file or build your own
- No background bash — use tmux for full observability

**Extensibility:**
- Extensions: TypeScript modules that can add tools, commands, UI, hooks
- Skills: markdown files with frontmatter describing workflows
- Prompt templates: markdown files for custom system prompts
- Themes: customize the TUI appearance
- Pi packages: share extensions/skills/themes via npm or git

**Modes:** interactive (default), print/JSON, RPC for process integration, SDK for embedding

When asked about pi capabilities, point users to ~/.pi/agent/ for their local config and extensions.
`,
} as const;

const CONFIG_DEFAULTS: SystemPromptExtConfig = {
  identity: "Pi",
  harness: "pi",
  promptFile: "",
  promptString: DEFAULT_SYSTEM_PROMPT_BODY,
  harnessDocsPromptFile: "",
  harnessDocsPromptString: "",
};

const DEFAULT_DEPS: SystemPromptExtensionDeps = {
  getEnabledExtensionConfig,
  resolvePrompt,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSystemPromptConfig(
  value: Record<string, unknown>,
): value is SystemPromptExtConfig {
  return (
    isNonEmptyString(value.identity) &&
    isNonEmptyString(value.harness) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string" &&
    typeof value.harnessDocsPromptFile === "string" &&
    typeof value.harnessDocsPromptString === "string"
  );
}

const SYSTEM_PROMPT_CONFIG_SCHEMA: ExtensionConfigSchema<SystemPromptExtConfig> =
  {
    validate: isSystemPromptConfig,
  };

function createSystemPromptExtension(
  deps: SystemPromptExtensionDeps = DEFAULT_DEPS,
) {
  return function systemPromptExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/system-prompt",
      CONFIG_DEFAULTS,
      { schema: SYSTEM_PROMPT_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const body = deps.resolvePrompt(cfg.promptString, cfg.promptFile);
    if (!body) return;

    const defaultHarnessDocs =
      DEFAULT_HARNESS_DOCS[cfg.harness as keyof typeof DEFAULT_HARNESS_DOCS] ??
      "";
    const harnessDocs =
      cfg.harnessDocsPromptString || cfg.harnessDocsPromptFile
        ? deps.resolvePrompt(
            cfg.harnessDocsPromptString,
            cfg.harnessDocsPromptFile,
          )
        : defaultHarnessDocs;

    pi.on("before_agent_start", async (event, ctx) => {
      const interpolated = interpolatePromptVars(body, ctx.cwd, {
        sessionId: ctx.sessionManager.getSessionId(),
        identity: cfg.identity,
        harness: cfg.harness,
        harnessDocsSection: harnessDocs,
      });

      if (!interpolated.trim()) return;

      return {
        systemPrompt: event.systemPrompt + "\n\n" + interpolated,
      };
    });
  };
}

const systemPromptExtension: (pi: ExtensionAPI) => void =
  createSystemPromptExtension();

export default systemPromptExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const tmpdir = os.tmpdir();

  function writeTmpJson(dir: string, filename: string, data: unknown): string {
    const filePath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  function createMockExtensionApiHarness() {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();

    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    return { pi, handlers };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  });

  describe("system-prompt extension", () => {
    it("registers before_agent_start with default config when enabled", () => {
      setGlobalSettingsPath(
        path.join(tmpdir, `nonexistent-${Date.now()}.json`),
      );
      const harness = createMockExtensionApiHarness();
      const resolvePromptSpy = vi.fn(
        (promptString: string, promptFile: string) =>
          promptString ||
          (promptFile === CONFIG_DEFAULTS.promptFile ? "body" : ""),
      );
      const extension = createSystemPromptExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      });

      extension(harness.pi);

      expect([...harness.handlers.keys()]).toEqual(["before_agent_start"]);
      expect(resolvePromptSpy).toHaveBeenNthCalledWith(
        1,
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile,
      );
    });

    it("registers no handlers when disabled", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-system-prompt-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/system-prompt": { enabled: false },
      });
      setGlobalSettingsPath(settingsPath);
      const harness = createMockExtensionApiHarness();
      const resolvePromptSpy = vi.fn(() => "body");
      const extension = createSystemPromptExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      });

      extension(harness.pi);

      expect(harness.handlers.size).toBe(0);
      expect(resolvePromptSpy).not.toHaveBeenCalled();
    });

    it("falls back to defaults when config is invalid and still registers before_agent_start", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-system-prompt-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/system-prompt": {
          identity: "",
          harness: "",
          promptFile: 123,
          promptString: false,
          harnessDocsPromptFile: null,
          harnessDocsPromptString: 42,
        },
      });
      setGlobalSettingsPath(settingsPath);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const harness = createMockExtensionApiHarness();
      const resolvePromptSpy = vi.fn(
        (promptString: string, promptFile: string) =>
          promptString ||
          (promptFile === CONFIG_DEFAULTS.promptFile ? "body" : ""),
      );
      const extension = createSystemPromptExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      });

      extension(harness.pi);

      expect([...harness.handlers.keys()]).toEqual(["before_agent_start"]);
      expect(resolvePromptSpy).toHaveBeenNthCalledWith(
        1,
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile,
      );
    });
  });
}
