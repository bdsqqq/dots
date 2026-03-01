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
      (_, key) => filled[key],
    );
  }

  return result;
}
