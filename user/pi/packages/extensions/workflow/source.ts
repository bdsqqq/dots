import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: string[];
}

export interface WorkflowSource {
  source: string;
  text?: string;
  body: string;
  meta: WorkflowMeta;
  hash: string;
  path?: string;
  projectLocal: boolean;
}

const META_PREFIX = "export const meta = ";
const MAX_DECLARED_PHASES = 64;
const MAX_PHASE_NAME_BYTES = 256;

class MetaParser {
  private index: number;

  constructor(
    private readonly source: string,
    start: number,
  ) {
    this.index = start;
  }

  parse(): { meta: WorkflowMeta; end: number } {
    const values = new Map<string, string | string[]>();
    this.expect("{");
    this.skipTrivia();
    while (this.peek() !== "}") {
      const key = this.parseKey();
      if (!new Set(["name", "description", "phases"]).has(key))
        throw new Error(`unknown workflow meta field: ${key}`);
      if (values.has(key))
        throw new Error(`duplicate workflow meta field: ${key}`);
      this.skipTrivia();
      this.expect(":");
      this.skipTrivia();
      values.set(
        key,
        key === "phases" ? this.parseStringArray() : this.parseString(),
      );
      this.skipTrivia();
      if (this.peek() === ",") {
        this.index++;
        this.skipTrivia();
        if (this.peek() === "}") break;
      } else if (this.peek() !== "}") {
        throw new Error("workflow meta fields must be separated by commas");
      }
    }
    this.expect("}");
    const name = values.get("name");
    const description = values.get("description");
    const phases = values.get("phases");
    if (Array.isArray(phases)) {
      if (phases.length > MAX_DECLARED_PHASES)
        throw new Error(
          `workflow meta.phases supports at most ${MAX_DECLARED_PHASES} entries`,
        );
      const invalidPhase = phases.find(
        (phase) =>
          phase.trim() === "" ||
          Buffer.byteLength(phase, "utf8") > MAX_PHASE_NAME_BYTES,
      );
      if (invalidPhase !== undefined)
        throw new Error(
          `workflow phase names must be non-empty and at most ${MAX_PHASE_NAME_BYTES} UTF-8 bytes`,
        );
    }
    if (typeof name !== "string" || name.trim() === "")
      throw new Error("workflow meta.name must be a non-empty string");
    if (typeof description !== "string" || description.trim() === "")
      throw new Error("workflow meta.description must be a non-empty string");
    return {
      meta: {
        name,
        description,
        ...(Array.isArray(phases) ? { phases } : {}),
      },
      end: this.index,
    };
  }

  private parseKey(): string {
    this.skipTrivia();
    if (this.peek() === '"' || this.peek() === "'") return this.parseString();
    const match = this.source.slice(this.index).match(/^[A-Za-z_$][\w$]*/);
    if (!match)
      throw new Error("workflow meta keys must be identifiers or strings");
    this.index += match[0].length;
    return match[0];
  }

  private parseStringArray(): string[] {
    const values: string[] = [];
    this.expect("[");
    this.skipTrivia();
    while (this.peek() !== "]") {
      values.push(this.parseString());
      this.skipTrivia();
      if (this.peek() === ",") {
        this.index++;
        this.skipTrivia();
        if (this.peek() === "]") break;
      } else if (this.peek() !== "]") {
        throw new Error("workflow meta.phases must contain only strings");
      }
    }
    this.expect("]");
    return values;
  }

  private parseString(): string {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'")
      throw new Error("workflow meta values must be static strings");
    this.index++;
    let value = "";
    while (this.index < this.source.length) {
      const char = this.source[this.index++]!;
      if (char === quote) return value;
      if (char !== "\\") {
        if (char === "\n" || char === "\r")
          throw new Error("workflow meta strings may not contain raw newlines");
        value += char;
        continue;
      }
      const escaped = this.source[this.index++];
      if (escaped === undefined) break;
      const simple: Record<string, string> = {
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\v",
        "0": "\0",
        "\\": "\\",
        '"': '"',
        "'": "'",
      };
      if (escaped in simple) value += simple[escaped];
      else if (escaped === "u" || escaped === "x") {
        const digits = escaped === "u" ? 4 : 2;
        const hex = this.source.slice(this.index, this.index + digits);
        if (!new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex))
          throw new Error("invalid escape in workflow meta string");
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        this.index += digits;
      } else {
        value += escaped;
      }
    }
    throw new Error("workflow meta string is not closed");
  }

  private skipTrivia(): void {
    while (this.index < this.source.length) {
      const rest = this.source.slice(this.index);
      const whitespace = rest.match(/^\s+/);
      if (whitespace) {
        this.index += whitespace[0].length;
        continue;
      }
      const lineComment = rest.match(/^\/\/[^\n]*(?:\n|$)/);
      if (lineComment) {
        this.index += lineComment[0].length;
        continue;
      }
      const blockComment = rest.match(/^\/\*[\s\S]*?\*\//);
      if (blockComment) {
        this.index += blockComment[0].length;
        continue;
      }
      break;
    }
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }

  private expect(value: string): void {
    if (!this.source.startsWith(value, this.index))
      throw new Error(`expected '${value}' in workflow meta`);
    this.index += value.length;
  }
}

/**
 * workflow scripts are approved trusted code. the vm context limits accidental capability
 * access, but node:vm is NOT a security boundary and must not be used for hostile scripts.
 */
export function parseWorkflowSource(
  source: string,
  _filename = "workflow.js",
): Omit<WorkflowSource, "source" | "path" | "projectLocal"> {
  if (!source.startsWith(META_PREFIX))
    throw new Error(`workflow must begin with literal ${META_PREFIX}{ ... }`);
  const parsedMeta = new MetaParser(source, META_PREFIX.length).parse();
  const meta = parsedMeta.meta;
  const rest = source.slice(parsedMeta.end);
  const match = rest.match(/^\s*;?\s*/);
  const body = rest.slice(match?.[0].length ?? 0);
  return {
    body,
    meta,
    hash: createHash("sha256").update(source).digest("hex"),
  };
}

export function validateWorkflowName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))
    throw new Error("workflow name may contain only letters, numbers, _ and -");
  return name;
}

function isWithin(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

export async function resolveWorkflowSource(
  input: { scriptPath?: string; script?: string; name?: string },
  cwd: string,
  projectTrusted: boolean,
): Promise<WorkflowSource> {
  let path: string | undefined;
  let source: string;
  let projectLocal = false;
  let sourceLabel = "inline";

  if (input.scriptPath) {
    path = resolve(cwd, input.scriptPath.replace(/^@/, ""));
    const globalRoot = join(getAgentDir(), "workflows");
    projectLocal = !isWithin(path, globalRoot);
    if (projectLocal && !projectTrusted)
      throw new Error("non-global workflow scripts require a trusted project");
    source = await readFile(path, "utf8");
    sourceLabel = path;
  } else if (input.script !== undefined) {
    source = input.script;
  } else if (input.name) {
    const name = validateWorkflowName(input.name);
    const projectPath = join(cwd, CONFIG_DIR_NAME, "workflows", `${name}.js`);
    const globalPath = join(getAgentDir(), "workflows", `${name}.js`);
    try {
      await access(projectPath);
      if (!projectTrusted)
        throw new Error("project workflow scripts require a trusted project");
      source = await readFile(projectPath, "utf8");
      path = projectPath;
      projectLocal = true;
      sourceLabel = projectPath;
    } catch (error) {
      if (error instanceof Error && error.message.includes("trusted project"))
        throw error;
      if (
        !error ||
        typeof error !== "object" ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
      source = await readFile(globalPath, "utf8");
      path = globalPath;
      sourceLabel = globalPath;
    }
  } else {
    throw new Error("provide scriptPath, script, or name");
  }

  const parsed = parseWorkflowSource(source, path ?? "inline-workflow.js");
  return { ...parsed, source: sourceLabel, text: source, path, projectLocal };
}

export async function listWorkflowFiles(cwd: string): Promise<string[]> {
  const roots = [
    join(cwd, CONFIG_DIR_NAME, "workflows"),
    join(getAgentDir(), "workflows"),
  ];
  const names = new Set<string>();
  for (const root of roots) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".js"))
          names.add(basename(entry.name, ".js"));
      }
    } catch {
      // An absent workflow directory is an empty source.
    }
  }
  return [...names].sort();
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it } = import.meta.vitest;
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dirs: string[] = [];
  afterEach(async () =>
    Promise.all(
      dirs
        .splice(0)
        .map(async (dir) => rm(dir, { recursive: true, force: true })),
    ),
  );

  describe("workflow source", () => {
    it("parses literal metadata and leaves a top-level-return body", () => {
      const parsed = parseWorkflowSource(
        'export const meta = { name: "fanout", description: "does work", phases: ["a"] };\nreturn args;',
      );
      expect(parsed.meta).toEqual({
        name: "fanout",
        description: "does work",
        phases: ["a"],
      });
      expect(parsed.body).toBe("return args;");
    });

    it("bounds declared phases for complete inline draft rendering", () => {
      const tooMany = Array.from(
        { length: MAX_DECLARED_PHASES + 1 },
        (_, index) => `phase-${index}`,
      );
      expect(() =>
        parseWorkflowSource(
          `export const meta = { name: "x", description: "x", phases: ${JSON.stringify(tooMany)} }; return 1`,
        ),
      ).toThrow("at most 64 entries");
      expect(() =>
        parseWorkflowSource(
          `export const meta = { name: "x", description: "x", phases: [${JSON.stringify("🫠".repeat(65))}] }; return 1`,
        ),
      ).toThrow("at most 256 UTF-8 bytes");
    });

    it("rejects non-literal prefixes, active metadata, and traversal names", () => {
      expect(() =>
        parseWorkflowSource('const meta = { name: "x" }; return 1'),
      ).toThrow("begin with literal");
      expect(() =>
        parseWorkflowSource(
          'export const meta = { get name() { while (true) {} }, description: "x" }; return 1',
        ),
      ).toThrow("unknown workflow meta field");
      expect(() => validateWorkflowName("../secret")).toThrow("workflow name");
    });

    it("lists global workflows from the configured agent directory", async () => {
      const agentDir = await mkdtemp(join(tmpdir(), "workflow-agent-dir-"));
      const cwd = await mkdtemp(join(tmpdir(), "workflow-list-cwd-"));
      dirs.push(agentDir, cwd);
      await mkdir(join(agentDir, "workflows"), { recursive: true });
      await writeFile(join(agentDir, "workflows", "global-demo.js"), "");
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        expect(await listWorkflowFiles(cwd)).toContain("global-demo");
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
      }
    });

    it("prefers project names and requires trust", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "workflow-source-"));
      dirs.push(cwd);
      const root = join(cwd, CONFIG_DIR_NAME, "workflows");
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "demo.js"),
        'export const meta = { name: "demo", description: "project" }; return 1',
      );
      await expect(
        resolveWorkflowSource({ name: "demo" }, cwd, false),
      ).rejects.toThrow("trusted project");
      expect(
        (await resolveWorkflowSource({ name: "demo" }, cwd, true)).meta
          .description,
      ).toBe("project");
    });

    it("honors scriptPath precedence and gates arbitrary paths on project trust", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "workflow-precedence-"));
      const outside = await mkdtemp(join(tmpdir(), "workflow-outside-"));
      dirs.push(cwd, outside);
      const file = join(outside, "chosen.js");
      await writeFile(
        file,
        'export const meta = { name: "path", description: "path" }; return 1',
      );
      await expect(
        resolveWorkflowSource({ scriptPath: file }, cwd, false),
      ).rejects.toThrow("trusted project");
      const resolved = await resolveWorkflowSource(
        {
          scriptPath: file,
          script:
            'export const meta = { name: "inline", description: "inline" }; return 2',
        },
        cwd,
        true,
      );
      expect(resolved.meta.name).toBe("path");
    });
  });
}
