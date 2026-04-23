/**
 * grep tool — replaces pi's built-in with tighter limits and context lines.
 *
 * differences from pi's built-in:
 * - per-file match limit (10, prevents one noisy file from consuming quota)
 * - 200-char line truncation (vs pi's 500)
 * - caseSensitive param (default case-sensitive)
 * - suggests literal:true when pattern contains regex metacharacters
 * - spawns rg directly (no ensureTool — nix provides rg on PATH)
 * - includes ±1 context lines around matches (via rg --context) so
 *   the LLM sees surrounding code and show() has natural gaps to elide
 *
 * shadows pi's built-in `grep` tool via same-name registration.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createInterface } from "node:readline";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { Type } from "typebox";
import { headTail } from "@bds_pi/output-buffer";
import {
  boxRendererWindowed,
  osc8Link,
  type BoxSection,
  type BoxLine,
  type Excerpt,
} from "@bds_pi/box-format";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";

type GrepExtConfig = {
  maxTotalMatches: number;
  maxPerFile: number;
  maxLineChars: number;
  contextLines: number;
};

type GrepExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: GrepExtConfig = {
  maxTotalMatches: 100,
  maxPerFile: 10,
  maxLineChars: 200,
  contextLines: 1,
};

const DEFAULT_DEPS: GrepExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isGrepConfig(value: Record<string, unknown>): value is GrepExtConfig {
  return (
    isPositiveInteger(value.maxTotalMatches) &&
    isPositiveInteger(value.maxPerFile) &&
    isPositiveInteger(value.maxLineChars) &&
    typeof value.contextLines === "number" &&
    Number.isInteger(value.contextLines) &&
    value.contextLines >= 0
  );
}

const GREP_CONFIG_SCHEMA: ExtensionConfigSchema<GrepExtConfig> = {
  validate: isGrepConfig,
};

/** max files shown in collapsed display */
const COLLAPSED_MAX_FILES = 3;
/** per-block excerpts for collapsed display — show first 5 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 5 }];

function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return line.slice(0, maxChars) + "...";
}

function looksLikeRegex(pattern: string): boolean {
  return /[{}()[\]|\\+*?^$]/.test(pattern);
}

// --- structured data for visual rendering ---

interface GrepMatch {
  lineNum: number;
  text: string;
  isContext: boolean;
}

interface GrepFile {
  path: string;
  matches: GrepMatch[];
  hitLimit: boolean;
}

/**
 * convert GrepFile[] to BoxSection[] for box-format rendering.
 * each file becomes a section, contiguous match groups become blocks.
 */
function grepToSections(files: GrepFile[], maxPerFile: number): BoxSection[] {
  return files.map((f) => {
    const blocks: { lines: BoxLine[] }[] = [];
    let current: BoxLine[] = [];
    let lastLineNum = -2;

    for (const m of f.matches) {
      // gap > 1 line means new block
      if (lastLineNum >= 0 && m.lineNum > lastLineNum + 1) {
        if (current.length > 0) {
          blocks.push({ lines: current });
          current = [];
        }
      }
      current.push({
        gutter: String(m.lineNum),
        text: m.text,
        highlight: !m.isContext,
      });
      lastLineNum = m.lineNum;
    }
    if (current.length > 0) blocks.push({ lines: current });

    return {
      header: f.path + (f.hitLimit ? ` [${maxPerFile} match limit]` : ""),
      blocks,
    };
  });
}

interface RgEvent {
  kind: "match" | "context";
  filePath: string;
  lineNumber: number;
  lineText: string;
}

interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  literal?: boolean;
}

export function createGrepTool(
  config: GrepExtConfig = CONFIG_DEFAULTS,
): ToolDefinition<any> {
  const maxCollectMatches = config.maxTotalMatches * 2;

  return {
    name: "grep",
    label: "Grep",
    description:
      "Search for exact text patterns in files using ripgrep, a fast keyword search tool.\n\n" +
      "# When to use\n" +
      "- Finding exact text matches (variable names, function calls, specific strings)\n\n" +
      "# Constraints\n" +
      `- Results are limited to ${config.maxTotalMatches} matches (up to ${config.maxPerFile} per file)\n` +
      `- Lines are truncated at ${config.maxLineChars} characters\n\n` +
      "# Strategy\n" +
      "- Use 'path' or 'glob' to narrow searches; run multiple focused calls rather than one broad search\n" +
      "- Uses Rust-style regex (escape `{` and `}`); use `literal: true` for literal text search\n",

    parameters: Type.Object({
      pattern: Type.String({
        description: "The pattern to search for (regex by default).",
      }),
      path: Type.Optional(
        Type.String({
          description:
            "The file or directory path to search in. Cannot be used with glob.",
        }),
      ),
      glob: Type.Optional(
        Type.String({
          description:
            "The glob pattern to filter files (e.g., '**/*.ts'). Cannot be used with path.",
        }),
      ),
      caseSensitive: Type.Optional(
        Type.Boolean({
          description: "Whether to search case-sensitively (default: true).",
        }),
      ),
      literal: Type.Optional(
        Type.Boolean({
          description:
            "Whether to treat the pattern as a literal string instead of a regex.",
        }),
      ),
    }),

    renderCall(args: any, theme: any) {
      const pattern = args.pattern || "...";
      const searchPath = args.path || args.glob || ".";
      const home = os.homedir();
      const shortened = searchPath.startsWith(home)
        ? `~${searchPath.slice(home.length)}`
        : searchPath;
      const linkedPath = searchPath.startsWith("/")
        ? osc8Link(`file://${searchPath}`, shortened)
        : shortened;
      const caseSuffix = args.caseSensitive === false ? " -i" : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("Grep ")) +
          theme.fg("dim", `/${pattern}/${caseSuffix} in ${linkedPath}`),
        0,
        0,
      );
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = params as GrepParams;
      const searchPath = p.path
        ? path.isAbsolute(p.path)
          ? p.path
          : path.resolve(ctx.cwd, p.path)
        : ctx.cwd;

      return new Promise((resolve) => {
        const args = [
          "--json",
          "--line-number",
          "--color=never",
          "--hidden",
          "--context",
          String(config.contextLines),
        ];

        if (p.caseSensitive === false) {
          args.push("--ignore-case");
        }
        if (p.literal) {
          args.push("--fixed-strings");
        }
        if (p.glob) {
          args.push("--glob", p.glob);
        }

        args.push("--", p.pattern, searchPath);

        const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
        const rl = createInterface({ input: child.stdout! });

        let stderr = "";
        let totalMatches = 0;
        let killedDueToLimit = false;
        let aborted = false;
        /** all match + context events, in stream order */
        const events: RgEvent[] = [];

        const onAbort = () => {
          aborted = true;
          if (!child.killed) child.kill();
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        rl.on("line", (line) => {
          if (!line.trim() || killedDueToLimit) return;

          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }

          if (event.type !== "match" && event.type !== "context") return;

          const filePath: string | undefined = event.data?.path?.text;
          const lineNumber: number | undefined = event.data?.line_number;
          const lineText: string = (event.data?.lines?.text ?? "").replace(
            /\r?\n$/,
            "",
          );
          if (!filePath || typeof lineNumber !== "number") return;

          if (event.type === "match") {
            totalMatches++;
          }

          events.push({
            kind: event.type as "match" | "context",
            filePath,
            lineNumber,
            lineText,
          });

          if (totalMatches >= maxCollectMatches) {
            killedDueToLimit = true;
            if (!child.killed) child.kill();
          }
        });

        child.on("error", (err) => {
          try {
            rl.close();
          } catch {}
          signal?.removeEventListener("abort", onAbort);
          resolve({
            content: [
              { type: "text" as const, text: `grep error: ${err.message}` },
            ],
            isError: true,
          } as any);
        });

        child.on("close", (code) => {
          rl.close();
          signal?.removeEventListener("abort", onAbort);

          if (aborted) {
            resolve({
              content: [{ type: "text" as const, text: "search aborted" }],
              isError: true,
            } as any);
            return;
          }

          if (!killedDueToLimit && code !== 0 && code !== 1) {
            resolve({
              content: [
                {
                  type: "text" as const,
                  text: stderr.trim() || `ripgrep exited with code ${code}`,
                },
              ],
              isError: true,
            } as any);
            return;
          }

          if (totalMatches === 0) {
            let text = "no matches found";
            if (!p.literal && looksLikeRegex(p.pattern)) {
              text +=
                "\n\n(pattern contains regex characters — try literal: true if searching for exact text)";
            }
            resolve({ content: [{ type: "text" as const, text }] } as any);
            return;
          }

          // --- phase 2: build output from collected events ---

          // group events by file, preserving order
          const fileOrder: string[] = [];
          const fileEvents = new Map<string, RgEvent[]>();
          for (const ev of events) {
            if (!fileEvents.has(ev.filePath)) {
              fileOrder.push(ev.filePath);
              fileEvents.set(ev.filePath, []);
            }
            fileEvents.get(ev.filePath)!.push(ev);
          }

          const outputLines: string[] = [];
          /** output line indices that are actual matches (not context) */
          const matchLineIndices: number[] = [];
          /** index of first match line per file — focus points for collapsed display */
          const firstMatchPerFile: number[] = [];
          const perFileMatchCount = new Map<string, number>();
          const fileGroups: GrepFile[] = [];

          for (let fi = 0; fi < fileOrder.length; fi++) {
            const filePath = fileOrder[fi];
            if (!filePath) continue;
            const fileEvts = fileEvents.get(filePath)!;

            // determine which matches to include (per-file limit)
            const includedMatchLines = new Set<number>();
            let matchesInFile = 0;
            for (const ev of fileEvts) {
              if (ev.kind === "match") {
                matchesInFile++;
                if (matchesInFile <= config.maxPerFile) {
                  includedMatchLines.add(ev.lineNumber);
                }
              }
            }
            perFileMatchCount.set(
              filePath,
              Math.min(matchesInFile, config.maxPerFile),
            );

            // include context lines only if adjacent to an included match
            const includedLines = new Set<number>();
            for (const ln of includedMatchLines) {
              includedLines.add(ln);
              // include context lines within contextLines distance
              for (let d = 1; d <= config.contextLines; d++) {
                includedLines.add(ln - d);
                includedLines.add(ln + d);
              }
            }

            // blank separator between file groups
            if (fi > 0) {
              outputLines.push("");
            }

            const rel = path.relative(searchPath, filePath).replace(/\\/g, "/");
            const displayPath =
              rel && !rel.startsWith("..") ? rel : path.basename(filePath);

            const grepFile: GrepFile = {
              path: displayPath,
              matches: [],
              hitLimit: matchesInFile > config.maxPerFile,
            };

            let lastOutputLineNum = -Infinity;
            let isFirstMatchInFile = true;

            for (const ev of fileEvts) {
              if (!includedLines.has(ev.lineNumber)) continue;
              // deduplicate (rg can emit same line as both context for
              // adjacent matches — we only want it once)
              if (ev.lineNumber <= lastOutputLineNum) continue;

              // insert "--" separator for non-contiguous groups within file
              // (gap > 1 means there's a break in line numbers)
              if (
                lastOutputLineNum >= 0 &&
                ev.lineNumber > lastOutputLineNum + 1
              ) {
                outputLines.push("--");
              }

              const idx = outputLines.length;
              outputLines.push(
                `${displayPath}:${ev.lineNumber}: ${truncateLine(ev.lineText, config.maxLineChars)}`,
              );
              lastOutputLineNum = ev.lineNumber;

              grepFile.matches.push({
                lineNum: ev.lineNumber,
                text: truncateLine(ev.lineText, config.maxLineChars),
                isContext: ev.kind === "context",
              });

              if (includedMatchLines.has(ev.lineNumber)) {
                matchLineIndices.push(idx);
                if (isFirstMatchInFile) {
                  firstMatchPerFile.push(idx);
                  isFirstMatchInFile = false;
                }
              }
            }
            fileGroups.push(grepFile);
          }

          // apply head+tail if over display limit
          let output: string;
          const notices: string[] = [];
          let finalMatchIndices: number[];

          if (outputLines.length > config.maxTotalMatches * 3) {
            // with context lines, the threshold is higher
            const limit = config.maxTotalMatches * 2;
            const { head, tail, truncatedCount } = headTail(outputLines, limit);
            output = [
              ...head,
              "",
              `... [${truncatedCount} lines truncated] ...`,
              "",
              ...tail,
            ].join("\n");
            // remap match indices into the truncated output
            const headLen = head.length;
            const gapLen = 3; // blank + marker + blank
            const tailStart = outputLines.length - tail.length;
            finalMatchIndices = matchLineIndices
              .map((i) => {
                if (i < headLen) return i;
                if (i >= tailStart) return headLen + gapLen + (i - tailStart);
                return -1; // truncated
              })
              .filter((i) => i >= 0);
            notices.push(
              `${truncatedCount} lines truncated, showing first and last ${limit / 2}`,
            );
          } else {
            output = outputLines.join("\n");
            finalMatchIndices = matchLineIndices;
          }

          if (killedDueToLimit) {
            notices.push(
              `stopped at ${maxCollectMatches} matches — refine pattern`,
            );
          }

          const filesAtLimit = Array.from(perFileMatchCount.values()).filter(
            (c) => c >= config.maxPerFile,
          ).length;
          if (filesAtLimit > 0) {
            notices.push(
              `${filesAtLimit} file${filesAtLimit > 1 ? "s" : ""} hit the ${config.maxPerFile}-per-file limit`,
            );
          }

          if (notices.length > 0) {
            output += `\n\n[${notices.join(". ")}]`;
          }

          resolve({
            content: [{ type: "text" as const, text: output }],
            details: {
              fileGroups,
              notices,
              matchLineIndices: finalMatchIndices,
              firstMatchPerFile,
              searchPath,
            },
          } as any);
        });
      });
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const fileGroups: GrepFile[] | undefined = result.details?.fileGroups;
      const notices: string[] = result.details?.notices ?? [];
      const basePath: string | undefined = result.details?.searchPath;

      // fallback for old results or error results without fileGroups
      if (!fileGroups?.length) {
        const text = result.content?.[0]?.text ?? "(no output)";
        return new Text(text, 0, 0);
      }

      const sections = grepToSections(fileGroups, config.maxPerFile);

      // wrap section headers in OSC 8 file:// links
      if (basePath) {
        for (let i = 0; i < sections.length; i++) {
          const fg = fileGroups[i];
          const section = sections[i];
          if (!fg || !section) continue;
          const relPath = fg.path;
          const absPath = basePath + "/" + relPath;
          sections[i] = {
            ...section,
            header: osc8Link(`file://${absPath}`, section.header ?? ""),
          };
        }
      }

      return boxRendererWindowed(
        () => sections,
        {
          collapsed: {
            maxSections: COLLAPSED_MAX_FILES,
            excerpts: COLLAPSED_EXCERPTS,
          },
          expanded: {},
        },
        notices.length > 0 ? notices : undefined,
        expanded,
      );
    },
  };
}

/**
 * grep shadows pi's built-in tool, so disabling this extension needs to skip
 * only the custom wrapper and let pi fall back to its built-in definition.
 * that keeps tool-name resolution stable for sub-agents that explicitly opt
 * into grep, while letting default top-level sessions inherit pi's own active
 * tool policy instead of forcing this wrapper on.
 */
function createGrepExtension(
  deps: GrepExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function grepExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/grep",
      CONFIG_DEFAULTS,
      { schema: GREP_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(deps.withPromptPatch(createGrepTool(cfg)));
  };
}

const grepExtension: (pi: ExtensionAPI) => void = createGrepExtension();

export default grepExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
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

  describe("grep extension", () => {
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
      const extension = createGrepExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/grep",
        CONFIG_DEFAULTS,
        { schema: GREP_CONFIG_SCHEMA },
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
      expect(harness.tools[0]).toMatchObject({ name: "grep" });
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
      const extension = createGrepExtension({
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
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-grep-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/grep": {
          maxTotalMatches: 0,
          maxPerFile: 0,
          maxLineChars: 0,
          contextLines: -1,
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createGrepExtension({
        ...DEFAULT_DEPS,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/grep; falling back to defaults.",
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
      expect(harness.tools[0]).toMatchObject({ name: "grep" });
    });
  });
}
