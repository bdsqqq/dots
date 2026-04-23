/**
 * read tool — replaces pi's built-in with enhanced file reading.
 *
 * differences from pi's built-in:
 * - line-numbered output (`1: content`)
 * - directory listing integrated (no separate ls tool needed)
 * - secret file blocking (.env etc.)
 * - `~` expansion and `@` prefix stripping
 * - image support via base64
 *
 * uses `path` + optional `read_range` [start, end] interface.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { Text } from "@mariozechner/pi-tui";
import {
  boxRendererWindowed,
  osc8Link,
  type BoxSection,
  type BoxLine,
  type Excerpt,
} from "@bds_pi/box-format";
import { Type } from "@sinclair/typebox";
import { formatHeadTail } from "@bds_pi/output-buffer";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import {
  isSecretFile,
  listDirectory,
  resolveToAbsolute,
  resolveWithVariants,
} from "@bds_pi/fs";
import * as toolPolicy from "@bds_pi/tool-policy";
export {
  expandPath,
  resolveToAbsolute,
  resolveWithVariants,
  isSecretFile,
  listDirectory,
} from "@bds_pi/fs";

// --- limits ---

export interface ReadLimits {
  maxLines: number;
  maxFileBytes: number;
  maxLineBytes: number;
  maxDirEntries: number;
}

export const NORMAL_LIMITS: ReadLimits = {
  maxLines: 500,
  maxFileBytes: 64 * 1024,
  maxLineBytes: 4096,
  maxDirEntries: 1000,
};

type ReadExtConfig = {
  maxLines: number;
  maxFileBytes: number;
  maxLineBytes: number;
  maxDirEntries: number;
};

type ReadExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: ReadExtConfig = {
  maxLines: 500,
  maxFileBytes: 65536,
  maxLineBytes: 4096,
  maxDirEntries: 1000,
};

const DEFAULT_DEPS: ReadExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isReadConfig(value: Record<string, unknown>): value is ReadExtConfig {
  return (
    isPositiveInteger(value.maxLines) &&
    isPositiveInteger(value.maxFileBytes) &&
    isPositiveInteger(value.maxLineBytes) &&
    isPositiveInteger(value.maxDirEntries)
  );
}

const READ_CONFIG_SCHEMA: ExtensionConfigSchema<ReadExtConfig> = {
  validate: isReadConfig,
};

interface ReadParams {
  path: string;
  read_range?: [number, number];
}

const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function getImageMime(filePath: string): string | undefined {
  return IMAGE_MIME[path.extname(filePath).toLowerCase()];
}

// --- file reading ---

interface ReadResult {
  text: string;
  totalLines: number;
  shownStart: number;
  shownEnd: number;
}

export function readFileContent(
  filePath: string,
  limits: ReadLimits,
  readRange?: [number, number],
): ReadResult {
  const raw = fs.readFileSync(filePath, "utf-8");
  const allLines = raw.split("\n");
  const totalLines = allLines.length;

  // determine the range to show
  const start = Math.max(1, readRange?.[0] ?? 1);
  const end = Math.min(
    totalLines,
    readRange?.[1] ?? start + limits.maxLines - 1,
  );
  const _requestedLines = end - start + 1;

  // number lines and truncate long lines
  const numbered: string[] = [];
  for (let i = start - 1; i < end; i++) {
    let line = allLines[i];
    if (line === undefined) continue;
    const lineBytes = Buffer.byteLength(line, "utf-8");

    if (lineBytes > limits.maxLineBytes) {
      while (Buffer.byteLength(line, "utf-8") > limits.maxLineBytes) {
        line = line.slice(0, Math.max(1, line.length - 100));
      }
      line += "... (line truncated)";
    }

    numbered.push(`${i + 1}: ${line}`);
  }

  // if numbered output fits in byte limit, return as-is
  const totalBytes = numbered.reduce(
    (sum, l) => sum + Buffer.byteLength(l, "utf-8") + 1,
    0,
  );
  if (totalBytes <= limits.maxFileBytes) {
    return {
      text: numbered.join("\n"),
      totalLines,
      shownStart: start,
      shownEnd: end,
    };
  }

  // otherwise apply head+tail truncation on the numbered lines
  const formatted = formatHeadTail(
    numbered,
    limits.maxLines,
    (n) =>
      `... [${n} lines truncated, ${limits.maxFileBytes / 1024}KB limit reached] ...`,
  );

  return {
    text: formatted,
    totalLines,
    shownStart: start,
    shownEnd: end,
  };
}

// --- tool factory ---

export function createReadTool(limits: ReadLimits): ToolDefinition<any> {
  return {
    name: "read",
    label: "Read",
    description:
      "Read a file or list a directory from the file system. If the path is a directory, it returns a list of entries. If the file or directory doesn't exist, an error is returned.\n\n" +
      `- The path parameter MUST be an absolute path.\n` +
      `- By default, this tool returns the first ${limits.maxLines} lines. To read more, call it multiple times with different read_ranges.\n` +
      "- Use the Grep tool to find specific content in large files or files with long lines.\n" +
      "- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n" +
      '- The contents are returned with each line prefixed by its line number. For example, if a file has contents "abc\\n", you will receive "1: abc\\n". For directories, entries are returned one per line (without line numbers) with a trailing "/" for subdirectories.\n' +
      "- This tool can read images (such as PNG, JPEG, and GIF files) and present them to the model visually.\n" +
      "- When possible, call this tool in parallel for all files you will want to read.\n" +
      "      - Avoid tiny repeated slices (e.g., 50‑line chunks). If you need more context from the same file, read a larger range or the full default window instead.",

    parameters: Type.Object({
      path: Type.String({
        description:
          "The absolute path to the file or directory (MUST be absolute, not relative).",
      }),
      read_range: Type.Optional(
        Type.Array(Type.Number(), {
          description: `An array of two integers specifying the start and end line numbers to view. Line numbers are 1-indexed. If not provided, defaults to [1, ${limits.maxLines}]. Examples: [500, 700], [700, 1400]`,
          minItems: 2,
          maxItems: 2,
        }),
      ),
    }),

    renderCall(args: any, theme: any) {
      const filePath = args.path || "...";
      const home = os.homedir();
      const shortened = filePath.startsWith(home)
        ? `~${filePath.slice(home.length)}`
        : filePath;
      const readRange = args.read_range;
      let context = shortened;
      if (Array.isArray(readRange) && readRange.length === 2) {
        context += `:${readRange[0]}-${readRange[1]}`;
      }
      const linked = filePath.startsWith("/")
        ? osc8Link(`file://${filePath}`, context)
        : context;
      return new Text(
        theme.fg("toolTitle", theme.bold("Read ")) + theme.fg("dim", linked),
        0,
        0,
      );
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as ReadParams;
      const requestedPath = resolveToAbsolute(p.path, ctx.cwd);
      const verdict = toolPolicy.evaluateToolPolicy(
        "read",
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

      const resolved = resolveWithVariants(p.path, ctx.cwd);

      if (isSecretFile(resolved)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `refused to read ${path.basename(resolved)}: file may contain secrets. ask the user to share relevant values.`,
            },
          ],
          isError: true,
        } as any;
      }

      if (!fs.existsSync(resolved)) {
        return {
          content: [
            { type: "text" as const, text: `file not found: ${resolved}` },
          ],
          isError: true,
        } as any;
      }

      const stat = fs.statSync(resolved);

      // --- directory ---
      if (stat.isDirectory()) {
        try {
          let text = listDirectory(resolved, limits.maxDirEntries);
          return {
            content: [{ type: "text" as const, text }],
            details: { filePath: resolved, isDirectory: true },
          } as any;
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          } as any;
        }
      }

      // --- image ---
      const mime = getImageMime(resolved);
      if (mime) {
        try {
          const base64 = fs.readFileSync(resolved).toString("base64");
          return {
            content: [{ type: "image" as const, data: base64, mimeType: mime }],
          } as any;
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `failed to read image: ${err.message}`,
              },
            ],
            isError: true,
          } as any;
        }
      }

      // --- text file ---
      try {
        const readRange = p.read_range;
        const { text, totalLines, shownStart, shownEnd } = readFileContent(
          resolved,
          limits,
          readRange,
        );

        let output = text;
        let notice: string | undefined;

        if (shownEnd < totalLines) {
          notice = `showing lines ${shownStart}-${shownEnd} of ${totalLines}`;
          output += `\n\n(${notice}. use read_range to see more.)`;
        }

        return {
          content: [{ type: "text" as const, text: output }],
          details: { filePath: resolved, notice },
        } as any;
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `failed to read file: ${err.message}`,
            },
          ],
          isError: true,
        } as any;
      }
    },

    renderResult(result: any, _options: { expanded: boolean }, _theme: any) {
      const text = result.content?.[0];
      if (text?.type !== "text") return new Text("(no output)", 0, 0);

      const _filePath: string = result.details?.filePath ?? "";
      const _isDir: boolean = result.details?.isDirectory ?? false;
      const notice: string | undefined = result.details?.notice;

      const rawLines = (text.text as string).split("\n");

      // parse numbered lines (e.g., "  42: content") into BoxLine[]
      const parsed: BoxLine[] = rawLines.map((line) => {
        const m = line.match(/^(\s*\d+): (.*)$/);
        if (m && m[1] && m[2])
          return { gutter: m[1].trim(), text: m[2], highlight: true };
        return { text: line, highlight: true };
      });

      // strip trailing notice that we'll move to the box footer
      if (notice && parsed.length > 0) {
        const last = parsed[parsed.length - 1];
        if (last && last.text.startsWith(`(${notice}`)) {
          parsed.pop(); // notice line
          const newLast = parsed[parsed.length - 1];
          if (parsed.length && newLast && newLast.text === "") {
            parsed.pop(); // blank before notice
          }
        }
      }

      const notices = notice ? [notice] : undefined;

      /** collapsed: head 3 + tail 5 visual lines */
      const COLLAPSED_EXCERPTS: Excerpt[] = [
        { focus: "head", context: 3 },
        { focus: "tail", context: 5 },
      ];

      const section: BoxSection = { blocks: [{ lines: parsed }] };

      return boxRendererWindowed(
        () => [section],
        {
          collapsed: { excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        notices,
        _options.expanded,
      );
    },
  };
}

/**
 * read is hotter than the other shadow tools because sibling extensions import
 * its exported limits/types at module load time. config gating therefore needs
 * to stay at startup registration only: skip the custom read wrapper when
 * disabled, but keep this module's exports stable so imports like `@bds_pi/read`
 * in `ls` still evaluate normally.
 */
function createReadExtension(
  deps: ReadExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function readExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/read",
      CONFIG_DEFAULTS,
      { schema: READ_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(deps.withPromptPatch(createReadTool(cfg)));
  };
}

const readExtension: (pi: ExtensionAPI) => void = createReadExtension();

export default readExtension;

if (import.meta.vitest) {
  const { afterEach, beforeEach, describe, expect, it, vi } = import.meta
    .vitest;
  const tmpdir = os.tmpdir();

  function writeTmpJson(dir: string, filename: string, data: unknown): string {
    const filePath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  function createMockExtensionApiHarness() {
    const tools: unknown[] = [];

    const pi = {
      registerTool(tool: unknown) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;

    return { pi, tools };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  });

  // --- pure function tests (Layer 1) ---

  describe("getImageMime", () => {
    it("returns mime type for known image extensions", () => {
      expect(getImageMime("photo.jpg")).toBe("image/jpeg");
      expect(getImageMime("photo.jpeg")).toBe("image/jpeg");
      expect(getImageMime("icon.png")).toBe("image/png");
      expect(getImageMime("animation.gif")).toBe("image/gif");
      expect(getImageMime("modern.webp")).toBe("image/webp");
    });

    it("is case-insensitive", () => {
      expect(getImageMime("PHOTO.JPG")).toBe("image/jpeg");
      expect(getImageMime("Photo.PnG")).toBe("image/png");
    });

    it("returns undefined for non-image files", () => {
      expect(getImageMime("file.txt")).toBeUndefined();
      expect(getImageMime("file.json")).toBeUndefined();
      expect(getImageMime("file.ts")).toBeUndefined();
      expect(getImageMime("file")).toBeUndefined();
    });
  });

  describe("readFileContent", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(tmpdir, "pi-read-content-"));
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("numbers lines starting from 1", () => {
      const filePath = path.join(testDir, "test.txt");
      fs.writeFileSync(filePath, "first\nsecond\nthird");

      const result = readFileContent(filePath, NORMAL_LIMITS);

      expect(result.text).toBe("1: first\n2: second\n3: third");
      expect(result.totalLines).toBe(3);
      expect(result.shownStart).toBe(1);
      expect(result.shownEnd).toBe(3);
    });

    it("respects read_range [start, end]", () => {
      const filePath = path.join(testDir, "test.txt");
      fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5");

      const result = readFileContent(filePath, NORMAL_LIMITS, [2, 4]);

      expect(result.text).toBe("2: line2\n3: line3\n4: line4");
      expect(result.totalLines).toBe(5);
      expect(result.shownStart).toBe(2);
      expect(result.shownEnd).toBe(4);
    });

    it("clamps read_range to file bounds", () => {
      const filePath = path.join(testDir, "test.txt");
      fs.writeFileSync(filePath, "only\nline");

      const result = readFileContent(filePath, NORMAL_LIMITS, [0, 100]);

      expect(result.text).toBe("1: only\n2: line");
      expect(result.shownStart).toBe(1);
      expect(result.shownEnd).toBe(2);
    });

    it("truncates long lines exceeding maxLineBytes", () => {
      const filePath = path.join(testDir, "test.txt");
      const longLine = "x".repeat(5000);
      fs.writeFileSync(filePath, longLine);

      const result = readFileContent(filePath, {
        ...NORMAL_LIMITS,
        maxLineBytes: 100,
      });

      expect(result.text).toContain("... (line truncated)");
      expect(result.text.length).toBeLessThan(200);
    });

    it("applies head+tail truncation when exceeding maxFileBytes", () => {
      const filePath = path.join(testDir, "test.txt");
      // Create 100 lines, each ~210 chars = ~21KB total
      const lines = Array.from(
        { length: 100 },
        (_, i) => `line ${i + 1}: ${"x".repeat(200)}`,
      );
      fs.writeFileSync(filePath, lines.join("\n"));

      // Use read_range to read all 100 lines, maxFileBytes triggers truncation
      // formatHeadTail will show head+tail with 25 each (maxLines=50)
      const result = readFileContent(
        filePath,
        { ...NORMAL_LIMITS, maxFileBytes: 1000, maxLines: 50 },
        [1, 100],
      );

      expect(result.text).toContain("truncated");
      expect(result.totalLines).toBe(100);
    });
  });

  // --- extension registration tests ---

  describe("read extension", () => {
    it("registers the tool with default config when enabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: true,
          config: defaults,
        }),
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createReadExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/read",
        CONFIG_DEFAULTS,
        { schema: READ_CONFIG_SCHEMA },
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
      expect(harness.tools[0]).toMatchObject({ name: "read" });
    });

    it("registers no extension tool when disabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: false,
          config: defaults,
        }),
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createReadExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-read-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/read": {
          maxLines: 0,
          maxFileBytes: 0,
          maxLineBytes: 0,
          maxDirEntries: 0,
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createReadExtension({
        ...DEFAULT_DEPS,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/read; falling back to defaults.",
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
      expect(harness.tools[0]).toMatchObject({ name: "read" });
    });
  });

  describe("read tool policy", () => {
    it("rejects disallowed paths before filesystem checks", async () => {
      const tool = createReadTool(NORMAL_LIMITS);
      const evaluateToolPolicySpy = vi
        .spyOn(toolPolicy, "evaluateToolPolicy")
        .mockReturnValue({ action: "reject", message: "workspace only" });
      vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([]);

      const result = (await tool.execute!(
        "test-id",
        { path: "../sibling/secret.txt" },
        undefined,
        undefined,
        { cwd: "/repo/project" } as any,
      )) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("path rejected: workspace only");
      expect(evaluateToolPolicySpy).toHaveBeenCalledWith(
        "read",
        { path: "/repo/sibling/secret.txt", sessionCwd: "/repo/project" },
        [],
      );
    });
  });
}
