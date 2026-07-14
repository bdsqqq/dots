import { access, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  compileWorkflowSource,
  type CompiledWorkflowMeta,
} from "./compiler.js";

export type { WorkflowMeta } from "./api.js";

const MAX_WORKFLOW_SOURCE_BYTES = 256 * 1024;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("workflow cancelled", "AbortError");
}

function validateSourceSize(source: string): void {
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_SOURCE_BYTES)
    throw new Error(
      `workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} UTF-8 bytes`,
    );
}

export interface WorkflowSource {
  source: string;
  text: string;
  code: string;
  meta: CompiledWorkflowMeta;
  hash: string;
  path?: string;
  projectLocal: boolean;
}

/**
 * workflow scripts are approved trusted code. compilation rejects capabilities outside
 * the workflow API, but the eventual node:vm execution is not a hostile-code boundary.
 */
export function parseWorkflowSource(
  source: string,
  filename = "inline-workflow.ts",
): Omit<WorkflowSource, "source" | "path" | "projectLocal"> {
  validateSourceSize(source);
  const compiled = compileWorkflowSource(source, filename);
  return {
    text: source,
    code: compiled.code,
    meta: compiled.meta,
    hash: compiled.hash,
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
  signal?: AbortSignal,
): Promise<WorkflowSource> {
  throwIfAborted(signal);
  let path: string | undefined;
  let source: string;
  let projectLocal = false;
  let sourceLabel = "inline";

  if (input.scriptPath) {
    path = resolve(cwd, input.scriptPath.replace(/^@/, ""));
    if (!path.endsWith(".ts"))
      throw new Error("workflow script paths must end in .ts");
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
    const projectPath = join(cwd, CONFIG_DIR_NAME, "workflows", `${name}.ts`);
    const globalPath = join(getAgentDir(), "workflows", `${name}.ts`);
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

  validateSourceSize(source);
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
  const parsed = parseWorkflowSource(source, path ?? "inline-workflow.ts");
  throwIfAborted(signal);
  return { ...parsed, source: sourceLabel, path, projectLocal };
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
        if (entry.isFile() && entry.name.endsWith(".ts"))
          names.add(basename(entry.name, ".ts"));
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
  const workflow = `
    import { defineWorkflow, finder } from "@bds_pi/workflow";
    export const meta = { name: "demo", description: "project", agents: ["finder"] } as const;
    export default defineWorkflow(meta, {
      run: ({ agent }) => agent(finder({ query: "x" })),
    });
  `;

  afterEach(async () =>
    Promise.all(
      dirs
        .splice(0)
        .map(async (dir) => rm(dir, { recursive: true, force: true })),
    ),
  );

  describe("workflow source", () => {
    it("bounds source compilation and honors pre-aborted requests", async () => {
      expect(() =>
        parseWorkflowSource(" ".repeat(MAX_WORKFLOW_SOURCE_BYTES + 1)),
      ).toThrow("source exceeds");
      const controller = new AbortController();
      controller.abort();
      await expect(
        resolveWorkflowSource(
          { script: workflow },
          process.cwd(),
          true,
          controller.signal,
        ),
      ).rejects.toThrow("workflow cancelled");
    });

    it("lists and resolves only TypeScript workflows", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "workflow-source-"));
      dirs.push(cwd);
      const root = join(cwd, CONFIG_DIR_NAME, "workflows");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "demo.ts"), workflow);
      await writeFile(join(root, "legacy.js"), workflow);

      expect(await listWorkflowFiles(cwd)).toContain("demo");
      expect(await listWorkflowFiles(cwd)).not.toContain("legacy");
      const resolved = await resolveWorkflowSource({ name: "demo" }, cwd, true);
      expect(resolved.text).toBe(workflow);
      expect(resolved.code).toContain('require("@bds_pi/workflow")');
      await expect(
        resolveWorkflowSource(
          { scriptPath: join(root, "legacy.js") },
          cwd,
          true,
        ),
      ).rejects.toThrow("must end in .ts");
    });
  });
}
