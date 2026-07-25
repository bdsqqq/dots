import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  renderDiff,
  withFileMutationQueue,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static, type TObject, type TString } from "typebox";
import {
  applyPatchChunks,
  parseCodexPatch,
  type PatchOperation,
} from "@bds_pi/codex-patch";
import { resolveToAbsolute } from "@bds_pi/fs";
import * as fileTracker from "@bds_pi/file-tracker";
import { withFileLocks } from "@bds_pi/mutex";
import * as toolPolicy from "@bds_pi/tool-policy";

const APPLY_PATCH_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

const ApplyPatchParameters: TObject<{ input: TString }> = Type.Object(
  {
    input: Type.String({
      description:
        "Complete Codex patch envelope from *** Begin Patch through *** End Patch.",
    }),
  },
  { additionalProperties: false },
);

export type ApplyPatchParams = Static<typeof ApplyPatchParameters>;

interface Snapshot {
  path: string;
  exists: boolean;
  content?: string;
  mode?: number;
}

export interface ApplyPatchChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  diff: string;
}

interface PlannedChange extends ApplyPatchChange {
  before: string;
  after: string;
}

export interface ApplyPatchDetails {
  changes: ApplyPatchChange[];
}

const REDACTION_PATTERNS = [
  /\[REDACTED\]/i,
  /\[\.\.\.omitted.*?\]/i,
  /\[(?:rest|remaining) of .{1,40} unchanged\]/i,
  /\/\/ \.\.\.(?: rest| remaining)? (?:of )?(?:the )?(?:file|code|content|implementation).*(?:unchanged|omitted)/i,
  /(?:\/\/|#) \.\.\. existing (?:code|content|implementation)/i,
];

function assertNoRedaction(operation: PatchOperation): void {
  const before =
    operation.type === "update"
      ? operation.chunks.flatMap((chunk) => chunk.oldLines).join("\n")
      : "";
  const additions =
    operation.type === "add"
      ? operation.content
      : operation.type === "update"
        ? operation.chunks.flatMap((chunk) => chunk.newLines).join("\n")
        : "";
  for (const pattern of REDACTION_PATTERNS) {
    const match = additions.match(pattern);
    if (match && !pattern.test(before)) {
      throw new Error(
        `patch rejected: added content contains placeholder '${match[0]}'; include the actual content`,
      );
    }
  }
}

function snapshot(file: string): Snapshot {
  if (!fs.existsSync(file)) return { path: file, exists: false };
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  return {
    path: file,
    exists: true,
    content: fs.readFileSync(file, "utf8"),
    mode: stat.mode,
  };
}

function operationPaths(
  operation: PatchOperation,
  cwd: string,
): { source: string; destination?: string } {
  const source = resolveToAbsolute(operation.path, cwd);
  const destination =
    operation.type === "update" && operation.movePath
      ? resolveToAbsolute(operation.movePath, cwd)
      : undefined;
  if (destination === source) {
    throw new Error(
      `patch move source and destination are identical: ${source}`,
    );
  }
  return { source, destination };
}

function describeCall(input: string): string {
  const paths = input.split("\n").flatMap((line) => {
    const match = line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/);
    return match?.[1] ? [match[1]] : [];
  });
  return paths.length > 0 ? paths.join(", ") : "...";
}

function formatResult(changes: ApplyPatchChange[]): string {
  const marker = { added: "A", modified: "M", deleted: "D" } as const;
  return changes
    .map((change) => `${marker[change.kind]} ${change.path}`)
    .join("\n");
}

function restoreSnapshots(snapshots: Snapshot[]): void {
  for (const before of snapshots) {
    if (!before.exists) {
      fs.rmSync(before.path, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(before.path), { recursive: true });
    fs.writeFileSync(before.path, before.content ?? "", "utf8");
    if (before.mode !== undefined) fs.chmodSync(before.path, before.mode);
  }
}

function withMutationQueues<T>(
  files: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const paths = [...new Set(files)].sort();
  const acquire = (index: number): Promise<T> => {
    const file = paths[index];
    return file ? withFileMutationQueue(file, () => acquire(index + 1)) : fn();
  };
  return acquire(0);
}

function commitChanges(
  snapshots: Snapshot[],
  finalContents: Map<string, string | undefined>,
): void {
  try {
    for (const before of snapshots) {
      const after = finalContents.get(before.path);
      if (after === undefined) {
        fs.rmSync(before.path, { force: true });
      } else {
        fs.mkdirSync(path.dirname(before.path), { recursive: true });
        fs.writeFileSync(before.path, after, "utf8");
        if (before.mode !== undefined) fs.chmodSync(before.path, before.mode);
      }
    }
  } catch (error) {
    restoreSnapshots(snapshots);
    throw error;
  }
}

export function createApplyPatchTool(): ToolDefinition<
  typeof ApplyPatchParameters,
  ApplyPatchDetails
> {
  return {
    name: "apply_patch",
    label: "Apply Patch",
    description:
      "Apply a Codex-format patch transactionally. Supports Add File, Update File, Delete File, Move to, multiple files, and multiple hunks. Every update must match existing context or the entire patch fails without changing files.",
    promptSnippet: "Apply precise Codex-format patches to one or more files",
    promptGuidelines: [
      "Use apply_patch for all text file creation, modification, deletion, and moves instead of edit, write, or shell redirection.",
      "Keep apply_patch hunks small and include enough unchanged context for an unambiguous match.",
      "Split unrelated or very large apply_patch changes into consecutive calls.",
    ],
    parameters: ApplyPatchParameters,
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_GRAMMAR },
    },
    executionMode: "sequential",
    renderCall(args, theme, context) {
      const summary = describeCall(args?.input ?? "");
      const home = os.homedir();
      const display = summary.startsWith(home)
        ? `~${summary.slice(home.length)}`
        : summary;
      const header =
        theme.fg("toolTitle", theme.bold("apply_patch ")) +
        theme.fg("dim", display);
      if (!context.isPartial || !args?.input) return new Text(header, 0, 0);
      const component = new Container();
      component.addChild(new Text(header, 0, 0));
      component.addChild(new Spacer(1));
      component.addChild(new Text(args.input, 0, 0));
      return component;
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("apply_patch aborted");
      const operations = parseCodexPatch(params.input);
      operations.forEach(assertNoRedaction);
      const resolved = operations.map((operation) => ({
        operation,
        ...operationPaths(operation, ctx.cwd),
      }));
      const allPaths = resolved.flatMap(({ source, destination }) =>
        destination ? [source, destination] : [source],
      );
      const duplicates = allPaths.filter(
        (file, index) => allPaths.indexOf(file) !== index,
      );
      if (duplicates.length > 0) {
        throw new Error(
          `patch touches a path more than once: ${[...new Set(duplicates)].join(", ")}`,
        );
      }

      const verdict = toolPolicy.evaluateToolPolicy(
        "apply_patch",
        { paths: allPaths, sessionCwd: ctx.cwd },
        toolPolicy.loadToolPolicy(),
      );
      if (verdict.action === "reject") {
        throw new Error(verdict.message ?? "patch rejected by tool policy");
      }

      return withMutationQueues(allPaths, () =>
        withFileLocks(allPaths, async () => {
          const snapshots = allPaths.map(snapshot);
          const byPath = new Map(snapshots.map((item) => [item.path, item]));
          const finalContents = new Map<string, string | undefined>(
            snapshots.map((item) => [item.path, item.content]),
          );

          for (const { operation, source, destination } of resolved) {
            if (signal?.aborted) throw new Error("apply_patch aborted");
            const current = finalContents.get(source);
            if (operation.type === "add") {
              finalContents.set(source, operation.content);
            } else if (operation.type === "delete") {
              if (current === undefined)
                throw new Error(`file not found: ${source}`);
              finalContents.set(source, undefined);
            } else {
              if (current === undefined)
                throw new Error(`file not found: ${source}`);
              const updated = applyPatchChunks(
                current,
                operation.chunks,
                source,
              );
              if (destination) {
                finalContents.set(source, undefined);
                finalContents.set(destination, updated);
              } else {
                finalContents.set(source, updated);
              }
            }
          }

          const changes: PlannedChange[] = [];
          for (const before of snapshots) {
            const after = finalContents.get(before.path);
            if (before.content === after) continue;
            const beforeContent = before.content ?? "";
            const afterContent = after ?? "";
            changes.push({
              path: before.path,
              kind: !before.exists
                ? "added"
                : after === undefined
                  ? "deleted"
                  : "modified",
              before: beforeContent,
              after: afterContent,
              diff: fileTracker.simpleDiff(
                before.path,
                beforeContent,
                afterContent,
              ),
            });
          }
          if (changes.length === 0) throw new Error("patch made no changes");
          if (signal?.aborted) throw new Error("apply_patch aborted");

          commitChanges(snapshots, finalContents);
          const sessionId = ctx.sessionManager.getSessionId();
          for (const change of changes) {
            fileTracker.saveChange(sessionId, toolCallId, {
              uri: `file://${change.path}`,
              before: change.before,
              after: change.after,
              diff: change.diff,
              isNewFile: !byPath.get(change.path)?.exists,
              timestamp: Date.now(),
            });
          }

          const resultChanges = changes.map(
            ({ before: _before, after: _after, ...change }) => change,
          );
          return {
            content: [{ type: "text", text: formatResult(resultChanges) }],
            details: { changes: resultChanges },
          };
        }),
      );
    },
    renderResult(result, { expanded }, theme) {
      const component = new Container();
      const changes = result.details?.changes ?? [];
      if (changes.length === 0) {
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        component.addChild(new Text(text || "(no changes)", 0, 0));
        return component;
      }
      const shown = expanded ? changes : changes.slice(-1);
      component.addChild(
        new Text(
          theme.fg(
            "dim",
            `${changes.length} file${changes.length === 1 ? "" : "s"} changed`,
          ),
          0,
          0,
        ),
      );
      for (const change of shown) {
        component.addChild(new Spacer(1));
        component.addChild(new Text(renderDiff(change.diff), 0, 0));
      }
      return component;
    },
  };
}

export default function applyPatchExtension(pi: ExtensionAPI): void {
  pi.registerTool(createApplyPatchTool());
  pi.on("session_start", () => {
    const active = pi
      .getActiveTools()
      .filter((name) => name !== "edit" && name !== "write");
    pi.setActiveTools([...new Set([...active, "apply_patch"])]);
  });
}

if (import.meta.vitest) {
  const { afterEach, beforeEach, expect, it, vi } = import.meta.vitest;
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apply-patch-"));
    vi.spyOn(fileTracker, "saveChange").mockReturnValue("change-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function context() {
    return {
      cwd,
      sessionManager: { getSessionId: () => "test-session" },
    } as never;
  }

  it("applies multi-file patches and tracks add, update, delete, and move", async () => {
    fs.writeFileSync(path.join(cwd, "update.txt"), "old\n", "utf8");
    fs.writeFileSync(path.join(cwd, "delete.txt"), "gone\n", "utf8");
    fs.writeFileSync(path.join(cwd, "move.txt"), "before\n", "utf8");
    const tool = createApplyPatchTool();
    const result = await tool.execute(
      "call",
      {
        input: `*** Begin Patch
*** Add File: add.txt
+new
*** Update File: update.txt
@@
-old
+updated
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: nested/moved.txt
@@
-before
+after
*** End Patch`,
      },
      undefined,
      undefined,
      context(),
    );

    expect(fs.readFileSync(path.join(cwd, "add.txt"), "utf8")).toBe("new\n");
    expect(fs.readFileSync(path.join(cwd, "update.txt"), "utf8")).toBe(
      "updated\n",
    );
    expect(fs.existsSync(path.join(cwd, "delete.txt"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "move.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(cwd, "nested/moved.txt"), "utf8")).toBe(
      "after\n",
    );
    expect(result.details?.changes).toHaveLength(5);
  });

  it("does not commit any file when one hunk fails", async () => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "a\n", "utf8");
    fs.writeFileSync(path.join(cwd, "b.txt"), "b\n", "utf8");
    const tool = createApplyPatchTool();

    await expect(
      tool.execute(
        "call",
        {
          input: `*** Begin Patch
*** Update File: a.txt
@@
-a
+changed
*** Update File: b.txt
@@
-missing
+changed
*** End Patch`,
        },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("failed to find expected lines");
    expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("a\n");
    expect(fs.readFileSync(path.join(cwd, "b.txt"), "utf8")).toBe("b\n");
  });

  it("rejects newly introduced placeholders without rejecting existing context", async () => {
    fs.writeFileSync(path.join(cwd, "x.txt"), "// [REDACTED]\nold\n", "utf8");
    const tool = createApplyPatchTool();
    await tool.execute(
      "call",
      {
        input: `*** Begin Patch
*** Update File: x.txt
@@
 // [REDACTED]
-old
+new
*** End Patch`,
      },
      undefined,
      undefined,
      context(),
    );
    await expect(
      tool.execute(
        "call-2",
        {
          input: `*** Begin Patch
*** Update File: x.txt
@@
-new
+// [REDACTED]
*** End Patch`,
        },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("contains placeholder");
  });

  it("checks every touched path against tool policy before mutation", async () => {
    vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([]);
    const evaluate = vi
      .spyOn(toolPolicy, "evaluateToolPolicy")
      .mockReturnValue({ action: "reject", message: "workspace only" });
    const tool = createApplyPatchTool();

    await expect(
      tool.execute(
        "call",
        { input: "*** Begin Patch\n*** Add File: x.txt\n+x\n*** End Patch" },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("workspace only");
    expect(evaluate).toHaveBeenCalledWith(
      "apply_patch",
      { paths: [path.join(cwd, "x.txt")], sessionCwd: cwd },
      [],
    );
    expect(fs.existsSync(path.join(cwd, "x.txt"))).toBe(false);
  });

  it("requests OpenAI grammar-constrained freeform input", () => {
    expect(createApplyPatchTool().constrainedSampling).toMatchObject({
      type: "grammar",
      variants: { openai_lark: expect.stringContaining("begin_patch") },
    });
  });

  it("makes apply_patch the only active mutation tool", () => {
    let sessionStart: (() => void) | undefined;
    let active = ["read", "edit", "write", "bash"];
    const registered: string[] = [];
    const mockApi: Pick<
      ExtensionAPI,
      "registerTool" | "on" | "getActiveTools" | "setActiveTools"
    > = {
      registerTool(tool) {
        registered.push(tool.name);
      },
      on(event, handler) {
        if (event === "session_start") sessionStart = handler as () => void;
      },
      getActiveTools() {
        return active;
      },
      setActiveTools(tools) {
        active = tools;
      },
    };
    applyPatchExtension(mockApi as ExtensionAPI);

    sessionStart?.();

    expect(registered).toEqual(["apply_patch"]);
    expect(active).toEqual(["read", "bash", "apply_patch"]);
  });
}
