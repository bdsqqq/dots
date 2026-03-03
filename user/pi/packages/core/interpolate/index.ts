/**
 * template variable interpolation for subagent system prompts.
 *
 * extracted so tests can import without pulling in pi-agent-core / pi-coding-agent.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  /** harness name, e.g. "pi" or "amp". determines which docs to load. default: "pi" */
  harness?: string;
  /** pre-loaded harness docs section. if provided, skips file read. */
  harnessDocsSection?: string;
}

/**
 * resolve template variables in agent prompts (e.g. {cwd}, {roots}, {date}).
 *
 * when a value is unavailable, the entire line containing the placeholder
 * is removed rather than leaving an empty label like "Repository: ".
 */
export function interpolatePromptVars(
  prompt: string,
  cwd: string,
  extra?: InterpolateContext,
): string {
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

  const vars: Record<string, string> = {
    cwd,
    roots,
    wsroot: roots,
    workingDir: cwd,
    date,
    os: `${os.platform()} (${os.release()}) on ${os.arch()}`,
    repo,
    sessionId,
    ls,
    identity: extra?.identity || "Amp",
    harness: extra?.harness || "pi",
    harness_docs_section: extra?.harnessDocsSection || "",
  };

  const emptyKeys = Object.keys(vars).filter((k) => !vars[k]);
  const filled = Object.fromEntries(
    Object.entries(vars).filter(([, v]) => !!v),
  );

  let result = prompt;

  // pass 1: drop entire lines whose var resolved to empty
  if (emptyKeys.length > 0) {
    result = result.replace(
      new RegExp(`^.*\\{(${emptyKeys.join("|")})\\}.*\\n?`, "gm"),
      "",
    );
  }

  // pass 2: substitute all non-empty vars in one pass — order-independent
  const filledKeys = Object.keys(filled);
  if (filledKeys.length > 0) {
    result = result.replace(
      new RegExp(`\\{(${filledKeys.join("|")})\\}`, "g"),
      (match: string, key: string) => filled[key] ?? match,
    );
  }

  return result;
}

// inline tests
if (import.meta.vitest) {
  const { describe, expect, test } = import.meta.vitest;

  const cwd = "/home/user/project";

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
      const prompt =
        "Working directory: {cwd}\nRepository: {repo}\nSession ID: {sessionId}\nDone.";
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
}
