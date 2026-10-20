import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ReadToolDetails,
  type ReadToolInput,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { Text } from "@earendil-works/pi-tui";
import { renderLifecycleCall, osc8Link } from "@bds_pi/box-format";
import {
  Type,
  type Static,
  type TInteger,
  type TObject,
  type TOptional,
  type TString,
  type TTuple,
} from "typebox";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { isSecretFile, listDirectory, resolveWithVariants } from "@bds_pi/fs";
import * as toolPolicy from "@bds_pi/tool-policy";

export {
  expandPath,
  resolveToAbsolute,
  resolveWithVariants,
  isSecretFile,
  listDirectory,
} from "@bds_pi/fs";

export type ReadOptions = {
  maxDirEntries: number;
};

export const DEFAULT_READ_OPTIONS: ReadOptions = { maxDirEntries: 1000 };

type ReadConfig = ReadOptions & Record<string, unknown>;

type ReadExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const DEFAULT_DEPS: ReadExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isReadConfig(value: Record<string, unknown>): value is ReadConfig {
  return isPositiveInteger(value.maxDirEntries);
}

const READ_CONFIG_SCHEMA: ExtensionConfigSchema<ReadConfig> = {
  validate: isReadConfig,
};

const CONFIG_DEFAULTS: ReadConfig = {
  maxDirEntries: DEFAULT_READ_OPTIONS.maxDirEntries,
};

const nativeRead = createReadToolDefinition(process.cwd());
const readDescription =
  `Read text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. ` +
  `Text is returned without line numbers, bounded to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). ` +
  "Use read_range [start, end] for a 1-indexed inclusive line range. Continue with later ranges to read further.";
// isolated declarations need a portable type rather than the SDK's nested typebox path.
const readParameters: TObject<{
  path: TString;
  read_range: TOptional<TTuple<[TInteger, TInteger]>>;
}> = Type.Object({
  path: nativeRead.parameters.properties.path,
  read_range: Type.Optional(
    Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })], {
      description: "inclusive 1-indexed start and end lines.",
    }),
  ),
});

export type ReadParams = Static<typeof readParameters>;

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: undefined,
    structuredContent: message,
    isError: true,
  };
}

export function createReadTool(
  options: ReadOptions = DEFAULT_READ_OPTIONS,
): ToolDefinition<typeof readParameters, ReadToolDetails | undefined> {
  const tool: ToolDefinition<
    typeof readParameters,
    ReadToolDetails | undefined
  > = {
    ...nativeRead,
    description:
      `${readDescription}\n\n` +
      "if path is a directory, its entries are listed. when a native continuation notice gives an offset, use it as read_range's start. " +
      "paths accept absolute or workspace-relative spelling, ~ for the home directory, and @ as an absolute-path prefix. " +
      "secret files and paths rejected by tool policy cannot be read.",
    parameters: readParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (params.read_range && params.read_range[1] < params.read_range[0]) {
        return errorResult(
          "read_range end must be greater than or equal to start.",
        );
      }

      const candidate = resolveWithVariants(params.path, ctx.cwd);
      let target = candidate;
      try {
        target = fs.realpathSync(candidate);
      } catch {
        // Keep the expanded candidate so missing paths retain the SDK error.
      }

      const policy = toolPolicy.loadToolPolicy();
      // neither an alias nor its canonical target may bypass a path restriction.
      for (const policyPath of new Set([candidate, target])) {
        const verdict = toolPolicy.evaluateToolPolicy(
          "read",
          { path: policyPath, sessionCwd: ctx.cwd },
          policy,
        );
        if (verdict.action === "reject") {
          return errorResult(
            verdict.message
              ? `path rejected: ${verdict.message}`
              : "path rejected by tool policy.",
          );
        }
      }

      if (isSecretFile(target) || isSecretFile(candidate)) {
        return errorResult(
          `refused to read ${path.basename(target)}: file may contain secrets. ask the user to share relevant values.`,
        );
      }

      try {
        if (fs.statSync(target).isDirectory()) {
          if (signal?.aborted) throw new Error("Operation aborted");
          const text = listDirectory(target, options.maxDirEntries);
          return {
            content: [{ type: "text" as const, text }],
            details: undefined,
            structuredContent: text,
          };
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("cannot list directory:")
        ) {
          return errorResult(error.message);
        }
        // Missing and unreadable paths are reported by the native read operation.
      }

      const [start, end] = params.read_range ?? [];
      const nativeParams: ReadToolInput = {
        path: target,
        ...(start === undefined ? {} : { offset: start }),
        ...(start === undefined || end === undefined
          ? {}
          : { limit: end - start + 1 }),
      };
      return nativeRead.execute(
        toolCallId,
        nativeParams,
        signal,
        onUpdate,
        ctx,
      );
    },
    renderCall(args, theme, context) {
      const filePath = args.path || "...";
      const home = os.homedir();
      const shortened = filePath.startsWith(home)
        ? `~${filePath.slice(home.length)}`
        : filePath;
      const [start, end] = args.read_range ?? [];
      const displayPath =
        start === undefined || end === undefined
          ? shortened
          : `${shortened}:${start}-${end}`;
      const linked = filePath.startsWith("/")
        ? osc8Link(`file://${filePath}`, displayPath)
        : displayPath;
      return renderLifecycleCall(
        new Text(
          theme.fg("toolTitle", theme.bold("Read ")) + theme.fg("dim", linked),
          0,
          0,
        ),
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      const [offset, end] = context.args.read_range ?? [];
      const args: ReadToolInput = {
        path: context.args.path,
        ...(offset === undefined ? {} : { offset }),
        ...(offset === undefined || end === undefined
          ? {}
          : { limit: end - offset + 1 }),
      };
      return (
        nativeRead.renderResult?.(result, options, theme, {
          ...context,
          args,
        }) ?? new Text("", 0, 0)
      );
    },
  };

  return tool;
}

/**
 * Keep config gating at startup registration: sibling extensions import this
 * module while loading, even when read itself is disabled.
 */
function createReadExtension(
  deps: ReadExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function readExtension(pi: ExtensionAPI): void {
    const { enabled, config } = deps.getEnabledExtensionConfig(
      "@bds_pi/read",
      CONFIG_DEFAULTS,
      { schema: READ_CONFIG_SCHEMA },
    );
    if (!enabled) return;
    pi.registerTool(deps.withPromptPatch(createReadTool(config)));
  };
}

const readExtension: (pi: ExtensionAPI) => void = createReadExtension();

export default readExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const tmpdir = os.tmpdir();
  const directories: string[] = [];

  function makeDirectory(): string {
    const directory = fs.mkdtempSync(path.join(tmpdir, "pi-read-sdk-"));
    directories.push(directory);
    return directory;
  }

  function callContext(cwd: string) {
    return { cwd } as Parameters<
      NonNullable<ReturnType<typeof createReadTool>["execute"]>
    >[4];
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(
      path.join(tmpdir, `missing-read-settings-${Date.now()}.json`),
    );
  });

  describe("read SDK adapter", () => {
    it("reads Unicode text and inclusive ranges through the SDK", async () => {
      const cwd = makeDirectory();
      const file = path.join(cwd, "unicode.txt");
      fs.writeFileSync(file, "olá\n世界\nthird\nfourth");
      const tool = createReadTool();

      const ordinary = await tool.execute(
        "ordinary",
        { path: file },
        undefined,
        undefined,
        callContext(cwd),
      );
      const ranged = await tool.execute(
        "range",
        { path: file, read_range: [2, 3] },
        undefined,
        undefined,
        callContext(cwd),
      );

      expect(ordinary.content).toContainEqual({
        type: "text",
        text: "olá\n世界\nthird\nfourth",
      });
      expect(ranged.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/^世界\nthird\n\n\[1 more lines/),
      });
    });

    it("rejects reversed ranges without reading file content", async () => {
      const cwd = makeDirectory();
      const result = await withPromptPatch(createReadTool()).execute(
        "range",
        { path: path.join(cwd, "absent.txt"), read_range: [5, 2] },
        undefined,
        undefined,
        callContext(cwd),
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBe(
        "read_range end must be greater than or equal to start.",
      );
    });

    it("uses native bounds for large and long text", async () => {
      const cwd = makeDirectory();
      const file = path.join(cwd, "large.txt");
      fs.writeFileSync(
        file,
        `${"x".repeat(20_000)}\n${Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n")}`,
      );
      const result = await createReadTool().execute(
        "large",
        { path: file },
        undefined,
        undefined,
        callContext(cwd),
      );
      const text = result.content.find((part) => part.type === "text");

      expect(text?.type).toBe("text");
      if (text?.type === "text")
        expect(text.text).toMatch(/exceeds|Showing lines|limit/);
      expect(result.details?.truncation?.truncated).toBe(true);
    });

    it("keeps native empty and missing-file behavior", async () => {
      const cwd = makeDirectory();
      const empty = path.join(cwd, "empty.txt");
      fs.writeFileSync(empty, "");

      const result = await createReadTool().execute(
        "empty",
        { path: empty },
        undefined,
        undefined,
        callContext(cwd),
      );
      expect(result.content).toContainEqual({ type: "text", text: "" });
      await expect(
        createReadTool().execute(
          "missing",
          { path: path.join(cwd, "missing.txt") },
          undefined,
          undefined,
          callContext(cwd),
        ),
      ).rejects.toThrow();
    });

    it("lists directories with the configured directory cap", async () => {
      const cwd = makeDirectory();
      const directory = path.join(cwd, "entries");
      fs.mkdirSync(directory);
      for (const name of ["a", "b", "c", "d", "e"])
        fs.writeFileSync(path.join(directory, name), "");

      const result = await createReadTool({ maxDirEntries: 4 }).execute(
        "directory",
        { path: directory },
        undefined,
        undefined,
        callContext(cwd),
      );
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("more entries"),
      });
      expect(result.structuredContent).toEqual(
        result.content[0]?.type === "text" ? result.content[0].text : undefined,
      );
    });

    it("sniffs image bytes and forwards native image content and details", async () => {
      const cwd = makeDirectory();
      const image = path.join(cwd, "misleading.txt");
      const bmp = Buffer.alloc(58);
      bmp.write("BM");
      bmp.writeUInt32LE(58, 2);
      bmp.writeUInt32LE(54, 10);
      bmp.writeUInt32LE(40, 14);
      bmp.writeInt32LE(1, 18);
      bmp.writeInt32LE(1, 22);
      bmp.writeUInt16LE(1, 26);
      bmp.writeUInt16LE(24, 28);
      bmp.writeUInt32LE(4, 34);
      fs.writeFileSync(image, bmp);

      const result = await createReadTool().execute(
        "image",
        { path: image },
        undefined,
        undefined,
        callContext(cwd),
      );
      expect(
        result.content.some(
          (part) => part.type === "image" && part.mimeType === "image/png",
        ),
      ).toBe(true);
      expect(result.details).toBeUndefined();
      fs.unlinkSync(image);
    });

    it("checks policy and secret refusal against resolved targets", async () => {
      const cwd = makeDirectory();
      const secret = path.join(cwd, ".env");
      const alias = path.join(cwd, "safe-name.txt");
      fs.writeFileSync(secret, "secret");
      fs.symlinkSync(secret, alias);
      const loadRules = vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([
        {
          tool: "read",
          matches: { path: fs.realpathSync(secret) },
          action: "reject",
          message: "blocked",
        },
      ]);

      const result = await createReadTool().execute(
        "policy",
        { path: alias },
        undefined,
        undefined,
        callContext(cwd),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual({
        type: "text",
        text: "path rejected: blocked",
      });

      loadRules.mockReturnValue([{ tool: "read", action: "allow" }]);
      loadRules.mockReturnValue([
        {
          tool: "read",
          matches: { path: alias },
          action: "reject",
          message: "alias blocked",
        },
      ]);
      const aliasResult = await createReadTool().execute(
        "alias",
        { path: alias },
        undefined,
        undefined,
        callContext(cwd),
      );
      expect(aliasResult.structuredContent).toBe(
        "path rejected: alias blocked",
      );

      loadRules.mockReturnValue([{ tool: "read", action: "allow" }]);
      const secretResult = await createReadTool().execute(
        "secret",
        { path: alias },
        undefined,
        undefined,
        callContext(cwd),
      );
      expect(secretResult.isError).toBe(true);
      expect(secretResult.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("may contain secrets"),
      });
    });

    it("propagates SDK cancellation", async () => {
      const cwd = makeDirectory();
      const file = path.join(cwd, "text.txt");
      fs.writeFileSync(file, "content");
      const controller = new AbortController();
      controller.abort();

      await expect(
        createReadTool().execute(
          "cancelled",
          { path: file },
          controller.signal,
          undefined,
          callContext(cwd),
        ),
      ).rejects.toThrow("Operation aborted");
    });

    it("renders normal and error output through the Pi read renderer", async () => {
      const cwd = makeDirectory();
      const file = path.join(cwd, "display.txt");
      fs.writeFileSync(file, "visible output");
      const tool = createReadTool();
      const result = await tool.execute(
        "display",
        { path: file },
        undefined,
        undefined,
        callContext(cwd),
      );
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as Theme;
      const context = {
        args: { path: file },
        cwd,
        showImages: false,
        isError: false,
        lastComponent: undefined,
      } as Parameters<NonNullable<typeof tool.renderResult>>[3];

      const normal = tool.renderResult?.(
        result,
        { expanded: true, isPartial: false },
        theme,
        context,
      );
      expect(normal?.render(80).join("\n")).toContain("visible output");

      vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([
        {
          tool: "read",
          matches: { path: fs.realpathSync(file) },
          action: "reject",
          message: "blocked",
        },
      ]);
      const denied = await tool.execute(
        "denied",
        { path: file },
        undefined,
        undefined,
        callContext(cwd),
      );
      const errorContext = { ...context, isError: true };
      const error = tool.renderResult?.(
        denied,
        { expanded: false, isPartial: false },
        theme,
        errorContext,
      );
      expect(error?.render(80).join("\n")).toContain("path rejected: blocked");
    });
  });

  describe("read extension registration", () => {
    it("registers the default adapter with prompt patching", () => {
      const tools: unknown[] = [];
      const pi = {
        registerTool: (tool: unknown) => tools.push(tool),
      } as unknown as ExtensionAPI;
      const patched: unknown[] = [];
      const extension = createReadExtension({
        getEnabledExtensionConfig: ((_name, defaults) => ({
          enabled: true,
          config: defaults,
        })) as typeof getEnabledExtensionConfig,
        withPromptPatch: ((tool) => {
          patched.push(tool);
          return tool;
        }) as typeof withPromptPatch,
      });

      extension(pi);

      expect(tools).toHaveLength(1);
      expect((tools[0] as ToolDefinition).name).toBe("read");
      expect(patched).toHaveLength(1);
    });
  });
}
