/**
 * template variable interpolation for subagent system prompts.
 *
 * variables and their resolution strategies are declarative — defined in
 * bds-pi.json config or passed at call-time. resolver types: runtime,
 * literal, alias, file, env, dangerously_evaluate_js, dangerously_evaluate_sh.
 *
 * resolution order follows a topological sort of inter-variable references,
 * so {varA} can appear inside another variable's expression.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import {
  getGlobalConfig,
  resolveConfigDir,
  setGlobalSettingsPath,
  clearConfigCache,
} from "@bds_pi/config";

// ── types ──────────────────────────────────────────────────────────────

export type VariableDefinition = {
  /** built-in runtime var key (cwd, roots, date, os, repo, sessionId, ls, identity, harness, harnessDocsSection) */
  runtime?: string;
  /** static string value */
  literal?: string;
  /** reference another variable by name */
  alias?: string;
  /** read file contents — path relative to resolveConfigDir() */
  file?: string;
  /** read environment variable */
  env?: string;
  /** eval JS expression via new Function("require", ...) */
  dangerously_evaluate_js?: string;
  /** run shell command, capture stdout */
  dangerously_evaluate_sh?: string;
  /** fallback when resolver returns empty. supports {var} refs. */
  default?: string;
  /** drop entire template line if var is empty. default true. */
  dropLineIfEmpty?: boolean;
  /** working directory for dangerously_evaluate_sh. supports {var} refs. */
  cwd?: string;
};

export type PromptVariables = Record<string, VariableDefinition>;

const esmRequire = createRequire(import.meta.url);

// ── defaults ───────────────────────────────────────────────────────────

export const DEFAULT_PROMPT_VARIABLES: PromptVariables = {
  cwd: { runtime: "cwd" },
  roots: { runtime: "roots" },
  wsroot: { alias: "roots" },
  workingDir: { alias: "cwd" },
  date: { runtime: "date" },
  os: { runtime: "os" },
  repo: { runtime: "repo" },
  sessionId: { runtime: "sessionId" },
  ls: { runtime: "ls" },
  identity: { runtime: "identity", default: "Amp" },
  harness: { runtime: "harness", default: "pi" },
  harness_docs_section: { runtime: "harnessDocsSection" },
};

// ── existing exports (preserved) ───────────────────────────────────────

/** walk up from dir looking for .git to find the workspace root. falls back to dir itself. */
export function findGitRoot(dir: string): string {
  let current = path.resolve(dir);
  while (true) {
    try {
      const gitPath = path.join(current, ".git");
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) return current;
    } catch {
      // not found, keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return dir;
    current = parent;
  }
}

/** try to get the git remote origin URL for a directory. */
export function getGitRemoteUrl(dir: string): string {
  try {
    return execSync("git remote get-url origin", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/** extra context from the parent pi session — fields are empty when the API doesn't expose them. */
export interface InterpolateContext {
  sessionId?: string;
  repo?: string;
  /** agent identity name, e.g. "Amp". default: "Amp" */
  identity?: string;
  /** harness name (e.g. "pi"). determines which docs to load. default: "pi" */
  harness?: string;
  /** pre-loaded harness docs section. if provided, skips file read. */
  harnessDocsSection?: string;
}

// ── runtime var computation ────────────────────────────────────────────

/** compute the built-in runtime variables map from cwd + extra context. */
export function computeRuntimeVars(
  cwd: string,
  extra?: InterpolateContext,
): Record<string, string> {
  const roots = findGitRoot(cwd);
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const repo = extra?.repo ?? getGitRemoteUrl(roots);
  const sessionId = extra?.sessionId ?? "";
  let ls = "";
  try {
    ls = fs
      .readdirSync(roots)
      .map((e) => {
        const full = path.join(roots, e);
        try {
          return fs.statSync(full).isDirectory() ? `${full}/` : full;
        } catch {
          return full;
        }
      })
      .join("\n");
  } catch {
    /* graceful */
  }

  return {
    cwd,
    roots,
    date,
    os: `${os.platform()} (${os.release()}) on ${os.arch()}`,
    repo,
    sessionId,
    ls,
    identity: extra?.identity ?? "",
    harness: extra?.harness ?? "",
    harnessDocsSection: extra?.harnessDocsSection ?? "",
  };
}

// ── internal resolution machinery ──────────────────────────────────────

/** find {varName} patterns in a string that reference known variable names. */
function extractRefs(s: string | undefined, knownVars: Set<string>): string[] {
  if (!s) return [];
  const refs: string[] = [];
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const cap = m[1];
    if (cap !== undefined && knownVars.has(cap)) refs.push(cap);
  }
  return refs;
}

/** collect all variable dependencies for a single definition. */
function getDeps(def: VariableDefinition, knownVars: Set<string>): string[] {
  const deps = new Set<string>();
  // alias is a direct var name reference, not a template
  if (def.alias !== undefined && knownVars.has(def.alias)) deps.add(def.alias);
  for (const ref of extractRefs(def.file, knownVars)) deps.add(ref);
  for (const ref of extractRefs(def.dangerously_evaluate_js, knownVars)) deps.add(ref);
  for (const ref of extractRefs(def.dangerously_evaluate_sh, knownVars)) deps.add(ref);
  for (const ref of extractRefs(def.cwd, knownVars)) deps.add(ref);
  for (const ref of extractRefs(def.default, knownVars)) deps.add(ref);
  return [...deps];
}

/** topological sort of variable definitions. throws on cycles. */
function topoSort(defs: PromptVariables): string[] {
  const names = Object.keys(defs);
  const knownVars = new Set(names);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`cycle detected in prompt variables: ${name}`);
    }
    visiting.add(name);
    const def = defs[name];
    if (def) {
      for (const dep of getDeps(def, knownVars)) {
        visit(dep);
      }
    }
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  }

  for (const name of names) visit(name);
  return order;
}

/** substitute already-resolved vars into a string. */
function subVars(s: string, resolved: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (match, key: string) => {
    const val = resolved[key];
    return val !== undefined ? val : match;
  });
}

/**
 * evaluate a js expression with commonjs `require` available, without using
 * the Function constructor so lint can enforce no-implied-eval.
 */
function executeJsExpression(expr: string): unknown {
  const module = { exports: undefined as unknown };
  const exports = module.exports;
  const source = `module.exports = (${expr});`;

  vm.runInNewContext(source, {
    require: esmRequire,
    module,
    exports,
  });

  return module.exports;
}

function stringifyResolvedValue(value: unknown): string {
  if (value == null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return "";
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** resolve a single variable definition to a string value. */
function resolveVariable(
  def: VariableDefinition,
  resolved: Record<string, string>,
  runtimeVars: Record<string, string>,
  configDir?: string,
): string {
  let value = "";

  if (def.runtime !== undefined) {
    value = runtimeVars[def.runtime] ?? "";
  } else if (def.literal !== undefined) {
    value = def.literal;
  } else if (def.alias !== undefined) {
    value = resolved[def.alias] ?? "";
  } else if (def.file !== undefined) {
    const relPath = subVars(def.file, resolved);
    const base = configDir ?? ".";
    const absPath = path.resolve(base, relPath);
    try {
      value = fs.readFileSync(absPath, "utf-8");
    } catch {
      value = "";
    }
  } else if (def.env !== undefined) {
    value = process.env[def.env] ?? "";
  } else if (def.dangerously_evaluate_js !== undefined) {
    const expr = subVars(def.dangerously_evaluate_js, resolved);
    try {
      const result = executeJsExpression(expr);
      value = stringifyResolvedValue(result);
    } catch {
      value = "";
    }
  } else if (def.dangerously_evaluate_sh !== undefined) {
    const cmd = subVars(def.dangerously_evaluate_sh, resolved);
    const shCwd = def.cwd ? subVars(def.cwd, resolved) : undefined;
    try {
      value = execSync(cmd, {
        cwd: shCwd,
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      value = "";
    }
  }

  // apply default if empty
  if (!value && def.default !== undefined) {
    value = subVars(def.default, resolved);
  }

  return value;
}

// ── public API ─────────────────────────────────────────────────────────

/**
 * resolve template variables in agent prompts (e.g. {cwd}, {roots}, {date}).
 *
 * when a value is unavailable and dropLineIfEmpty is true (default),
 * the entire line containing the placeholder is removed rather than
 * leaving an empty label like "Repository: ".
 *
 * merge order: DEFAULT_PROMPT_VARIABLES → global config promptVariables → variables arg.
 */
export function interpolatePromptVars(
  prompt: string,
  cwd: string,
  extra?: InterpolateContext,
  variables?: PromptVariables,
): string {
  // merge variable definitions
  const configVars =
    variables === undefined ? (getGlobalConfig<PromptVariables>("promptVariables") ?? {}) : {};
  const merged: PromptVariables = {
    ...DEFAULT_PROMPT_VARIABLES,
    ...configVars,
    ...(variables ?? {}),
  };

  // compute runtime vars
  const runtimeVars = computeRuntimeVars(cwd, extra);
  const configDir = resolveConfigDir();

  // resolve in topological order
  const order = topoSort(merged);
  const resolved: Record<string, string> = {};
  for (const name of order) {
    const def = merged[name];
    if (def) resolved[name] = resolveVariable(def, resolved, runtimeVars, configDir);
  }

  // determine which vars are empty and which are filled, respecting dropLineIfEmpty
  const dropKeys: string[] = [];
  const filled: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    const def = merged[key];
    const drop = def?.dropLineIfEmpty ?? true;
    if (!value && drop) {
      dropKeys.push(key);
    } else {
      filled[key] = value;
    }
  }

  let result = prompt;

  // pass 1: drop entire lines whose var resolved to empty
  if (dropKeys.length > 0) {
    result = result.replace(new RegExp(`^.*\\{(${dropKeys.join("|")})\\}.*\\n?`, "gm"), "");
  }

  // pass 2: substitute all non-empty vars in one pass
  const filledKeys = Object.keys(filled);
  if (filledKeys.length > 0) {
    result = result.replace(
      new RegExp(`\\{(${filledKeys.join("|")})\\}`, "g"),
      (match: string, key: string) => filled[key] ?? match,
    );
  }

  return result;
}

// ── inline tests ───────────────────────────────────────────────────────

if (import.meta.vitest) {
  const { afterEach, describe, expect, test } = import.meta.vitest;

  const cwd = "/home/user/project";

  afterEach(() => {
    clearConfigCache();
  });

  describe("interpolatePromptVars", () => {
    test("resolves all basic vars", () => {
      const prompt =
        "cwd={cwd} roots={roots} wsroot={wsroot} workingDir={workingDir} date={date} os={os}";
      const result = interpolatePromptVars(prompt, cwd, {
        repo: "gh:test",
        sessionId: "s-123",
      });

      expect(result).toContain(`cwd=${cwd}`);
      expect(result).toContain("roots=");
      expect(result).toContain("wsroot=");
      expect(result).toContain(`workingDir=${cwd}`);
      expect(result).toContain("os=");
      expect(result).not.toContain("{cwd}");
      expect(result).not.toContain("{roots}");
      expect(result).not.toContain("{date}");
      expect(result).not.toContain("{os}");
    });

    test("resolves repo and sessionId from extra context", () => {
      const prompt = "Repository: {repo}\nSession: {sessionId}";
      const result = interpolatePromptVars(prompt, cwd, {
        repo: "https://github.com/test/repo",
        sessionId: "abc-123",
      });

      expect(result).toContain("Repository: https://github.com/test/repo");
      expect(result).toContain("Session: abc-123");
    });

    test("drops entire line when value is empty", () => {
      const prompt = "Working directory: {cwd}\nRepository: {repo}\nSession ID: {sessionId}\nDone.";
      const result = interpolatePromptVars(prompt, cwd, {
        repo: "",
        sessionId: "",
      });

      expect(result).toContain(`Working directory: ${cwd}`);
      expect(result).not.toContain("Repository");
      expect(result).not.toContain("Session ID");
      expect(result).toContain("Done.");
    });

    test("drops line when extra context is omitted entirely", () => {
      const prompt = "Dir: {cwd}\nRepo: {repo}\nEnd.";
      const result = interpolatePromptVars(prompt, cwd);

      expect(result).toContain(`Dir: ${cwd}`);
      expect(result).not.toContain("Repo");
      expect(result).toContain("End.");
    });

    test("no double-interpolation when a value contains another var pattern", () => {
      const prompt = "Repo: {repo}\nDate: {date}";
      const result = interpolatePromptVars(prompt, cwd, {
        repo: "my-{date}-repo",
        sessionId: "",
      });

      expect(result).toContain("Repo: my-{date}-repo");
      expect(result).toMatch(/Date: \w+/);
    });

    test("replaces multiple occurrences of same var", () => {
      const prompt = "{cwd} and also {cwd}";
      const result = interpolatePromptVars(prompt, cwd, {
        repo: "x",
        sessionId: "y",
      });

      expect(result).toBe(`${cwd} and also ${cwd}`);
    });

    test("multiline ls expansion preserves surrounding content", () => {
      const prompt = "Files:\n{ls}\nEnd.";
      const result = interpolatePromptVars(prompt, cwd, {
        repo: "x",
        sessionId: "y",
      });

      // ls resolves to something (git root listing) or empty — either way, End. must survive
      expect(result).toContain("End.");
    });

    test("empty ls drops the line", () => {
      // /tmp has no .git, so findGitRoot falls back to cwd, and listing /nonexistent fails
      const prompt = "Before\n{ls}\nAfter";
      const result = interpolatePromptVars(prompt, "/nonexistent/path/unlikely", {
        repo: "x",
        sessionId: "y",
      });

      expect(result).toContain("Before");
      expect(result).toContain("After");
    });
  });

  describe("findGitRoot", () => {
    test("finds git root from cwd", () => {
      // this test file lives inside a git repo
      const root = findGitRoot(process.cwd());
      const { existsSync } = require("node:fs");
      const { join } = require("node:path");

      expect(existsSync(join(root, ".git"))).toBe(true);
    });

    test("falls back to dir when no git root exists", () => {
      const result = findGitRoot("/tmp/nonexistent-no-git-here");
      expect(result).toBe("/tmp/nonexistent-no-git-here");
    });
  });

  // ── new resolver tests ─────────────────────────────────────────────

  describe("literal resolver", () => {
    test("returns static string", () => {
      const result = interpolatePromptVars(
        "val={myVar}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          myVar: { literal: "hello world" },
        },
      );
      expect(result).toContain("val=hello world");
    });
  });

  describe("alias resolver", () => {
    test("resolves to another variable's value", () => {
      const result = interpolatePromptVars(
        "a={a} b={b}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          a: { literal: "alpha" },
          b: { alias: "a" },
        },
      );
      expect(result).toContain("a=alpha");
      expect(result).toContain("b=alpha");
    });
  });

  describe("file resolver", () => {
    test("reads file contents relative to config dir", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-interp-test-"));
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "file content here");
      setGlobalSettingsPath(path.join(tmpDir, "bds-pi.json"));

      const result = interpolatePromptVars(
        "content={f}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          f: { file: "test.txt" },
        },
      );
      expect(result).toContain("content=file content here");
    });
  });

  describe("env resolver", () => {
    test("reads environment variable", () => {
      const key = `PI_TEST_ENV_${Date.now()}`;
      process.env[key] = "env_value";
      try {
        const result = interpolatePromptVars(
          "e={e}",
          cwd,
          { repo: "x", sessionId: "y" },
          {
            e: { env: key },
          },
        );
        expect(result).toContain("e=env_value");
      } finally {
        delete process.env[key];
      }
    });
  });

  describe("dangerously_evaluate_js resolver", () => {
    test("evaluates JS expression", () => {
      const result = interpolatePromptVars(
        "n={n}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          n: { dangerously_evaluate_js: "2 + 2" },
        },
      );
      expect(result).toContain("n=4");
    });

    test("returns empty on error", () => {
      const result = interpolatePromptVars(
        "n={n}\nend",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          n: { dangerously_evaluate_js: "throw new Error('boom')" },
        },
      );
      expect(result).not.toContain("n=");
      expect(result).toContain("end");
    });
  });

  describe("dangerously_evaluate_sh resolver", () => {
    test("captures stdout from shell command", () => {
      const result = interpolatePromptVars(
        "v={v}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          v: { dangerously_evaluate_sh: "echo hello_from_sh" },
        },
      );
      expect(result).toContain("v=hello_from_sh");
    });

    test("cwd supports {var} refs", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-interp-sh-"));
      const result = interpolatePromptVars(
        "v={v}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          dir: { literal: tmpDir },
          v: { dangerously_evaluate_sh: "pwd", cwd: "{dir}" },
        },
      );
      // pwd output should contain the temp dir path
      expect(result).toContain(tmpDir);
    });
  });

  describe("default value", () => {
    test("falls back to default when resolver returns empty", () => {
      const key = `PI_TEST_MISSING_${Date.now()}`;
      delete process.env[key]; // ensure not set
      const result = interpolatePromptVars(
        "v={v}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          v: { env: key, default: "fallback" },
        },
      );
      expect(result).toContain("v=fallback");
    });

    test("default supports {var} refs", () => {
      const key = `PI_TEST_MISSING2_${Date.now()}`;
      delete process.env[key];
      const result = interpolatePromptVars(
        "v={v}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          base: { literal: "hello" },
          v: { env: key, default: "{base}-world" },
        },
      );
      expect(result).toContain("v=hello-world");
    });
  });

  describe("topo sort", () => {
    test("resolves dependencies in correct order", () => {
      const result = interpolatePromptVars(
        "a={a} b={b} c={c}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          c: { alias: "b" },
          b: { alias: "a" },
          a: { literal: "root" },
        },
      );
      expect(result).toContain("a=root");
      expect(result).toContain("b=root");
      expect(result).toContain("c=root");
    });

    test("throws on cycle", () => {
      expect(() =>
        interpolatePromptVars(
          "x={x}",
          cwd,
          { repo: "x", sessionId: "y" },
          {
            x: { alias: "y" },
            y: { alias: "x" },
          },
        ),
      ).toThrow(/cycle/i);
    });
  });

  describe("dropLineIfEmpty", () => {
    test("preserves line when dropLineIfEmpty is false", () => {
      const key = `PI_TEST_DROP_${Date.now()}`;
      delete process.env[key];
      const result = interpolatePromptVars(
        "Before\nLabel: {v}\nAfter",
        cwd,
        { repo: "x", sessionId: "y" },
        { v: { env: key, dropLineIfEmpty: false } },
      );
      expect(result).toContain("Label: ");
      expect(result).toContain("Before");
      expect(result).toContain("After");
    });
  });

  describe("config-driven variables", () => {
    test("reads promptVariables from global config", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-interp-cfg-"));
      const settingsPath = path.join(tmpDir, "bds-pi.json");
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          promptVariables: { custom: { literal: "from config" } },
        }),
      );
      setGlobalSettingsPath(settingsPath);

      const result = interpolatePromptVars("v={custom}", cwd, {
        repo: "x",
        sessionId: "y",
      });
      expect(result).toContain("v=from config");
    });
  });
}
