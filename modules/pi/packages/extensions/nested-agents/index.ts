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
import type { JsonObject } from "@earendil-works/pi-ai";
import { resolveToAbsolute } from "@bds_pi/fs";

const CONTEXT_NAMES = [
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_EVENT_BYTES = 128 * 1024;
const MUTATION_TOOLS = new Set(["edit", "write"]);
// Shell discovery is intentionally not parsed: known native edits still gate
// before mutation, while read/look_at deliver instructions on observation.
const OBSERVATION_TOOLS = new Set(["read", "look_at"]);

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
): { path: string; canonical: string } | undefined {
  for (const name of CONTEXT_NAMES) {
    const candidate = path.join(directory, name);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync(candidate);
    } catch {
      throw new NestedContextPolicyError(
        `cannot resolve nested context file: ${candidate}`,
      );
    }
    if (!isWithin(root, canonical))
      throw new NestedContextPolicyError(
        `nested context file escapes the workspace: ${candidate}`,
      );
    if (fs.statSync(canonical).isFile()) return { path: candidate, canonical };
    if (metadata.isSymbolicLink())
      throw new NestedContextPolicyError(
        `nested context path is not a regular file: ${candidate}`,
      );
  }
  return undefined;
}

function readBoundedContext(
  file: string,
  contextPath: string,
): NestedContextFile {
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
    return { path: contextPath, content };
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
      // A shared target supplies bytes, not scope: its link's directory owns
      // precedence and attribution. Open the resolved file with O_NOFOLLOW.
      if (contextFile && !found.has(contextFile.path))
        found.set(
          contextFile.path,
          readBoundedContext(contextFile.canonical, contextFile.path),
        );
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function observationTargets(event: {
  toolName: string;
  input: Record<string, unknown>;
}): TargetPath[] {
  const targets: TargetPath[] = [];
  const add = (value: unknown, assumeFile: boolean): void => {
    if (typeof value === "string" && value.trim())
      targets.push({ path: value, assumeFile });
  };
  if (event.toolName === "read") add(event.input.path, false);
  if (event.toolName === "look_at") {
    add(event.input.path, true);
    stringArray(event.input.referenceFiles).forEach((file) => add(file, true));
  }
  return targets;
}

function mutationTargets(event: {
  input: Record<string, unknown>;
}): TargetPath[] {
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
  const {
    createAgentSession,
    createCodemodeExtension,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const {
    fauxProvider,
    fauxAssistantMessage,
    fauxToolCall,
    InMemoryCredentialStore,
  } = await import("@earendil-works/pi-ai");
  const { Type } = await import("typebox");

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

  async function sdkFixture(root: string) {
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        createNestedAgentsExtension(),
        createCodemodeExtension({ models: false }),
        (pi) => {
          pi.registerTool({
            name: "nested_edit",
            label: "nested edit fixture",
            description: "exercise shared native dispatch",
            parameters: Type.Object({
              tool: Type.String(),
              input: Type.Unknown(),
            }),
            async execute(_id, args, _signal, _update, ctx) {
              const outcome = await ctx.executeTool(args.tool, args.input);
              if (outcome.isError)
                throw new Error(
                  outcome.result.content
                    .filter((item) => item.type === "text")
                    .map((item) => item.text)
                    .join("\n"),
                );
              return outcome.result;
            },
          });
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      model: faux.getModel(),
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      tools: ["edit", "write", "nested_edit", "codemode", "bash"],
    });
    await session.bindExtensions({ mode: "json" });
    async function call(tool: string, input: JsonObject, via = "direct") {
      const name =
        via === "direct" ? tool : via === "nested" ? "nested_edit" : "codemode";
      const args =
        via === "direct"
          ? input
          : via === "nested"
            ? { tool, input }
            : { code: `text(await tools.${tool}(${JSON.stringify(input)}));` };
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(name, args), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      await session.prompt("execute the fixture call");
      const result = [...session.messages]
        .reverse()
        .find((m) => m.role === "toolResult");
      if (!result || result.role !== "toolResult")
        throw new Error("fixture did not produce a tool result");
      return {
        isError: result.isError,
        text: result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      };
    }
    return { session, call, faux };
  }

  describe("native editing through shared SDK dispatch", () => {
    it.each(["direct", "codemode"])(
      "%s keeps sibling mutations blocked in the instruction-delivery turn",
      async (via) => {
        const { root, file } = fixture();
        const sibling = path.join(root, "sibling.txt");
        const { session, faux } = await sdkFixture(root);
        const edit = {
          path: file,
          edits: [{ oldText: "export {};", newText: "export const x = 1;" }],
        };
        const write = { path: sibling, content: "must wait\n" };
        const calls =
          via === "direct"
            ? [fauxToolCall("edit", edit), fauxToolCall("write", write)]
            : [
                fauxToolCall("codemode", {
                  code: `const results = await Promise.allSettled([
                tools.edit(${JSON.stringify(edit)}),
                tools.write(${JSON.stringify(write)})
              ]);
              text(results.map(result => result.status === "rejected"
                ? result.reason.message : result.value));`,
                }),
              ];
        faux.setResponses([
          fauxAssistantMessage(calls, { stopReason: "toolUse" }),
          fauxAssistantMessage("done"),
        ]);
        try {
          await session.prompt("execute both fixture mutations");
          const delivered = session.messages
            .filter((m) => m.role === "toolResult")
            .flatMap((m) => m.content)
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n");
          expect(delivered).toContain("package rule");
          expect(delivered).toContain("another mutation");
          expect(fs.readFileSync(file, "utf8")).toBe("export {};\n");
          expect(fs.existsSync(sibling)).toBe(false);
        } finally {
          session.dispose();
        }
      },
    );

    it.each(["direct", "nested", "codemode"])(
      "%s pauses native edit/write before instructions and preserves unrelated user content on retry",
      async (via) => {
        // Separate sessions prove that neither native tool relies on the other
        // having discovered instructions first.
        for (const tool of ["edit", "write"]) {
          const { root, file } = fixture();
          const created = path.join(root, "packages/app/new/deep/file.txt");
          const original = "header\nexport {};\nuser footer\n";
          writeFileSync(file, original);
          const { session, call } = await sdkFixture(root);
          const args: JsonObject =
            tool === "edit"
              ? {
                  path: file,
                  edits: [
                    {
                      oldText: "export {};",
                      newText: "export const value = 1;",
                    },
                  ],
                }
              : { path: created, content: "new file\n" };
          try {
            const first = await call(tool, args, via);
            expect(first.isError).toBe(true);
            expect(first.text).toContain("Mutation paused");
            expect(first.text).toContain("package rule");
            expect(first.text).toContain("app rule");
            expect(fs.readFileSync(file, "utf8")).toBe(original);
            expect(fs.existsSync(created)).toBe(false);

            // Simulate another writer between instruction delivery and retry.
            fs.appendFileSync(file, "unpublished user addition\n");
            const second = await call(tool, args, via);
            expect(second.isError).toBe(false);
            expect(fs.readFileSync(file, "utf8")).toBe(
              (tool === "edit"
                ? original.replace("export {};", "export const value = 1;")
                : original) + "unpublished user addition\n",
            );
            if (tool === "write")
              expect(fs.readFileSync(created, "utf8")).toBe("new file\n");
          } finally {
            session.dispose();
          }
        }
      },
    );

    it.each(["direct", "codemode"])(
      "%s rejects malformed, nonmatching, ambiguous and overlapping native edits without partial writes",
      async (via) => {
        const { root } = fixture();
        const file = path.join(root, "native.txt");
        const original =
          "unique first\nrepeated\nmiddle\nrepeated\nunique last\n";
        writeFileSync(file, original);
        const { session, call } = await sdkFixture(root);
        try {
          for (const edits of [
            [],
            [{ newText: "missing oldText" }],
            [{ oldText: "absent token", newText: "wrong" }],
            [{ oldText: "repeated", newText: "ambiguous" }],
            [
              { oldText: "unique first\nrepeated", newText: "outer" },
              { oldText: "unique first", newText: "inner" },
            ],
            [
              { oldText: "unique first", newText: "must not partially write" },
              { oldText: "absent token", newText: "wrong" },
            ],
          ]) {
            const result = await call("edit", { path: file, edits }, via);
            expect(result.isError).toBe(true);
            expect(result.text).not.toContain("Mutation paused");
            expect(fs.readFileSync(file, "utf8")).toBe(original);
          }
          expect(
            (
              await call(
                "edit",
                {
                  path: file,
                  edits: [
                    { oldText: "unique first", newText: "changed first" },
                    { oldText: "unique last", newText: "changed last" },
                  ],
                },
                via,
              )
            ).isError,
          ).toBe(false);
          expect(fs.readFileSync(file, "utf8")).toBe(
            "changed first\nrepeated\nmiddle\nrepeated\nchanged last\n",
          );
        } finally {
          session.dispose();
        }
      },
    );

    it("runs real shell search/listing and still gates a subsequent native edit", async () => {
      const { root, file } = fixture();
      const spaced = path.join(root, "packages/app/src/file with spaces.ts");
      writeFileSync(spaced, "unique search needle\n");
      const { session, call } = await sdkFixture(root);
      try {
        const search = await call("bash", {
          command: 'rg -n --glob "*.ts" "unique search needle" "packages"',
        });
        expect(search.isError).toBe(false);
        expect(search.text).toContain(
          "packages/app/src/file with spaces.ts:1:unique search needle",
        );
        const listing = await call("bash", {
          command: 'rg --files "packages" && ls -1 "packages/app/src"',
        });
        expect(listing.isError).toBe(false);
        expect(listing.text).toContain("packages/app/src/index.ts");
        expect(listing.text).toContain("file with spaces.ts");
        const result = await call("edit", {
          path: file,
          edits: [{ oldText: "export {};", newText: "export const x = 1;" }],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("app rule");
        expect(fs.readFileSync(file, "utf8")).toBe("export {};\n");
      } finally {
        session.dispose();
      }
    });
  });

  describe("nested AGENTS.md context", () => {
    it("discovers descendant instructions outermost first and excludes cwd", () => {
      const { root, file } = fixture();
      expect(
        discoverNestedContext(root, [{ path: file, assumeFile: true }]).map(
          (item) => path.relative(root, item.path),
        ),
      ).toEqual(["packages/AGENTS.md", "packages/app/AGENTS.md"]);
    });

    it.each(["relative", "absolute", "chain"])(
      "loads %s workspace-local context links at their applicable directory",
      (kind) => {
        const { root, file, nestedContext } = fixture();
        const target = path.join(root, "config/deeper/rules.md");
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, "linked outer rule\n");
        rmSync(nestedContext);
        if (kind === "chain") {
          symlinkSync("deeper/rules.md", path.join(root, "config/link.md"));
          symlinkSync("../config/link.md", nestedContext);
        } else {
          symlinkSync(
            kind === "absolute"
              ? target
              : path.relative(path.dirname(nestedContext), target),
            nestedContext,
          );
        }
        expect(
          discoverNestedContext(root, [{ path: file, assumeFile: true }]),
        ).toEqual([
          { path: nestedContext, content: "linked outer rule\n" },
          {
            path: path.join(root, "packages/app/AGENTS.md"),
            content: "app rule\n",
          },
        ]);
      },
    );

    it("fails closed for dangling context links", () => {
      const { root, file } = fixture();
      const context = path.join(root, "packages/app/AGENTS.md");
      rmSync(context);
      symlinkSync(path.join(root, "missing-agents.md"), context);
      expect(() =>
        discoverNestedContext(root, [{ path: file, assumeFile: true }]).map(
          (item) => item.content.trim(),
        ),
      ).toThrow("cannot resolve nested context file");
    });

    it.each(["outside", "cycle", "directory", "oversized", "invalid UTF-8"])(
      "fails closed for %s context links",
      (kind) => {
        const { root, file } = fixture();
        const context = path.join(root, "packages/app/AGENTS.md");
        const target = path.join(root, "rules.md");
        rmSync(context);
        let expected: string;
        if (kind === "outside") {
          const outside = mkdtempSync(
            path.join(tmpdir(), "nested-context-outside-"),
          );
          roots.push(outside);
          writeFileSync(path.join(outside, "rules.md"), "outside rule\n");
          symlinkSync(path.join(outside, "rules.md"), context);
          expected = "escapes the workspace";
        } else if (kind === "cycle") {
          symlinkSync("AGENTS.md", context);
          expected = "cannot resolve nested context file";
        } else if (kind === "directory") {
          symlinkSync(root, context);
          expected = "not a regular file";
        } else {
          writeFileSync(
            target,
            kind === "oversized"
              ? "x".repeat(MAX_FILE_BYTES + 1)
              : Buffer.from([0xff]),
          );
          symlinkSync(target, context);
          expected = kind === "oversized" ? "exceeds" : "not valid UTF-8";
        }
        expect(() =>
          discoverNestedContext(root, [{ path: file, assumeFile: true }]),
        ).toThrow(expected);
        const { handlers } = harness();
        expect(
          handlers.tool_call!(
            { toolName: "edit", input: { path: file } },
            { cwd: root },
          ),
        ).toMatchObject({
          block: true,
          reason: expect.stringContaining(expected),
        });
      },
    );

    it("delivers linked instructions before allowing a mutation on the next turn", () => {
      const { root, file, nestedContext } = fixture();
      const target = path.join(root, "rules.md");
      writeFileSync(target, "linked rule\n");
      rmSync(nestedContext);
      symlinkSync("../rules.md", nestedContext);
      const { handlers } = harness();
      const event = { toolName: "edit", input: { path: file } };
      expect(handlers.tool_call!(event, { cwd: root })).toMatchObject({
        block: true,
        reason: expect.stringContaining("linked rule"),
      });
      expect(handlers.tool_call!(event, { cwd: root })).toMatchObject({
        block: true,
      });
      handlers.turn_start!();
      expect(handlers.tool_call!(event, { cwd: root })).toBeUndefined();
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
          { toolName: "edit", input: { path: file } },
          { cwd: root },
        ),
      ).toMatchObject({ block: true });
      handlers.turn_start!();
      expect(
        handlers.tool_call!(
          { toolName: "edit", input: { path: file } },
          { cwd: root },
        ),
      ).toBeUndefined();
    });

    it("blocks a mutation once, then permits its retry on the next turn", () => {
      const { root, file } = fixture();
      const { handlers } = harness();
      const event = {
        toolName: "edit",
        input: {
          path: file,
          edits: [
            { oldText: "export {};", newText: "export const value = 1;" },
          ],
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
            toolName: "write",
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
          { toolName: "edit", input: { path: file } },
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
