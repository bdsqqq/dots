/**
 * ls tool shadow — redirects to read's directory listing.
 *
 * directory listing is part of Read.
 * pi has a built-in ls tool that models may call by habit. this shadow
 * does the listing (no wasted tool call) but steers the model toward
 * using read for future calls.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
  listDirectory,
  resolveToAbsolute,
  resolveWithVariants,
} from "@bds_pi/fs";
import * as toolPolicy from "@bds_pi/tool-policy";
import { NORMAL_LIMITS, type ReadLimits } from "@bds_pi/read";
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

export function createLsTool(limits: ReadLimits): ToolDefinition<any> {
  return {
    name: "ls",
    label: "List Directory",
    description:
      "List directory contents. Prefer using the read tool instead — it handles both files and directories.",

    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "The absolute path to the directory to list. Defaults to cwd.",
        }),
      ),
    }),

    renderCall(args: any, theme: any) {
      const dirPath = args.path || ".";
      const home = os.homedir();
      const shortened = dirPath.startsWith(home)
        ? `~${dirPath.slice(home.length)}`
        : dirPath;
      const linked = dirPath.startsWith("/")
        ? osc8Link(`file://${dirPath}`, shortened)
        : shortened;
      return new Text(
        theme.fg("toolTitle", theme.bold("ls ")) + theme.fg("dim", linked),
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

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as { path?: string };
      const requestedPath = resolveToAbsolute(p.path ?? ctx.cwd, ctx.cwd);
      const verdict = toolPolicy.evaluateToolPolicy(
        "ls",
        {
          path: requestedPath,
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

      const resolved = resolveWithVariants(p.path ?? ctx.cwd, ctx.cwd);

      if (!fs.existsSync(resolved)) {
        return {
          content: [
            { type: "text" as const, text: `directory not found: ${resolved}` },
          ],
          isError: true,
        } as any;
      }

      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return {
          content: [
            {
              type: "text" as const,
              text: `not a directory: ${resolved}. use the read tool for files.`,
            },
          ],
          isError: true,
        } as any;
      }

      try {
        let text = listDirectory(resolved, limits.maxDirEntries);

        text +=
          "\n\n(note: prefer the read tool for directory listing — it handles both files and directories.)";

        return {
          content: [{ type: "text" as const, text }],
          details: { header: resolved },
        } as any;
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: err.message }],
          isError: true,
        } as any;
      }
    },
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool(withPromptPatch(createLsTool(NORMAL_LIMITS)));
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("ls tool policy", () => {
    it("rejects disallowed paths before directory checks", async () => {
      const tool = createLsTool(NORMAL_LIMITS);
      const evaluateToolPolicySpy = vi
        .spyOn(toolPolicy, "evaluateToolPolicy")
        .mockReturnValue({ action: "reject", message: "workspace only" });
      vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([]);

      const result = (await tool.execute!(
        "test-id",
        { path: "../sibling" },
        undefined,
        undefined,
        { cwd: "/repo/project" } as any,
      )) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("path rejected: workspace only");
      expect(evaluateToolPolicySpy).toHaveBeenCalledWith(
        "ls",
        { path: "/repo/sibling", sessionCwd: "/repo/project" },
        [],
      );
    });
  });
}
