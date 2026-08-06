/**
 * Injects descendant AGENTS.md context when tools enter a nested subtree.
 *
 * Pi loads context only from cwd and its ancestors. Tool-driven work can cross
 * into a descendant package later, so observations append newly applicable
 * context and known file-mutation tools pause once before changing the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseCodexPatch } from "@bds_pi/codex-patch";
import { resolveToAbsolute } from "@bds_pi/fs";

const CONTEXT_NAMES = [
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_EVENT_BYTES = 128 * 1024;
const MUTATION_TOOLS = new Set([
  "apply_patch",
  "edit",
  "write",
  "format_file",
  "undo_edit",
]);
const OBSERVATION_TOOLS = new Set(["read", "grep", "find", "ls", "look_at"]);

type TargetPath = {
  path: string;
  assumeFile: boolean;
};

export type NestedContextFile = {
  path: string;
  content: string;
};

class NestedContextPolicyError extends Error {}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function nearestExistingPath(candidate: string): {
  existing: string;
  suffix: string[];
} {
  const suffix: string[] = [];
  let current = candidate;
  for (;;) {
    try {
      fs.lstatSync(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("path has no existing ancestor");
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return { existing: current, suffix };
}

function resolveTargetDirectory(
  cwd: string,
  target: TargetPath,
): string | undefined {
  const root = fs.realpathSync(cwd);
  const requested = path.resolve(resolveToAbsolute(target.path.trim(), cwd));
  const { existing, suffix } = nearestExistingPath(requested);
  let canonicalExisting: string;
  try {
    canonicalExisting = fs.realpathSync(existing);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const canonicalRequested = path.join(canonicalExisting, ...suffix);
  if (!isWithin(root, canonicalRequested)) return undefined;
  if (target.assumeFile || suffix.length > 0) {
    const parent = path.dirname(canonicalRequested);
    return isWithin(root, parent) ? parent : undefined;
  }
  const stat = fs.statSync(canonicalRequested);
  const directory = stat.isDirectory()
    ? canonicalRequested
    : path.dirname(canonicalRequested);
  return isWithin(root, directory) ? directory : undefined;
}

function contextFileInDirectory(
  root: string,
  directory: string,
): string | undefined {
  for (const name of CONTEXT_NAMES) {
    const candidate = path.join(directory, name);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink())
      throw new NestedContextPolicyError(
        `nested context file must not be a symbolic link: ${candidate}`,
      );
    const canonical = fs.realpathSync(candidate);
    if (!isWithin(root, canonical))
      throw new NestedContextPolicyError(
        `nested context file escapes the workspace: ${candidate}`,
      );
    if (fs.statSync(canonical).isFile()) return canonical;
  }
  return undefined;
}

function readBoundedContext(file: string): NestedContextFile {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile())
      throw new NestedContextPolicyError(
        `nested context path is not a regular file: ${file}`,
      );
    if (metadata.size > MAX_FILE_BYTES)
      throw new NestedContextPolicyError(
        `nested context file exceeds ${MAX_FILE_BYTES} bytes: ${file}`,
      );
    const buffer = Buffer.alloc(metadata.size);
    const bytesRead = fs.readSync(descriptor, buffer, 0, metadata.size, 0);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let content: string;
    try {
      content = decoder.decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new NestedContextPolicyError(
        `nested context file is not valid UTF-8: ${file}`,
      );
    }
    return { path: file, content };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function discoverNestedContext(
  cwd: string,
  targets: TargetPath[],
): NestedContextFile[] {
  const root = fs.realpathSync(cwd);
  const found = new Map<string, NestedContextFile>();
  for (const target of targets) {
    const targetDirectory = resolveTargetDirectory(cwd, target);
    if (!targetDirectory) continue;
    let current = targetDirectory;
    while (current !== root && isWithin(root, current)) {
      const contextFile = contextFileInDirectory(root, current);
      if (contextFile && !found.has(contextFile))
        found.set(contextFile, readBoundedContext(contextFile));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...found.values()].sort((left, right) => {
    const leftDepth = path.relative(root, left.path).split(path.sep).length;
    const rightDepth = path.relative(root, right.path).split(path.sep).length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

function formatContext(files: NestedContextFile[]): string {
  return files
    .map((file) => `[Directory Context: ${file.path}]\n${file.content}`)
    .join("\n\n");
}

function textContent(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  return (content ?? [])
    .filter(
      (item): item is { type: string; text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function observationTargets(event: {
  toolName: string;
  input: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
}): TargetPath[] {
  const targets: TargetPath[] = [];
  const add = (value: unknown, assumeFile: boolean): void => {
    if (typeof value === "string" && value.trim())
      targets.push({ path: value, assumeFile });
  };
  if (event.toolName === "read" || event.toolName === "ls")
    add(event.input.path, false);
  if (event.toolName === "look_at") {
    add(event.input.path, true);
    stringArray(event.input.referenceFiles).forEach((file) => add(file, true));
  }
  if (event.toolName === "grep") {
    add(event.input.path, false);
    const details = event.details as
      | { fileGroups?: Array<{ path?: unknown }>; searchPath?: unknown }
      | undefined;
    const searchPathIsFile =
      typeof details?.searchPath === "string" &&
      fs.existsSync(details.searchPath) &&
      fs.statSync(details.searchPath).isFile();
    details?.fileGroups?.forEach((group) => {
      if (typeof group.path !== "string" || searchPathIsFile) return;
      add(
        typeof details.searchPath === "string"
          ? path.resolve(details.searchPath, group.path)
          : group.path,
        true,
      );
    });
    if (!details?.fileGroups?.length && !searchPathIsFile)
      for (const line of textContent(event.content).split("\n")) {
        const match = /^(.+?)(?::|-)\d+(?::|-)/.exec(line);
        if (!match?.[1]) continue;
        add(
          typeof event.input.path === "string"
            ? path.join(event.input.path, match[1])
            : match[1],
          true,
        );
      }
  }
  if (event.toolName === "find")
    for (const line of textContent(event.content).split("\n")) {
      const candidate = line.trim();
      if (
        candidate &&
        !candidate.startsWith("(") &&
        !candidate.startsWith("...")
      )
        add(
          typeof event.input.path === "string"
            ? path.join(event.input.path, candidate)
            : candidate,
          true,
        );
    }
  return targets;
}

function mutationTargets(event: {
  toolName: string;
  input: Record<string, unknown>;
}): TargetPath[] {
  if (event.toolName === "apply_patch") {
    if (typeof event.input.input !== "string") return [];
    try {
      return parseCodexPatch(event.input.input).flatMap((operation) => [
        { path: operation.path, assumeFile: true },
        ...(operation.type === "update" && operation.movePath
          ? [{ path: operation.movePath, assumeFile: true }]
          : []),
      ]);
    } catch {
      return [];
    }
  }
  return typeof event.input.path === "string"
    ? [{ path: event.input.path, assumeFile: true }]
    : [];
}

class ContextLedger {
  private readonly seen = new Set<string>();

  reset(): void {
    this.seen.clear();
  }

  take(cwd: string, targets: TargetPath[]): NestedContextFile[] {
    const selected: NestedContextFile[] = [];
    let bytes = 0;
    for (const file of discoverNestedContext(cwd, targets)) {
      if (this.seen.has(file.path)) continue;
      const size = Buffer.byteLength(
        `[Directory Context: ${file.path}]\n${file.content}`,
        "utf8",
      );
      if (bytes + size > MAX_EVENT_BYTES) continue;
      selected.push(file);
      this.seen.add(file.path);
      bytes += size;
    }
    return selected;
  }
}

export function createNestedAgentsExtension(): (pi: ExtensionAPI) => void {
  return function nestedAgentsExtension(pi: ExtensionAPI): void {
    const ledger = new ContextLedger();
    let mutationBarrier = false;
    const disabled = (): boolean => pi.getFlag("no-nested-agents") === true;

    pi.registerFlag("no-nested-agents", {
      description: "Disable descendant AGENTS.md context injection",
      type: "boolean",
      default: false,
    });

    pi.on("turn_start", () => {
      mutationBarrier = false;
    });
    pi.on("session_start", () => {
      ledger.reset();
      mutationBarrier = false;
    });
    pi.on("session_compact", () => {
      ledger.reset();
      mutationBarrier = false;
    });
    pi.on("session_tree", () => {
      ledger.reset();
      mutationBarrier = false;
    });
    pi.on("session_shutdown", () => {
      ledger.reset();
      mutationBarrier = false;
    });

    pi.on("tool_call", (event, ctx) => {
      if (disabled() || !MUTATION_TOOLS.has(event.toolName)) return;
      const targets = mutationTargets({
        toolName: event.toolName,
        input: event.input as Record<string, unknown>,
      });
      if (
        targets.some(
          (target) => resolveTargetDirectory(ctx.cwd, target) === undefined,
        )
      ) {
        mutationBarrier = true;
        return {
          block: true,
          reason:
            "Mutation paused: the target is outside the current workspace, so its project instructions cannot be established. Start Pi from that workspace before changing it.",
        };
      }
      let files: NestedContextFile[];
      try {
        files = ledger.take(ctx.cwd, targets);
      } catch (error) {
        if (!(error instanceof NestedContextPolicyError)) throw error;
        mutationBarrier = true;
        return { block: true, reason: `Mutation paused: ${error.message}` };
      }
      if (files.length === 0 && !mutationBarrier) return;
      mutationBarrier = true;
      return {
        block: true,
        reason:
          files.length > 0
            ? [
                "Mutation paused: nested project instructions apply to the target files.",
                "Follow these instructions, then retry the mutation in the next turn.",
                formatContext(files),
              ].join("\n\n")
            : "Mutation paused because another mutation in this tool batch required nested project instructions. Retry in the next turn.",
      };
    });

    pi.on("tool_result", (event, ctx) => {
      if (disabled() || event.isError || !OBSERVATION_TOOLS.has(event.toolName))
        return;
      let files: NestedContextFile[];
      try {
        files = ledger.take(
          ctx.cwd,
          observationTargets({
            toolName: event.toolName,
            input: event.input as Record<string, unknown>,
            content: event.content,
            details: event.details,
          }),
        );
      } catch (error) {
        if (!(error instanceof NestedContextPolicyError)) throw error;
        mutationBarrier = true;
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: `[Nested context unavailable: ${error.message}]`,
            },
          ],
        };
      }
      if (files.length === 0) return;
      mutationBarrier = true;
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: formatContext(files) },
        ],
      };
    });
  };
}

const nestedAgentsExtension: (pi: ExtensionAPI) => void =
  createNestedAgentsExtension();

export default nestedAgentsExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it } = import.meta.vitest;
  const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");

  const roots: string[] = [];
  afterEach(() => {
    roots
      .splice(0)
      .forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function fixture(): {
    root: string;
    file: string;
    nestedContext: string;
  } {
    const root = fs.realpathSync(
      mkdtempSync(path.join(tmpdir(), "nested-agents-")),
    );
    roots.push(root);
    mkdirSync(path.join(root, "packages/app/src"), { recursive: true });
    writeFileSync(path.join(root, "AGENTS.md"), "root rule\n");
    const nestedContext = path.join(root, "packages/AGENTS.md");
    writeFileSync(nestedContext, "package rule\n");
    writeFileSync(path.join(root, "packages/app/AGENTS.md"), "app rule\n");
    const file = path.join(root, "packages/app/src/index.ts");
    writeFileSync(file, "export {};\n");
    return { root, file, nestedContext };
  }

  function harness(): {
    handlers: Record<string, (...args: any[]) => any>;
    extension: ReturnType<typeof createNestedAgentsExtension>;
  } {
    const handlers: Record<string, (...args: any[]) => any> = {};
    const extension = createNestedAgentsExtension();
    extension({
      getFlag: () => false,
      registerFlag: () => {},
      on: (event: string, handler: (...args: any[]) => any) => {
        handlers[event] = handler;
      },
    } as any);
    return { handlers, extension };
  }

  describe("nested AGENTS.md context", () => {
    it("discovers descendant instructions outermost first and excludes cwd", () => {
      const { root, file } = fixture();
      expect(
        discoverNestedContext(root, [{ path: file, assumeFile: true }]).map(
          (item) => path.relative(root, item.path),
        ),
      ).toEqual(["packages/AGENTS.md", "packages/app/AGENTS.md"]);
    });

    it("fails closed for symbolic-link context files", () => {
      const { root, file } = fixture();
      const context = path.join(root, "packages/app/AGENTS.md");
      rmSync(context);
      symlinkSync(path.join(root, "missing-agents.md"), context);
      expect(() =>
        discoverNestedContext(root, [{ path: file, assumeFile: true }]).map(
          (item) => item.content.trim(),
        ),
      ).toThrow("symbolic link");
    });

    it("rejects targets that escape through a symlink", () => {
      const { root } = fixture();
      const outside = mkdtempSync(
        path.join(tmpdir(), "nested-agents-outside-"),
      );
      roots.push(outside);
      writeFileSync(path.join(outside, "AGENTS.md"), "outside rule\n");
      writeFileSync(path.join(outside, "secret.ts"), "secret\n");
      symlinkSync(outside, path.join(root, "escaped"));
      expect(
        discoverNestedContext(root, [
          { path: path.join(root, "escaped/secret.ts"), assumeFile: true },
        ]),
      ).toEqual([]);
    });

    it("appends context once after a successful read", () => {
      const { root, file } = fixture();
      const { handlers } = harness();
      const event = {
        toolName: "read",
        input: { path: file },
        content: [{ type: "text", text: "file body" }],
        details: {},
        isError: false,
      };
      const first = handlers.tool_result!(event, { cwd: root });
      expect(first.content[0]).toEqual(event.content[0]);
      expect(first.content[1].text).toContain("package rule");
      expect(first.content[1].text).toContain("app rule");
      expect(handlers.tool_result!(event, { cwd: root })).toBeUndefined();
    });

    it("uses structured grep result paths to discover deeper context", () => {
      const { root, file } = fixture();
      const { handlers } = harness();
      const result = handlers.tool_result!(
        {
          toolName: "grep",
          input: { pattern: "export", path: "packages" },
          content: [{ type: "text", text: `${file}:1:export {};` }],
          details: {
            searchPath: path.join(root, "packages"),
            fileGroups: [{ path: "app/src/index.ts" }],
          },
          isError: false,
        },
        { cwd: root },
      );
      expect(result.content.at(-1).text).toContain("app rule");
    });

    it("uses relative find results to discover deeper context", () => {
      const { root } = fixture();
      const { handlers } = harness();
      const result = handlers.tool_result!(
        {
          toolName: "find",
          input: { filePattern: "**/*.ts" },
          content: [{ type: "text", text: "packages/app/src/index.ts" }],
          details: {},
          isError: false,
        },
        { cwd: root },
      );
      expect(result.content.at(-1).text).toContain("app rule");
    });

    it("falls back to built-in grep text paths", () => {
      const { root } = fixture();
      const { handlers } = harness();
      const result = handlers.tool_result!(
        {
          toolName: "grep",
          input: { pattern: "export", path: "packages" },
          content: [{ type: "text", text: "app/src/index.ts:1:export {};" }],
          details: {},
          isError: false,
        },
        { cwd: root },
      );
      expect(result.content.at(-1).text).toContain("app rule");
    });

    it("handles grep searches rooted at one file", () => {
      const { root, file } = fixture();
      const { handlers } = harness();
      const result = handlers.tool_result!(
        {
          toolName: "grep",
          input: { pattern: "export", path: file },
          content: [{ type: "text", text: "index.ts:1:export {};" }],
          details: {
            searchPath: file,
            fileGroups: [{ path: "index.ts" }],
          },
          isError: false,
        },
        { cwd: root },
      );
      expect(result.content.at(-1).text).toContain("app rule");
    });

    it("keeps a mutation blocked until the turn after read context is delivered", () => {
      const { root, file } = fixture();
      const { handlers } = harness();
      handlers.turn_start!();
      expect(
        handlers.tool_result!(
          {
            toolName: "read",
            input: { path: file },
            content: [{ type: "text", text: "file body" }],
            details: {},
            isError: false,
          },
          { cwd: root },
        ),
      ).toBeDefined();
      expect(
        handlers.tool_call!(
          { toolName: "format_file", input: { path: file } },
          { cwd: root },
        ),
      ).toMatchObject({ block: true });
      handlers.turn_start!();
      expect(
        handlers.tool_call!(
          { toolName: "format_file", input: { path: file } },
          { cwd: root },
        ),
      ).toBeUndefined();
    });

    it("blocks a mutation once, then permits its retry on the next turn", () => {
      const { root, file } = fixture();
      const { handlers } = harness();
      const event = {
        toolName: "apply_patch",
        input: {
          input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-export {};\n+export const value = 1;\n*** End Patch\n`,
        },
      };
      handlers.turn_start!();
      const blocked = handlers.tool_call!(event, { cwd: root });
      expect(blocked).toMatchObject({ block: true });
      expect(blocked.reason).toContain("package rule");
      expect(blocked.reason).toContain("app rule");
      expect(
        handlers.tool_call!(
          {
            toolName: "format_file",
            input: { path: path.join(root, "README.md") },
          },
          { cwd: root },
        ),
      ).toMatchObject({
        block: true,
      });
      handlers.turn_start!();
      expect(handlers.tool_call!(event, { cwd: root })).toBeUndefined();
    });

    it("reloads nested instructions after compaction", () => {
      const { root, file } = fixture();
      const { handlers } = harness();
      const event = {
        toolName: "read",
        input: { path: file },
        content: [{ type: "text", text: "file body" }],
        details: {},
        isError: false,
      };
      expect(handlers.tool_result!(event, { cwd: root })).toBeDefined();
      handlers.session_compact!();
      expect(handlers.tool_result!(event, { cwd: root })).toBeDefined();
    });

    it("reloads nested instructions after tree navigation", () => {
      const { root, file } = fixture();
      const { handlers } = harness();
      const event = {
        toolName: "read",
        input: { path: file },
        content: [{ type: "text", text: "file body" }],
        details: {},
        isError: false,
      };
      expect(handlers.tool_result!(event, { cwd: root })).toBeDefined();
      handlers.session_tree!();
      expect(handlers.tool_result!(event, { cwd: root })).toBeDefined();
    });

    it("fails closed for oversized instructions and outside mutations", () => {
      const { root, file } = fixture();
      writeFileSync(
        path.join(root, "packages/app/AGENTS.md"),
        "x".repeat(MAX_FILE_BYTES + 1),
      );
      const { handlers } = harness();
      expect(
        handlers.tool_call!(
          { toolName: "format_file", input: { path: file } },
          { cwd: root },
        ),
      ).toMatchObject({
        block: true,
        reason: expect.stringContaining("exceeds"),
      });
      handlers.turn_start!();
      expect(
        handlers.tool_call!(
          {
            toolName: "write",
            input: { path: path.join(tmpdir(), "outside") },
          },
          { cwd: root },
        ),
      ).toMatchObject({
        block: true,
        reason: expect.stringContaining("outside"),
      });
      handlers.turn_start!();
      expect(
        handlers.tool_call!(
          { toolName: "write", input: { path: "@~/outside.txt" } },
          { cwd: root },
        ),
      ).toMatchObject({
        block: true,
        reason: expect.stringContaining("outside"),
      });
    });

    it("blocks mutation through a dangling symlink", () => {
      const { root } = fixture();
      const outside = mkdtempSync(
        path.join(tmpdir(), "nested-agents-dangling-"),
      );
      roots.push(outside);
      const link = path.join(root, "dangling.ts");
      symlinkSync(path.join(outside, "created.ts"), link);
      const { handlers } = harness();
      expect(
        handlers.tool_call!(
          { toolName: "write", input: { path: link } },
          { cwd: root },
        ),
      ).toMatchObject({
        block: true,
        reason: expect.stringContaining("outside"),
      });
    });
  });
}
