/**
 * undo_edit tool — reverts an explicitly identified file change.
 *
 * mutex-locked to prevent concurrent undo + edit on the same file.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { Type } from "typebox";
import {
  canonicalFilePath,
  loadChange,
  revertChange,
  simpleDiff,
} from "@bds_pi/file-tracker";
import { withFileLock } from "@bds_pi/mutex";
import { resolveToAbsolute, resolveWithVariants } from "@bds_pi/fs";
import * as toolPolicy from "@bds_pi/tool-policy";
import {
  renderLifecycleCall,
  boxRendererWindowed,
  framedTextRenderer,
  textSection,
  osc8Link,
  type Excerpt,
} from "@bds_pi/box-format";

const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

interface UndoEditParams {
  path: string;
  changeId: string;
  sessionId?: string;
}

export function createUndoEditTool(): ToolDefinition<any> {
  return {
    name: "undo_edit",
    label: "Undo Edit",
    description:
      "Undo an explicit changeId returned by apply_patch or format_file for the specified path. Refuses if the file differs from the recorded post-edit state. Returns the reverse diff.",

    parameters: Type.Object({
      changeId: Type.String({
        description: "Change ID returned by the edit tool.",
      }),
      sessionId: Type.Optional(
        Type.String({
          description:
            "Origin sessionId returned by the edit tool. Omit only for changes created in the current session.",
        }),
      ),
      path: Type.String({
        description:
          "The path recorded for this change; must match the change ID's file.",
      }),
    }),

    renderCall(args: any, theme: any, context: any) {
      const filePath = args.path || "...";
      const home = os.homedir();
      const shortened = filePath.startsWith(home)
        ? `~${filePath.slice(home.length)}`
        : filePath;
      const linked = filePath.startsWith("/")
        ? osc8Link(`file://${filePath}`, shortened)
        : shortened;
      return renderLifecycleCall(
        new Text(
          theme.fg("toolTitle", theme.bold("Undo ")) + theme.fg("dim", linked),
          0,
          0,
        ),
        theme,
        context,
      );
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const content = result.content?.[0];
      if (!content || content.type !== "text")
        return framedTextRenderer("(no output)", expanded);
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

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as UndoEditParams;
      const requestedPath = resolveToAbsolute(p.path, ctx.cwd);
      const resolved = resolveWithVariants(requestedPath, ctx.cwd);
      const canonical = canonicalFilePath(resolved);
      const verdict = toolPolicy.evaluateToolPolicy(
        "undo_edit",
        {
          path: canonical,
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

      return withFileMutationQueue(canonical, () =>
        withFileLock(canonical, async () => {
          const sessionId = p.sessionId ?? ctx.sessionManager.getSessionId();
          const change = loadChange(sessionId, p.changeId);
          if (
            !change ||
            canonicalFilePath(change.uri.replace(/^file:\/\//, "")) !==
              canonical
          ) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `change ID not found for ${path.basename(resolved)}.`,
                },
              ],
              isError: true,
            } as any;
          }

          const reverted = revertChange(sessionId, p.changeId);
          if (!reverted) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `failed to revert — change may have already been undone.`,
                },
              ],
              isError: true,
            } as any;
          }

          // show reverse diff (after → before)
          const diff = simpleDiff(
            path.basename(resolved),
            reverted.after,
            reverted.before,
          );

          let result = diff;
          if (reverted.isNewFile) {
            result += `\n\n(file was created by the reverted patch — file removed)`;
          }

          return {
            content: [{ type: "text" as const, text: result }],
            details: {
              header: resolved,
              changeId: reverted.id,
              path: canonical,
              reverted: true,
            },
          } as any;
        }),
      );
    },
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool(withPromptPatch(createUndoEditTool()));
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("undo-edit tool policy", () => {
    it("undoes explicit nested-call changes without history and protects unrelated or diverged files", async () => {
      const { createApplyPatchTool } = await import("@bds_pi/apply-patch");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-explicit-undo-"));
      const trackerGlobal = globalThis as typeof globalThis & {
        __PI_FILE_CHANGES_DIR__?: string;
      };
      const previousDir = trackerGlobal.__PI_FILE_CHANGES_DIR__;
      trackerGlobal.__PI_FILE_CHANGES_DIR__ = path.join(root, ".changes");
      vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([]);
      vi.spyOn(toolPolicy, "evaluateToolPolicy").mockReturnValue({
        action: "allow",
      });
      const ctx = {
        cwd: root,
        sessionManager: { getSessionId: () => "session/nested" },
      } as any;
      const file = path.join(root, "edited.txt");
      const unrelated = path.join(root, "unrelated.txt");
      try {
        fs.writeFileSync(file, "before\n");
        fs.writeFileSync(unrelated, "unrelated\n");
        const edited = await createApplyPatchTool().execute(
          "outer/inner/0",
          {
            input:
              "*** Begin Patch\n*** Update File: edited.txt\n@@\n-before\n+after\n*** End Patch",
          },
          undefined,
          undefined,
          ctx,
        );
        const changeId = (edited.details as { changes: { changeId: string }[] })
          .changes[0]!.changeId;
        expect(changeId).toMatch(/^[0-9a-f-]{36}$/);
        const undo = createUndoEditTool();
        const wrongPath = await undo.execute(
          "outer/undo/0",
          { path: unrelated, changeId },
          undefined,
          undefined,
          ctx,
        );
        expect(wrongPath).toMatchObject({ isError: true });
        expect(fs.readFileSync(file, "utf8")).toBe("after\n");
        expect(fs.readFileSync(unrelated, "utf8")).toBe("unrelated\n");
        fs.writeFileSync(file, "later\n");
        await expect(
          undo.execute(
            "outer/undo/1",
            { path: file, changeId },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("changed file");
        expect(fs.readFileSync(file, "utf8")).toBe("later\n");
        fs.writeFileSync(file, "after\n");
        const restored = await undo.execute(
          "outer/undo/2",
          { path: file, changeId, sessionId: "session/nested" },
          undefined,
          undefined,
          { cwd: root } as any,
        );
        expect(restored.details).toMatchObject({ changeId, reverted: true });
        expect(fs.readFileSync(file, "utf8")).toBe("before\n");
        expect(fs.readFileSync(unrelated, "utf8")).toBe("unrelated\n");
        const repeated = await undo.execute(
          "outer/undo/3",
          { path: file, changeId },
          undefined,
          undefined,
          ctx,
        );
        expect(repeated).toMatchObject({ isError: true });
      } finally {
        if (previousDir === undefined)
          delete trackerGlobal.__PI_FILE_CHANGES_DIR__;
        else trackerGlobal.__PI_FILE_CHANGES_DIR__ = previousDir;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("rejects disallowed paths before undo lookup", async () => {
      const tool = createUndoEditTool();
      const evaluateToolPolicySpy = vi
        .spyOn(toolPolicy, "evaluateToolPolicy")
        .mockReturnValue({ action: "reject", message: "workspace only" });
      vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([]);
      const getSessionId = vi.fn(() => "s");

      const result = await tool.execute!(
        "test-id",
        { path: "../sibling/file.txt" },
        undefined,
        undefined,
        { cwd: "/repo/project", sessionManager: { getSessionId } } as any,
      );

      expect("isError" in result && result.isError).toBe(true);
      expect(result.content.find((part) => part.type === "text")?.text).toBe(
        "path rejected: workspace only",
      );
      expect(evaluateToolPolicySpy).toHaveBeenCalledWith(
        "undo_edit",
        { path: "/repo/sibling/file.txt", sessionCwd: "/repo/project" },
        [],
      );
      expect(getSessionId).not.toHaveBeenCalled();
    });
  });
}
