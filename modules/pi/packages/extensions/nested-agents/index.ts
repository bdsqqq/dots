/**
 * Appends newly applicable AGENTS.md context as tools encounter file paths.
 *
 * Pi already loads cwd and ancestor instructions. This fills in other scopes,
 * including paths outside cwd, without authorizing or blocking any tool call.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "@earendil-works/pi-ai";
import { resolveToAbsolute } from "@bds_pi/fs";

const CONTEXT_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_EVENT_BYTES = 128 * 1024;
// Shell output is not a path contract; do not guess targets from command text.
const OBSERVATION_TOOLS = new Set(["read", "look_at", "edit", "write"]);

type TargetPath = {
  path: string;
  assumeFile: boolean;
};

export type NestedContextFile = {
  path: string;
  content: string;
};

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

function resolveTargetDirectory(cwd: string, target: TargetPath): string {
  const requested = path.resolve(resolveToAbsolute(target.path.trim(), cwd));
  const { existing, suffix } = nearestExistingPath(requested);
  const canonicalRequested = path.join(fs.realpathSync(existing), ...suffix);
  if (target.assumeFile || suffix.length > 0)
    return path.dirname(canonicalRequested);
  return fs.statSync(canonicalRequested).isDirectory()
    ? canonicalRequested
    : path.dirname(canonicalRequested);
}

function contextFileInDirectory(
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
    const canonical = fs.realpathSync(candidate);
    if (fs.statSync(canonical).isFile()) return { path: candidate, canonical };
    if (metadata.isSymbolicLink())
      throw new Error(
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
      throw new Error(`nested context path is not a regular file: ${file}`);
    if (metadata.size > MAX_FILE_BYTES)
      throw new Error(
        `nested context file exceeds ${MAX_FILE_BYTES} bytes: ${file}`,
      );
    const buffer = Buffer.alloc(metadata.size);
    const bytesRead = fs.readSync(descriptor, buffer, 0, metadata.size, 0);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let content: string;
    try {
      content = decoder.decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new Error(`nested context file is not valid UTF-8: ${file}`);
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
  // Native startup discovery already supplies these scopes. Stop at the common
  // ancestor, not at cwd: sibling projects have their own instructions too.
  const startupDirectories = new Set<string>();
  for (let current = fs.realpathSync(cwd); ; current = path.dirname(current)) {
    startupDirectories.add(current);
    if (path.dirname(current) === current) break;
  }
  const found = new Map<string, NestedContextFile>();
  for (const target of targets) {
    let current = resolveTargetDirectory(cwd, target);
    while (!startupDirectories.has(current)) {
      const contextFile = contextFileInDirectory(current);
      // A shared target supplies bytes, not scope: attribute linked instructions
      // to the link's directory, even when the bytes live outside cwd.
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
    const leftDepth = left.path.split(path.sep).length;
    const rightDepth = right.path.split(path.sep).length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

function formatContext(files: NestedContextFile[]): string {
  return files
    .map((file) => `[Directory Context: ${file.path}]\n${file.content}`)
    .join("\n\n");
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
  add(event.input.path, event.toolName !== "read");
  if (event.toolName === "look_at" && Array.isArray(event.input.referenceFiles))
    event.input.referenceFiles.forEach((file) => add(file, true));
  return targets;
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
    const disabled = (): boolean => pi.getFlag("no-nested-agents") === true;

    pi.registerFlag("no-nested-agents", {
      description: "Disable on-demand AGENTS.md context injection",
      type: "boolean",
      default: false,
    });

    pi.on("session_start", () => ledger.reset());
    pi.on("session_compact", () => ledger.reset());
    pi.on("session_tree", () => ledger.reset());
    pi.on("session_shutdown", () => ledger.reset());

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
        // Discovery annotates successful results; it must never turn a completed
        // read or mutation into a permission failure.
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: `[Nested context unavailable: ${error instanceof Error ? error.message : String(error)}]`,
            },
          ],
        };
      }
      if (files.length === 0) return;
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
  const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = fs;
  const { homedir, tmpdir } = await import("node:os");
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

  function fixture() {
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

  function harness(disabled = false) {
    const handlers: Record<string, (...args: any[]) => any> = {};
    createNestedAgentsExtension()({
      getFlag: () => disabled,
      registerFlag: () => {},
      on: (event: string, handler: (...args: any[]) => any) => {
        handlers[event] = handler;
      },
    } as any);
    return handlers;
  }

  function result(path: string, toolName = "read") {
    return {
      toolName,
      input: { path },
      content: [{ type: "text", text: "original tool result" }],
      details: {},
      isError: false,
    };
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
      tools: ["read", "edit", "write", "nested_edit", "codemode", "bash"],
    });
    await session.bindExtensions({ mode: "json" });
    async function call(tool: string, input: JsonObject, via = "direct") {
      const name = via === "direct" ? tool : "codemode";
      const args: JsonObject =
        via === "direct"
          ? input
          : { code: `text(await tools.${tool}(${JSON.stringify(input)}));` };
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(name, args), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      await session.prompt("execute the fixture call");
      const result = session.messages
        .filter((m) => m.role === "toolResult")
        .at(-1)!;
      return {
        isError: result.isError,
        text: result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      };
    }
    return { session, faux, call };
  }

  describe("on-demand instruction discovery", () => {
    it("discovers descendant instructions outermost first, excluding startup scopes", () => {
      const { root, file } = fixture();
      expect(
        discoverNestedContext(root, [{ path: file, assumeFile: true }]).map(
          (item) => path.relative(root, item.path),
        ),
      ).toEqual(["packages/AGENTS.md", "packages/app/AGENTS.md"]);
      expect(
        discoverNestedContext(path.dirname(file), [
          { path: path.join(root, "AGENTS.md"), assumeFile: true },
        ]),
      ).toEqual([]);
    });

    it("loads sibling scopes, including ancestors of newly created paths", () => {
      const { root } = fixture();
      const outside = fixture();
      const found = discoverNestedContext(root, [
        { path: path.join(outside.root, "new/deep/file.ts"), assumeFile: true },
        { path: outside.file, assumeFile: true },
      ]);
      expect(found.map((item) => item.content.trim())).toEqual([
        "root rule",
        "package rule",
        "app rule",
      ]);
    });

    it.each(["directory", "file"])(
      "follows a %s symlink outside cwd to the target's instruction scopes",
      (kind) => {
        const { root } = fixture();
        const outside = fixture();
        const link = path.join(root, "external");
        symlinkSync(kind === "file" ? outside.file : outside.root, link);
        const target =
          kind === "file" ? link : path.join(link, "packages/app/src/index.ts");
        expect(
          discoverNestedContext(root, [{ path: target, assumeFile: true }]).map(
            (item) => item.content.trim(),
          ),
        ).toEqual(["root rule", "package rule", "app rule"]);
      },
    );

    it("handles relative, home-prefixed and @-prefixed targets", () => {
      const { root, file } = fixture();
      for (const target of [
        path.relative(root, file),
        `@${file}`,
        `~/${path.relative(homedir(), file)}`,
      ])
        expect(
          discoverNestedContext(root, [{ path: target, assumeFile: true }]),
        ).toHaveLength(2);
    });

    it("uses native filename precedence and strips UTF-8 BOMs", () => {
      const { root, file } = fixture();
      writeFileSync(
        path.join(root, "packages/AGENTS.override.md"),
        "\ufeffoverride\n",
      );
      writeFileSync(path.join(root, "packages/CLAUDE.md"), "not selected\n");
      expect(
        discoverNestedContext(root, [{ path: file, assumeFile: true }]).map(
          (item) => item.content.trim(),
        ),
      ).toEqual(["override", "app rule"]);
    });

    it.each(["relative", "absolute", "chain", "outside"])(
      "attributes %s linked instructions to their applicable directory",
      (kind) => {
        const { root, file, nestedContext } = fixture();
        const targetRoot = kind === "outside" ? fixture().root : root;
        const target = path.join(targetRoot, "rules.md");
        writeFileSync(target, "linked rule\n");
        rmSync(nestedContext);
        if (kind === "chain") {
          symlinkSync("rules.md", path.join(root, "link.md"));
          symlinkSync("../link.md", nestedContext);
        } else {
          symlinkSync(
            kind === "relative"
              ? path.relative(path.dirname(nestedContext), target)
              : target,
            nestedContext,
          );
        }
        expect(
          discoverNestedContext(root, [{ path: file, assumeFile: true }]),
        ).toEqual([
          { path: nestedContext, content: "linked rule\n" },
          {
            path: path.join(root, "packages/app/AGENTS.md"),
            content: "app rule\n",
          },
        ]);
      },
    );

    it.each(["read", "look_at", "edit", "write"])(
      "appends instructions once after successful %s without registering a permission gate",
      (tool) => {
        const { root, file } = fixture();
        const handlers = harness();
        const event = result(file, tool);
        const first = handlers.tool_result!(event, { cwd: root });
        expect(first.content[0]).toEqual(event.content[0]);
        expect(first.content[1].text).toContain("package rule");
        expect(first.content[1].text).toContain("app rule");
        expect(handlers.tool_result!(event, { cwd: root })).toBeUndefined();
        expect(handlers.tool_call).toBeUndefined();
      },
    );

    it("loads directory scope and look_at reference scopes, without duplicate ancestors", () => {
      const { root, file } = fixture();
      const handlers = harness();
      const directory = handlers.tool_result!(
        result(path.join(root, "packages/app")),
        { cwd: root },
      );
      expect(directory.content[1].text).toContain("app rule");
      const outside = fixture();
      const observed = handlers.tool_result!(
        {
          ...result(file, "look_at"),
          input: {
            path: file,
            referenceFiles: [outside.file, outside.file, 7],
          },
        },
        { cwd: root },
      );
      expect(observed.content[1].text.match(/app rule/g)).toHaveLength(1);
      expect(observed.content[1].text).toContain(outside.nestedContext);
    });

    it.each([
      "session_start",
      "session_compact",
      "session_tree",
      "session_shutdown",
    ])("rediscovers instructions after %s", (event) => {
      const { root, file } = fixture();
      const handlers = harness();
      expect(handlers.tool_result!(result(file), { cwd: root })).toBeDefined();
      expect(
        handlers.tool_result!(result(file), { cwd: root }),
      ).toBeUndefined();
      handlers[event]!();
      expect(handlers.tool_result!(result(file), { cwd: root })).toBeDefined();
    });

    it.each(["dangling", "cycle", "directory", "oversized", "invalid UTF-8"])(
      "warns about %s instructions without blocking tools or changing their successful status",
      (kind) => {
        const { root, file, nestedContext } = fixture();
        rmSync(nestedContext);
        if (kind === "dangling") symlinkSync("missing.md", nestedContext);
        else if (kind === "cycle") symlinkSync("AGENTS.md", nestedContext);
        else if (kind === "directory") symlinkSync(root, nestedContext);
        else
          writeFileSync(
            nestedContext,
            kind === "oversized"
              ? "x".repeat(MAX_FILE_BYTES + 1)
              : Buffer.from([0xff]),
          );
        const handlers = harness();
        const event = result(file, "edit");
        const warning = handlers.tool_result!(event, { cwd: root });
        expect(warning.content[0]).toEqual(event.content[0]);
        expect(warning.content[1].text).toContain(
          "Nested context unavailable:",
        );
        expect(warning.block).toBeUndefined();
        expect(warning.isError).toBeUndefined();
        expect(handlers.tool_call).toBeUndefined();
      },
    );

    it("defers context beyond the event byte budget without marking it delivered", () => {
      const { root } = fixture();
      let directory = root;
      for (let i = 0; i < 5; i++) {
        directory = path.join(directory, `level-${i}`);
        mkdirSync(directory);
        writeFileSync(
          path.join(directory, "AGENTS.md"),
          "x".repeat(MAX_FILE_BYTES),
        );
      }
      const handlers = harness();
      const event = result(directory);
      const first = handlers.tool_result!(event, { cwd: root });
      const second = handlers.tool_result!(event, { cwd: root });
      expect(Buffer.byteLength(first.content[1].text)).toBeLessThanOrEqual(
        MAX_EVENT_BYTES,
      );
      expect(first.content[1].text.match(/Directory Context:/g)).toHaveLength(
        3,
      );
      expect(second.content[1].text.match(/Directory Context:/g)).toHaveLength(
        2,
      );
      expect(handlers.tool_result!(event, { cwd: root })).toBeUndefined();
    });

    it("ignores failed results, unsupported tools, empty targets and the disable flag", () => {
      const { root, file } = fixture();
      const handlers = harness();
      for (const event of [
        { ...result(file), isError: true },
        result(file, "bash"),
        { ...result(file), input: { path: " " } },
      ])
        expect(handlers.tool_result!(event, { cwd: root })).toBeUndefined();
      expect(
        harness(true).tool_result!(result(file), { cwd: root }),
      ).toBeUndefined();
      expect(handlers.tool_result!(result(file), { cwd: root })).toBeDefined();
    });
  });

  describe("native dispatch remains unrestricted", () => {
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

    it("runs real shell search/listing without gating a subsequent native edit", async () => {
      const { root, file } = fixture();
      const spaced = path.join(root, "packages/app/src/file with spaces.ts");
      writeFileSync(spaced, "unique search needle\n");
      const { session, call } = await sdkFixture(root);
      try {
        const search = await call("bash", {
          command: 'rg -n --glob "*.ts" "unique search needle" "packages"',
        });
        expect(search.isError, search.text).toBe(false);
        expect(search.text).toContain(
          "packages/app/src/file with spaces.ts:1:unique search needle",
        );
        const listing = await call("bash", {
          command: 'rg --files "packages" && ls -1 "packages/app/src"',
        });
        expect(listing.isError, listing.text).toBe(false);
        expect(listing.text).toContain("packages/app/src/index.ts");
        expect(listing.text).toContain("file with spaces.ts");
        const edited = await call("edit", {
          path: file,
          edits: [{ oldText: "export {};", newText: "export const x = 1;" }],
        });
        expect(edited.isError).toBe(false);
        expect(edited.text).toContain("app rule");
        expect(fs.readFileSync(file, "utf8")).toBe("export const x = 1;\n");
      } finally {
        session.dispose();
      }
    });

    it.each(["direct", "nested", "codemode"])(
      "%s edits and writes outside cwd on the first call, then returns instructions",
      async (via) => {
        for (const tool of ["edit", "write"]) {
          const { root } = fixture();
          const outside = fixture();
          const { session, faux } = await sdkFixture(root);
          const target =
            tool === "edit"
              ? outside.file
              : path.join(outside.root, "packages/app/new/deep/file.txt");
          const input: JsonObject =
            tool === "edit"
              ? {
                  path: target,
                  edits: [
                    { oldText: "export {};", newText: "export const x = 1;" },
                  ],
                }
              : { path: target, content: "created\n" };
          const name =
            via === "direct"
              ? tool
              : via === "nested"
                ? "nested_edit"
                : "codemode";
          const args: JsonObject =
            via === "direct"
              ? input
              : via === "nested"
                ? { tool, input }
                : {
                    code: `text(await tools.${tool}(${JSON.stringify(input)}));`,
                  };
          faux.setResponses([
            fauxAssistantMessage(fauxToolCall(name, args), {
              stopReason: "toolUse",
            }),
            fauxAssistantMessage("done"),
          ]);
          try {
            await session.prompt("execute the fixture call");
            const results = session.messages.filter(
              (m) => m.role === "toolResult",
            );
            expect(results).toHaveLength(1);
            expect(results[0]!.isError).toBeFalsy();
            const delivered = results[0]!.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n");
            expect(delivered).toContain("package rule");
            expect(delivered).toContain("app rule");
            expect(fs.readFileSync(target, "utf8")).toBe(
              tool === "edit" ? "export const x = 1;\n" : "created\n",
            );
          } finally {
            session.dispose();
          }
        }
      },
    );

    it.each(["direct", "codemode"])(
      "%s keeps sibling writes runnable when a read discovers instructions",
      async (via) => {
        const { root, file } = fixture();
        const target = path.join(root, "sibling.txt");
        const { session, faux } = await sdkFixture(root);
        const read = { path: file };
        const write = { path: target, content: "no permission gate\n" };
        const calls =
          via === "direct"
            ? [fauxToolCall("read", read), fauxToolCall("write", write)]
            : [
                fauxToolCall("codemode", {
                  code: `text(await tools.read(${JSON.stringify(read)})); text(await tools.write(${JSON.stringify(write)}));`,
                }),
              ];
        faux.setResponses([
          fauxAssistantMessage(calls, { stopReason: "toolUse" }),
          fauxAssistantMessage("done"),
        ]);
        try {
          await session.prompt("execute both fixture calls");
          expect(fs.readFileSync(target, "utf8")).toBe("no permission gate\n");
          const results = session.messages.filter(
            (m) => m.role === "toolResult",
          );
          expect(results.every((m) => !m.isError)).toBe(true);
          expect(
            results
              .flatMap((m) => m.content)
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n"),
          ).toContain("app rule");
        } finally {
          session.dispose();
        }
      },
    );

    it("keeps a native edit successful when context discovery fails", async () => {
      const { root, file, nestedContext } = fixture();
      writeFileSync(nestedContext, "x".repeat(MAX_FILE_BYTES + 1));
      const { session, faux } = await sdkFixture(root);
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("edit", {
            path: file,
            edits: [{ oldText: "export {};", newText: "changed" }],
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      try {
        await session.prompt("execute the fixture edit");
        expect(fs.readFileSync(file, "utf8")).toBe("changed\n");
        const last = session.messages
          .filter((m) => m.role === "toolResult")
          .at(-1)!;
        expect(last.isError).toBeFalsy();
        expect(
          last.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n"),
        ).toContain("Nested context unavailable:");
      } finally {
        session.dispose();
      }
    });
  });
}
