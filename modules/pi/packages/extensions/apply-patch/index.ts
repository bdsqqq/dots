import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  renderDiff,
  withFileMutationQueue,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, MarkerColumn, Spacer, Text } from "@earendil-works/pi-tui";
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
import { renderLifecycleCall } from "@bds_pi/box-format";

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

const mutationFs = {
  writeFileSync(file: string, content: string): void {
    fs.writeFileSync(file, content, "utf8");
  },
};

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
  const beforeLines =
    operation.type === "update"
      ? operation.chunks.flatMap((chunk) => chunk.oldLines)
      : [];
  const afterLines =
    operation.type === "add"
      ? operation.content.split("\n")
      : operation.type === "update"
        ? operation.chunks.flatMap((chunk) => chunk.newLines)
        : [];
  for (const pattern of REDACTION_PATTERNS) {
    const beforeCount = beforeLines.filter((line) => pattern.test(line)).length;
    const matches = afterLines.filter((line) => pattern.test(line));
    if (matches.length > beforeCount) {
      throw new Error(
        `patch rejected: added content contains placeholder '${matches[0]}'; include the actual content`,
      );
    }
  }
}

function snapshot(file: string): Snapshot {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: file, exists: false };
    }
    throw error;
  }
  if (pathStat.isSymbolicLink()) {
    throw new Error(`symbolic link paths are not supported: ${file}`);
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  if (stat.nlink > 1) {
    throw new Error(`hard-linked files are not supported: ${file}`);
  }
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
  const source = path.resolve(resolveToAbsolute(operation.path, cwd));
  const destination =
    operation.type === "update" && operation.movePath
      ? path.resolve(resolveToAbsolute(operation.movePath, cwd))
      : undefined;
  if (destination === source) {
    throw new Error(
      `patch move source and destination are identical: ${source}`,
    );
  }
  return { source, destination };
}

function canonicalMutationPath(file: string): string {
  const suffix: string[] = [];
  let ancestor = file;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

function usesCaseInsensitivePaths(file: string): boolean {
  let ancestor = file;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
  while (true) {
    const name = path.basename(ancestor);
    const index = name.search(/[a-z]/i);
    if (index >= 0) {
      const character = name[index]!;
      const swapped =
        character === character.toLowerCase()
          ? character.toUpperCase()
          : character.toLowerCase();
      const variant = path.join(
        path.dirname(ancestor),
        `${name.slice(0, index)}${swapped}${name.slice(index + 1)}`,
      );
      if (variant !== ancestor && fs.existsSync(variant)) {
        return fs.realpathSync(variant) === fs.realpathSync(ancestor);
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
}

function pathComparisonKey(file: string): string {
  return usesCaseInsensitivePaths(file) ? file.toLowerCase() : file;
}

function assertNoPathHierarchyConflicts(files: string[]): void {
  for (const ancestor of files) {
    for (const descendant of files) {
      if (ancestor === descendant) continue;
      const relative = path.relative(ancestor, descendant);
      if (
        relative &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
      ) {
        throw new Error(
          `patch paths cannot contain one another: ${ancestor}, ${descendant}`,
        );
      }
    }
  }
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

function missingParentDirectories(files: string[]): string[] {
  const missing = new Set<string>();
  for (const file of files) {
    let directory = path.dirname(file);
    while (!fs.existsSync(directory)) {
      missing.add(directory);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...missing].sort((a, b) => b.length - a.length);
}

function restoreSnapshots(
  snapshots: Snapshot[],
  createdDirectories: string[] = [],
): void {
  const errors: unknown[] = [];
  for (const before of snapshots) {
    try {
      if (!before.exists) {
        fs.rmSync(before.path, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(before.path), { recursive: true });
      mutationFs.writeFileSync(before.path, before.content ?? "");
      if (before.mode !== undefined) fs.chmodSync(before.path, before.mode);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const directory of createdDirectories) {
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "apply_patch rollback was incomplete");
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
  finalModes: Map<string, number | undefined>,
  createdDirectories: string[],
): void {
  try {
    for (const before of snapshots) {
      const after = finalContents.get(before.path);
      if (after === undefined) {
        fs.rmSync(before.path, { force: true });
      } else {
        fs.mkdirSync(path.dirname(before.path), { recursive: true });
        mutationFs.writeFileSync(before.path, after);
        const mode = finalModes.get(before.path);
        if (mode !== undefined) fs.chmodSync(before.path, mode);
      }
    }
  } catch (error) {
    try {
      restoreSnapshots(snapshots, createdDirectories);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "apply_patch failed and rollback was incomplete",
      );
    }
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
      "Apply a Codex-format patch as a validated batch. Supports Add File, Update File, Delete File, Move to, multiple files, and multiple hunks. Every update must match before commit; ordinary write or tracking failures are rolled back. Process termination during commit is not crash-safe.",
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
      if (!context.isPartial || !args?.input)
        return renderLifecycleCall(new Text(header, 0, 0), theme, context);
      const component = new Container();
      component.addChild(new Text(header, 0, 0));
      component.addChild(new Spacer(1));
      component.addChild(new Text(args.input, 0, 0));
      return renderLifecycleCall(component, theme, context);
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("apply_patch aborted");
      const operations = parseCodexPatch(params.input);
      operations.forEach(assertNoRedaction);
      const resolved = operations.map((operation) => ({
        operation,
        ...operationPaths(operation, ctx.cwd),
      }));
      const allPaths = [
        ...new Set(
          resolved.flatMap(({ source, destination }) =>
            destination ? [source, destination] : [source],
          ),
        ),
      ];
      const canonicalPaths = allPaths.map(canonicalMutationPath);
      const comparisonPaths = canonicalPaths.map(pathComparisonKey);
      assertNoPathHierarchyConflicts(comparisonPaths);
      const aliases = comparisonPaths.filter(
        (file, index) => comparisonPaths.indexOf(file) !== index,
      );
      if (aliases.length > 0) {
        throw new Error(
          `patch paths resolve to the same file: ${[...new Set(aliases)].join(", ")}`,
        );
      }

      const verdict = toolPolicy.evaluateToolPolicy(
        "apply_patch",
        { paths: canonicalPaths, sessionCwd: ctx.cwd },
        toolPolicy.loadToolPolicy(),
      );
      if (verdict.action === "reject") {
        throw new Error(verdict.message ?? "patch rejected by tool policy");
      }

      return withMutationQueues(canonicalPaths, () =>
        withFileLocks(canonicalPaths, async () => {
          const snapshots = allPaths.map(snapshot);
          const createdDirectories = missingParentDirectories(allPaths);
          const byPath = new Map(snapshots.map((item) => [item.path, item]));
          const finalContents = new Map<string, string | undefined>(
            snapshots.map((item) => [item.path, item.content]),
          );
          const finalModes = new Map<string, number | undefined>(
            snapshots.map((item) => [item.path, item.mode]),
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
              finalModes.set(source, undefined);
            } else {
              if (current === undefined)
                throw new Error(`file not found: ${source}`);
              const updated = applyPatchChunks(
                current,
                operation.chunks,
                source,
              );
              if (destination) {
                const sourceMode = finalModes.get(source);
                finalContents.set(source, undefined);
                finalModes.set(source, undefined);
                finalContents.set(destination, updated);
                finalModes.set(destination, sourceMode);
              } else {
                finalContents.set(source, updated);
              }
            }
          }

          const changes: PlannedChange[] = [];
          for (const before of snapshots) {
            const after = finalContents.get(before.path);
            const afterExists = after !== undefined;
            const afterMode = finalModes.get(before.path);
            if (
              before.content === after &&
              before.exists === afterExists &&
              before.mode === afterMode
            ) {
              continue;
            }
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

          commitChanges(
            snapshots,
            finalContents,
            finalModes,
            createdDirectories,
          );
          const sessionId = ctx.sessionManager.getSessionId();
          try {
            fileTracker.saveChanges(
              sessionId,
              toolCallId,
              changes.map((change) => ({
                uri: `file://${change.path}`,
                before: change.before,
                after: change.after,
                diff: change.diff,
                isNewFile: !byPath.get(change.path)?.exists,
                beforeExists: byPath.get(change.path)?.exists ?? false,
                afterExists: finalContents.get(change.path) !== undefined,
                beforeMode: byPath.get(change.path)?.mode,
                afterMode:
                  finalContents.get(change.path) === undefined
                    ? undefined
                    : fs.statSync(change.path).mode,
                timestamp: Date.now(),
              })),
            );
          } catch (error) {
            try {
              restoreSnapshots(snapshots, createdDirectories);
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "apply_patch tracking failed and rollback was incomplete",
              );
            }
            throw error;
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
      const frame = () => {
        const marker = theme.fg("muted", "│");
        return new MarkerColumn(marker, component, {
          continuationMarker: marker,
          footerMarker: theme.fg("muted", "╰────"),
        });
      };
      const changes = result.details?.changes ?? [];
      if (changes.length === 0) {
        const text = (result.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        component.addChild(new Text(text || "(no changes)", 0, 0));
        return frame();
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
      return frame();
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
    (
      globalThis as typeof globalThis & {
        __PI_FILE_CHANGES_DIR__?: string;
      }
    ).__PI_FILE_CHANGES_DIR__ = path.join(cwd, ".changes");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (
      globalThis as typeof globalThis & {
        __PI_FILE_CHANGES_DIR__?: string;
      }
    ).__PI_FILE_CHANGES_DIR__;
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function context(sessionCwd = cwd) {
    return {
      cwd: sessionCwd,
      sessionManager: { getSessionId: () => "test-session" },
    } as never;
  }

  function fileTree(root: string): Record<string, string> {
    if (!fs.existsSync(root)) return {};
    const tree: Record<string, string> = {};
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else {
          tree[path.relative(root, absolute)] = fs
            .readFileSync(absolute)
            .toString("base64");
        }
      }
    };
    visit(root);
    return tree;
  }

  it("closes fallback and structured results with one open frame", async () => {
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme("dark", false);
    const tool = createApplyPatchTool();
    const theme = { fg: (_color: string, text: string) => text };
    const results = [
      {
        content: [{ type: "text" as const, text: "patch rejected" }],
        details: { changes: [] },
      },
      {
        content: [{ type: "text" as const, text: "modified file.txt" }],
        details: {
          changes: [
            {
              path: "file.txt",
              kind: "modified" as const,
              diff: "@@\n-old\n+new",
            },
          ],
        },
      },
    ];

    for (const result of results) {
      const component = tool.renderResult!(
        result,
        { expanded: false, isPartial: false },
        theme as never,
        {} as never,
      );
      const lines = component.render(80).map((line) => line.trimEnd());

      expect(lines.slice(0, -1).every((line) => line.startsWith("│"))).toBe(
        true,
      );
      expect(lines.filter((line) => line === "╰────")).toHaveLength(1);
      expect(lines.at(-1)).toBe("╰────");
    }
  });

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
    expect(fileTracker.loadChanges("test-session", "call")).toHaveLength(5);
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

  it("applies repeated operations to one path in order", async () => {
    fs.writeFileSync(path.join(cwd, "x.txt"), "one\n", "utf8");

    await createApplyPatchTool().execute(
      "call",
      {
        input: `*** Begin Patch
*** Update File: x.txt
@@
-one
+two
*** Update File: x.txt
@@
-two
+three
*** End Patch`,
      },
      undefined,
      undefined,
      context(),
    );

    expect(fs.readFileSync(path.join(cwd, "x.txt"), "utf8")).toBe("three\n");
    expect(fileTracker.loadChanges("test-session", "call")).toHaveLength(1);
  });

  it("rejects lexical paths that resolve to the same file without hanging", async () => {
    fs.writeFileSync(path.join(cwd, "target.txt"), "old\n", "utf8");
    fs.symlinkSync("target.txt", path.join(cwd, "alias.txt"));

    await expect(
      createApplyPatchTool().execute(
        "call",
        {
          input: `*** Begin Patch
*** Update File: target.txt
@@
-old
+target
*** Update File: alias.txt
@@
-old
+alias
*** End Patch`,
        },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("resolve to the same file");
    expect(fs.readFileSync(path.join(cwd, "target.txt"), "utf8")).toBe("old\n");
  });

  it("rejects paths that are hard links to the same file", async () => {
    fs.writeFileSync(path.join(cwd, "one.txt"), "old\n", "utf8");
    fs.linkSync(path.join(cwd, "one.txt"), path.join(cwd, "two.txt"));
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      "-old",
      "+one",
      "*** Update File: two.txt",
      "@@",
      "-old",
      "+two",
      "*** End Patch",
    ].join("\n");

    await expect(
      createApplyPatchTool().execute(
        "call",
        { input: patch },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("hard-linked");
    expect(fs.readFileSync(path.join(cwd, "one.txt"), "utf8")).toBe("old\n");
    expect(fs.readFileSync(path.join(cwd, "two.txt"), "utf8")).toBe("old\n");
  });

  it("rejects dangling symbolic links before writing their targets", async () => {
    fs.symlinkSync("missing-target.txt", path.join(cwd, "alias.txt"));
    const patch = [
      "*** Begin Patch",
      "*** Add File: alias.txt",
      "+content",
      "*** End Patch",
    ].join("\n");

    await expect(
      createApplyPatchTool().execute(
        "call",
        { input: patch },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("symbolic link");
    expect(fs.readlinkSync(path.join(cwd, "alias.txt"))).toBe(
      "missing-target.txt",
    );
    expect(fs.existsSync(path.join(cwd, "missing-target.txt"))).toBe(false);
  });

  it("rejects paths that are ancestors of other patch paths", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: a/b.txt",
      "+nested",
      "*** Add File: a",
      "+file",
      "*** End Patch",
    ].join("\n");

    await expect(
      createApplyPatchTool().execute(
        "call",
        { input: patch },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("cannot contain one another");
    expect(fs.existsSync(path.join(cwd, "a"))).toBe(false);
  });

  it("rejects case-folded path hierarchy conflicts", async () => {
    if (!usesCaseInsensitivePaths(cwd)) return;
    const patch = [
      "*** Begin Patch",
      "*** Add File: a/b.txt",
      "+nested",
      "*** Add File: A",
      "+file",
      "*** End Patch",
    ].join("\n");

    await expect(
      createApplyPatchTool().execute(
        "call",
        { input: patch },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("cannot contain one another");
    expect(fs.existsSync(path.join(cwd, "a"))).toBe(false);
  });

  it("normalizes dot segments before creating parent directories", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: ghost/../target.txt",
      "+content",
      "*** End Patch",
    ].join("\n");

    await createApplyPatchTool().execute(
      "call",
      { input: patch },
      undefined,
      undefined,
      context(),
    );

    expect(fs.readFileSync(path.join(cwd, "target.txt"), "utf8")).toBe(
      "content\n",
    );
    expect(fs.existsSync(path.join(cwd, "ghost"))).toBe(false);
  });

  it("rolls back committed files and directories when tracking fails", async () => {
    fs.writeFileSync(path.join(cwd, "existing.txt"), "old\n", "utf8");
    vi.spyOn(fileTracker, "saveChanges").mockImplementation(() => {
      throw new Error("tracker unavailable");
    });

    await expect(
      createApplyPatchTool().execute(
        "call",
        {
          input: `*** Begin Patch
*** Update File: existing.txt
@@
-old
+new
*** Add File: nested/new.txt
+new
*** End Patch`,
        },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("tracker unavailable");
    expect(fs.readFileSync(path.join(cwd, "existing.txt"), "utf8")).toBe(
      "old\n",
    );
    expect(fs.existsSync(path.join(cwd, "nested"))).toBe(false);
  });

  it("rolls back earlier writes when a later filesystem write fails", async () => {
    fs.writeFileSync(path.join(cwd, "existing.txt"), "old\n", "utf8");
    let writes = 0;
    vi.spyOn(mutationFs, "writeFileSync").mockImplementation(
      (file, content) => {
        writes++;
        if (writes === 2) throw new Error("injected write failure");
        fs.writeFileSync(file, content, "utf8");
      },
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      "-old",
      "+new",
      "*** Add File: nested/new.txt",
      "+new",
      "*** End Patch",
    ].join("\n");

    await expect(
      createApplyPatchTool().execute(
        "call",
        { input: patch },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("injected write failure");
    expect(fs.readFileSync(path.join(cwd, "existing.txt"), "utf8")).toBe(
      "old\n",
    );
    expect(fs.existsSync(path.join(cwd, "nested"))).toBe(false);
  });

  it("preserves source mode when moving a file", async () => {
    const source = path.join(cwd, "script.sh");
    fs.writeFileSync(source, "#!/bin/sh\nold\n", "utf8");
    fs.chmodSync(source, 0o755);
    const patch = [
      "*** Begin Patch",
      "*** Update File: script.sh",
      "*** Move to: nested/script.sh",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    await createApplyPatchTool().execute(
      "call",
      { input: patch },
      undefined,
      undefined,
      context(),
    );

    expect(fs.statSync(path.join(cwd, "nested/script.sh")).mode & 0o777).toBe(
      0o755,
    );
  });

  it("tracks a mode-only change when moving over identical content", async () => {
    const source = path.join(cwd, "source.sh");
    const destination = path.join(cwd, "destination.sh");
    fs.writeFileSync(source, "same\n", "utf8");
    fs.chmodSync(source, 0o755);
    fs.writeFileSync(destination, "same\n", "utf8");
    fs.chmodSync(destination, 0o644);
    const patch = [
      "*** Begin Patch",
      "*** Update File: source.sh",
      "*** Move to: destination.sh",
      "*** End Patch",
    ].join("\n");

    await createApplyPatchTool().execute(
      "call",
      { input: patch },
      undefined,
      undefined,
      context(),
    );

    expect(fs.statSync(destination).mode & 0o777).toBe(0o755);
    const destinationChange = fileTracker
      .loadChanges("test-session", "call")
      .find((change) => change.uri.endsWith("/destination.sh"));
    expect(destinationChange).toMatchObject({
      beforeMode: expect.any(Number),
      afterMode: expect.any(Number),
    });
    expect(destinationChange!.beforeMode! & 0o777).toBe(0o644);
    expect(destinationChange!.afterMode! & 0o777).toBe(0o755);
  });

  it("rejects newly introduced placeholders without rejecting existing context", async () => {
    const placeholder = `[${"REDACTED"}]`;
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

    await expect(
      tool.execute(
        "call-3",
        {
          input: `*** Begin Patch
*** Update File: x.txt
@@
 // ${placeholder}
-new
+new
+// ${placeholder}
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
      {
        paths: [canonicalMutationPath(path.join(cwd, "x.txt"))],
        sessionCwd: cwd,
      },
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

  it.runIf(Boolean(process.env.CODEX_APPLY_PATCH_FIXTURES))(
    "matches the upstream Codex filesystem scenarios",
    async () => {
      const fixtures = process.env.CODEX_APPLY_PATCH_FIXTURES!;
      const successful = new Set([
        "001_add_file",
        "002_multiple_operations",
        "003_multiple_chunks",
        "004_move_to_new_directory",
        "010_move_overwrites_existing_destination",
        "011_add_overwrites_existing_file",
        "014_update_file_appends_trailing_newline",
        "016_pure_addition_update_chunk",
        "017_whitespace_padded_hunk_header",
        "018_whitespace_padded_patch_markers",
        "019_unicode_simple",
        "020_delete_file_success",
        "020_whitespace_padded_patch_marker_lines",
        "021_update_file_deletion_only",
        "022_update_file_end_of_file_marker",
      ]);

      for (const name of fs.readdirSync(fixtures)) {
        const fixture = path.join(fixtures, name);
        if (!fs.statSync(fixture).isDirectory()) continue;
        const work = path.join(cwd, name);
        const input = path.join(fixture, "input");
        fs.mkdirSync(work, { recursive: true });
        if (fs.existsSync(input)) {
          fs.cpSync(input, work, { recursive: true });
        }
        const initial = fileTree(work);
        const execution = createApplyPatchTool().execute(
          `fixture-${name}`,
          { input: fs.readFileSync(path.join(fixture, "patch.txt"), "utf8") },
          undefined,
          undefined,
          context(work),
        );

        if (successful.has(name)) {
          await execution;
          expect(fileTree(work), name).toEqual(
            fileTree(path.join(fixture, "expected")),
          );
        } else {
          await expect(execution, name).rejects.toThrow();
          expect(fileTree(work), name).toEqual(initial);
        }
      }
    },
  );
}
