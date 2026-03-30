/**
 * create_file tool — replaces pi's built-in write with enhanced file creation.
 *
 * differences from pi's built-in:
 * - mutex-locked per file path (prevents concurrent writes)
 * - file change tracking for undo_edit via lib/file-tracker
 * - captures before-content when overwriting existing files
 *
 * shadows pi's built-in `write` tool via same-name registration.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { Type } from "@sinclair/typebox";
import { saveChange, simpleDiff } from "@bds_pi/file-tracker";
import { withFileLock } from "@bds_pi/mutex";
import { resolveToAbsolute } from "@bds_pi/fs";
import * as toolPolicy from "@bds_pi/tool-policy";
import {
  boxRendererWindowed,
  textSection,
  osc8Link,
  type Excerpt,
} from "@bds_pi/box-format";

const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

interface CreateFileParams {
  path: string;
  content: string;
}

export function createCreateFileTool(): ToolDefinition {
  return {
    name: "write",
    label: "Create File",
    description:
      "Create or overwrite a file in the workspace.\n\n" +
      "Use this tool to create a **new file** that does not yet exist.\n\n" +
      "For **existing files**, prefer the edit tool instead — even for extensive changes. " +
      "Only use this tool to overwrite an existing file when you are replacing nearly all " +
      "of its content AND the file is small (under ~250 lines).\n\n" +
      "Automatically creates parent directories if they don't exist.",

    parameters: Type.Object({
      path: Type.String({
        description:
          "The absolute path of the file to be created (must be absolute, not relative).",
      }),
      content: Type.String({
        description: "The content for the file.",
      }),
    }),

    renderCall(args: any, theme: any) {
      const filePath = args.path || "...";
      const home = os.homedir();
      const shortened = filePath.startsWith(home)
        ? `~${filePath.slice(home.length)}`
        : filePath;
      const linked = filePath.startsWith("/")
        ? osc8Link(`file://${filePath}`, shortened)
        : shortened;
      return new Text(
        theme.fg("toolTitle", theme.bold("Write ")) + theme.fg("dim", linked),
        0,
        0,
      );
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const content = result.content?.[0];
      if (!content || content.type !== "text")
        return new Text("(no output)", 0, 0);
      return boxRendererWindowed(
        () => [textSection(undefined, content.text)],
        {
          collapsed: { excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
        expanded,
      );
    },

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as CreateFileParams;
      const resolved = resolveToAbsolute(p.path, ctx.cwd);
      const verdict = toolPolicy.evaluateToolPolicy(
        "write",
        {
          path: resolved,
          sessionCwd: ctx.cwd,
        },
        toolPolicy.loadToolPolicy(),
      );
      if (verdict.action === "reject") {
        return {
          content: [
            {
              type: "text" as const,
              text: verdict.message
                ? `path rejected: ${verdict.message}`
                : "path rejected by tool policy.",
            },
          ],
          isError: true,
        } as any;
      }

      return withFileLock(resolved, async () => {
        // capture before-state for undo tracking
        const isNewFile = !fs.existsSync(resolved);
        const beforeContent = isNewFile
          ? ""
          : fs.readFileSync(resolved, "utf-8");

        // mkdirp
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(resolved, p.content, "utf-8");

        // track change for undo_edit
        const sessionId = ctx.sessionManager.getSessionId();
        const diff = simpleDiff(resolved, beforeContent, p.content);
        saveChange(sessionId, toolCallId, {
          uri: `file://${resolved}`,
          before: beforeContent,
          after: p.content,
          diff,
          isNewFile,
          timestamp: Date.now(),
        });

        const lines = p.content.split("\n").length;
        let result = isNewFile
          ? `created ${path.basename(resolved)} (${lines} lines)`
          : `overwrote ${path.basename(resolved)} (${lines} lines)`;

        return {
          content: [{ type: "text" as const, text: result }],
          details: { header: resolved },
        } as any;
      });
    },
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool(withPromptPatch(createCreateFileTool()));
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("create-file tool policy", () => {
    it("rejects disallowed paths before writes", async () => {
      const tool = createCreateFileTool();
      const evaluateToolPolicySpy = vi
        .spyOn(toolPolicy, "evaluateToolPolicy")
        .mockReturnValue({ action: "reject", message: "workspace only" });
      vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([]);
      const getSessionId = vi.fn(() => "s");

      const result = (await tool.execute!(
        "test-id",
        { path: "../sibling/new.txt", content: "hello" },
        undefined,
        undefined,
        { cwd: "/repo/project", sessionManager: { getSessionId } } as any,
      )) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("path rejected: workspace only");
      expect(evaluateToolPolicySpy).toHaveBeenCalledWith(
        "write",
        { path: "/repo/sibling/new.txt", sessionCwd: "/repo/project" },
        [],
      );
      expect(getSessionId).not.toHaveBeenCalled();
    });
  });
}
