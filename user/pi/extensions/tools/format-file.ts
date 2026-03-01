/**
 * format_file tool — runs a code formatter on a file.
 *
 * tries formatters in order: prettier, biome. uses whichever is
 * available on PATH (nix provides these). captures before/after
 * diff and tracks the change for undo_edit.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { saveChange, simpleDiff } from "./lib/file-tracker";
import { withFileLock } from "./lib/mutex";
import { resolveWithVariants } from "./read";
import {
  boxRendererWindowed,
  textSection,
  osc8Link,
  type Excerpt,
} from "./lib/box-format";

const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

type Formatter = { name: string; args: (file: string) => string[] };

const FORMATTERS: Formatter[] = [
  {
    name: "prettier",
    args: (file) => ["--write", "--log-level", "silent", file],
  },
  {
    name: "biome",
    args: (file) => ["format", "--write", file],
  },
];

function findFormatter(): Formatter | null {
  for (const fmt of FORMATTERS) {
    const result = spawnSync("which", [fmt.name], {
      encoding: "utf-8",
      timeout: 3000,
    });
    if (result.status === 0) return fmt;
  }
  return null;
}

export function createFormatFileTool(): ToolDefinition {
  return {
    name: "format_file",
    label: "Format File",
    description: "Run a code formatter (prettier or biome) on a file.",

    parameters: Type.Object({
      path: Type.String({
        description: "The absolute path to the file to format.",
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
        theme.fg("toolTitle", theme.bold("Format ")) + theme.fg("dim", linked),
        0,
        0,
      );
    },

    renderResult(result: any, _opts: { expanded: boolean }, _theme: any) {
      const content = result.content?.[0];
      if (!content || content.type !== "text")
        return new Text("(no output)", 0, 0);
      return boxRendererWindowed(() => [textSection(undefined, content.text)], {
        collapsed: { excerpts: COLLAPSED_EXCERPTS },
        expanded: {},
      });
    },

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const resolved = resolveWithVariants(params.path, ctx.cwd);

      if (!fs.existsSync(resolved)) {
        return {
          content: [
            { type: "text" as const, text: `file not found: ${resolved}` },
          ],
          isError: true,
        } as any;
      }

      const formatter = findFormatter();
      if (!formatter) {
        return {
          content: [
            {
              type: "text" as const,
              text: "no formatter found. install prettier or biome.",
            },
          ],
          isError: true,
        } as any;
      }

      return withFileLock(resolved, async () => {
        const before = fs.readFileSync(resolved, "utf-8");

        const result = spawnSync(formatter.name, formatter.args(resolved), {
          encoding: "utf-8",
          timeout: 30_000,
          cwd: ctx.cwd,
        });

        if (result.status !== 0) {
          const err =
            result.stderr?.trim() ||
            result.stdout?.trim() ||
            `exit code ${result.status}`;
          return {
            content: [
              {
                type: "text" as const,
                text: `${formatter.name} failed: ${err}`,
              },
            ],
            isError: true,
          } as any;
        }

        const after = fs.readFileSync(resolved, "utf-8");

        if (before === after) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${path.basename(resolved)} is already formatted.`,
              },
            ],
            details: { header: resolved },
          } as any;
        }

        // track for undo_edit
        const sessionId = ctx.sessionManager.getSessionId();
        const diff = simpleDiff(resolved, before, after);
        saveChange(sessionId, toolCallId, {
          uri: `file://${resolved}`,
          before,
          after,
          diff,
          isNewFile: false,
          timestamp: Date.now(),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `formatted ${path.basename(resolved)} with ${formatter.name}.\n\n${diff}`,
            },
          ],
          details: { header: resolved },
        } as any;
      });
    },
  };
}
