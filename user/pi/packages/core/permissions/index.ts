/**
 * permission evaluation for tool calls.
 *
 * reads rules from ~/.pi/agent/permissions.json (separate from
 * settings.json since this is extension-owned config). rules are
 * evaluated first-match-wins, matching tool name and params via
 * glob patterns. default action when no rule matches: allow.
 *
 * format mirrors amp's amp.permissions schema:
 *   { tool, matches?, action, message? }
 *
 * only "allow" and "reject" actions for now — no "ask" or "delegate"
 * because pi's tool execute API has no confirmation mechanism.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandPath, isPathWithin, resolveToAbsolute } from "@bds_pi/fs";

// --- types ---

type PermissionPattern = string | string[];

export interface PermissionRule {
  tool: string;
  matches?: {
    cmd?: PermissionPattern;
    cwd?: PermissionPattern;
    path?: PermissionPattern;
    within?: PermissionPattern;
  };
  action: "allow" | "reject";
  message?: string;
}

export interface PermissionParams {
  cmd?: string;
  cwd?: string;
  path?: string;
  paths?: string[];
  sessionCwd?: string;
}

export interface PermissionVerdict {
  action: "allow" | "reject";
  message?: string;
}

// --- glob matching ---

/**
 * convert a simple glob pattern (only `*` wildcards) to a regex.
 * covers all patterns amp documents: `*git push*`, `rm *`, `*`.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${withWildcards}$`, "i");
}

function toPatterns(patterns: PermissionPattern): string[] {
  return Array.isArray(patterns) ? patterns : [patterns];
}

function matchesGlob(value: string, patterns: PermissionPattern): boolean {
  return toPatterns(patterns).some((pattern) => globToRegex(pattern).test(value));
}

function collectObservedPaths(params: PermissionParams): string[] {
  return [params.path, ...(params.paths ?? [])].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function collectWithinPaths(params: PermissionParams): string[] {
  const observedPaths = collectObservedPaths(params);

  if (typeof params.cwd === "string" && params.cwd.length > 0) {
    observedPaths.push(params.cwd);
  }

  return observedPaths;
}

function resolvePathLike(
  value: string,
  sessionCwd: string | undefined,
): string | null {
  if (sessionCwd) return resolveToAbsolute(value, sessionCwd);

  const expanded = expandPath(value);
  return path.isAbsolute(expanded) ? expanded : null;
}

function matchesWithin(params: PermissionParams, roots: PermissionPattern): boolean {
  const observedPaths = collectWithinPaths(params);
  if (observedPaths.length === 0) return false;

  const resolvedRoots = toPatterns(roots)
    .map((root) => resolvePathLike(root, params.sessionCwd))
    .filter((root): root is string => root !== null);
  if (resolvedRoots.length === 0) return false;

  return observedPaths.every((observedPath) => {
    const resolvedTarget = resolvePathLike(observedPath, params.sessionCwd);
    if (!resolvedTarget) return false;
    return resolvedRoots.some((root) => isPathWithin(root, resolvedTarget));
  });
}

// --- evaluation ---

export function evaluatePermission(
  toolName: string,
  params: PermissionParams,
  rules: PermissionRule[],
): PermissionVerdict {
  for (const rule of rules) {
    if (!globToRegex(rule.tool).test(toolName)) continue;

    if (rule.matches?.cmd && !matchesGlob(params.cmd ?? "", rule.matches.cmd)) {
      continue;
    }

    if (rule.matches?.cwd) {
      if (!params.cwd || !matchesGlob(params.cwd, rule.matches.cwd)) continue;
    }

    if (rule.matches?.path) {
      const observedPaths = collectObservedPaths(params);
      if (
        observedPaths.length === 0 ||
        !observedPaths.some((observedPath) =>
          matchesGlob(observedPath, rule.matches!.path!),
        )
      ) {
        continue;
      }
    }

    if (rule.matches?.within && !matchesWithin(params, rule.matches.within)) {
      continue;
    }

    return { action: rule.action, message: rule.message };
  }

  return { action: "allow" };
}

// --- loading ---

const PERMISSIONS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "permissions.json",
);

export function loadPermissions(): PermissionRule[] {
  try {
    const raw = fs.readFileSync(PERMISSIONS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

// --- tests ---

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  const RULES: PermissionRule[] = [
    {
      tool: "Bash",
      matches: { cmd: ["*git add -A*", "*git add .*"] },
      action: "reject",
      message:
        "stage files explicitly with 'git add <file>' — unstaged changes may not be yours",
    },
    {
      tool: "Bash",
      matches: {
        cmd: ["*git push --force*", "*git push -f*", "*--force-with-lease*"],
      },
      action: "reject",
      message:
        "never force push. if diverged: 'git fetch origin && git rebase origin/main && git push'",
    },
    {
      tool: "Bash",
      matches: { cmd: ["rm *", "* && rm *", "* || rm *", "* ; rm *"] },
      action: "reject",
      message: "use 'trash <file>' instead of rm — recoverable deletion",
    },
    { tool: "*", action: "allow" },
  ];

  describe("evaluatePermission", () => {
    it("allows normal commands", () => {
      expect(evaluatePermission("Bash", { cmd: "git status" }, RULES)).toEqual({
        action: "allow",
      });
      expect(evaluatePermission("Bash", { cmd: "ls -la" }, RULES)).toEqual({
        action: "allow",
      });
      expect(
        evaluatePermission("Bash", { cmd: "nix build .#foo" }, RULES),
      ).toEqual({ action: "allow" });
    });

    it("rejects git add -A", () => {
      const v = evaluatePermission("Bash", { cmd: "git add -A" }, RULES);
      expect(v.action).toBe("reject");
      expect(v.message).toContain("stage files explicitly");
    });

    it("rejects git add .", () => {
      const v = evaluatePermission("Bash", { cmd: "git add ." }, RULES);
      expect(v.action).toBe("reject");
    });

    it("allows explicit git add", () => {
      const v = evaluatePermission(
        "Bash",
        { cmd: "git add src/foo.ts" },
        RULES,
      );
      expect(v.action).toBe("allow");
    });

    it("rejects force push variants", () => {
      expect(
        evaluatePermission("Bash", { cmd: "git push --force" }, RULES).action,
      ).toBe("reject");
      expect(
        evaluatePermission("Bash", { cmd: "git push -f origin main" }, RULES)
          .action,
      ).toBe("reject");
      expect(
        evaluatePermission(
          "Bash",
          { cmd: "git push --force-with-lease" },
          RULES,
        ).action,
      ).toBe("reject");
    });

    it("allows normal git push", () => {
      expect(
        evaluatePermission("Bash", { cmd: "git push" }, RULES).action,
      ).toBe("allow");
      expect(
        evaluatePermission("Bash", { cmd: "git push origin main" }, RULES)
          .action,
      ).toBe("allow");
    });

    it("rejects rm commands", () => {
      expect(
        evaluatePermission("Bash", { cmd: "rm foo.txt" }, RULES).action,
      ).toBe("reject");
      expect(
        evaluatePermission("Bash", { cmd: "rm -rf /tmp/junk" }, RULES).action,
      ).toBe("reject");
      expect(
        evaluatePermission("Bash", { cmd: "ls && rm foo" }, RULES).action,
      ).toBe("reject");
      expect(
        evaluatePermission("Bash", { cmd: "false || rm foo" }, RULES).action,
      ).toBe("reject");
      expect(
        evaluatePermission("Bash", { cmd: "echo hi ; rm foo" }, RULES).action,
      ).toBe("reject");
    });

    it("allows non-Bash tools via wildcard catch-all", () => {
      expect(evaluatePermission("Read", { cmd: "/etc/passwd" }, RULES)).toEqual(
        {
          action: "allow",
        },
      );
    });

    it("allows everything when no rules", () => {
      expect(evaluatePermission("Bash", { cmd: "rm -rf /" }, [])).toEqual({
        action: "allow",
      });
    });

    it("matches tool name with glob", () => {
      const rules: PermissionRule[] = [
        { tool: "mcp__*", action: "reject", message: "no mcp" },
        { tool: "*", action: "allow" },
      ];
      expect(
        evaluatePermission("mcp__playwright_click", {}, rules).action,
      ).toBe("reject");
      expect(evaluatePermission("Bash", { cmd: "ls" }, rules).action).toBe(
        "allow",
      );
    });

    it("matches cwd globs", () => {
      const rules: PermissionRule[] = [
        {
          tool: "Read",
          matches: { cwd: "/repo/*/docs" },
          action: "reject",
          message: "docs cwd",
        },
        { tool: "*", action: "allow" },
      ];

      expect(
        evaluatePermission("Read", { cwd: "/repo/app/docs" }, rules).action,
      ).toBe("reject");
      expect(
        evaluatePermission("Read", { cwd: "/repo/app/src" }, rules).action,
      ).toBe("allow");
    });

    it("matches path globs against path and paths", () => {
      const rules: PermissionRule[] = [
        {
          tool: "Edit",
          matches: { path: ["src/*.ts", "docs/*.md"] },
          action: "reject",
          message: "tracked path",
        },
        { tool: "*", action: "allow" },
      ];

      expect(
        evaluatePermission("Edit", { path: "src/index.ts" }, rules).action,
      ).toBe("reject");
      expect(
        evaluatePermission("Edit", { paths: ["docs/readme.md"] }, rules).action,
      ).toBe("reject");
      expect(
        evaluatePermission("Edit", { path: "assets/logo.svg" }, rules).action,
      ).toBe("allow");
    });

    it("matches within relative to session cwd", () => {
      const rules: PermissionRule[] = [
        {
          tool: "Write",
          matches: { within: "." },
          action: "reject",
          message: "workspace only",
        },
        { tool: "*", action: "allow" },
      ];

      expect(
        evaluatePermission(
          "Write",
          { path: "src/index.ts", sessionCwd: "/repo/project" },
          rules,
        ).action,
      ).toBe("reject");
      expect(
        evaluatePermission(
          "Write",
          { path: "/tmp/escape.ts", sessionCwd: "/repo/project" },
          rules,
        ).action,
      ).toBe("allow");
      expect(
        evaluatePermission(
          "Write",
          { path: "../sibling/escape.ts", sessionCwd: "/repo/project" },
          rules,
        ).action,
      ).toBe("allow");
    });

    it("checks within against all observed paths", () => {
      const rules: PermissionRule[] = [
        {
          tool: "Edit",
          matches: { within: "." },
          action: "reject",
          message: "workspace only",
        },
        { tool: "*", action: "allow" },
      ];

      expect(
        evaluatePermission(
          "Edit",
          {
            paths: ["src/index.ts", "docs/readme.md"],
            sessionCwd: "/repo/project",
          },
          rules,
        ).action,
      ).toBe("reject");
      expect(
        evaluatePermission(
          "Edit",
          {
            paths: ["src/index.ts", "../sibling/escape.ts"],
            sessionCwd: "/repo/project",
          },
          rules,
        ).action,
      ).toBe("allow");
    });

    it("normalizes within roots and observed paths like file tools", () => {
      const rules: PermissionRule[] = [
        {
          tool: "Read",
          matches: { within: "@docs" },
          action: "reject",
          message: "docs only",
        },
        { tool: "*", action: "allow" },
      ];

      expect(
        evaluatePermission(
          "Read",
          { path: "@docs/readme.md", sessionCwd: "/repo/project" },
          rules,
        ).action,
      ).toBe("reject");
      expect(
        evaluatePermission(
          "Read",
          { path: "~/notes/todo.md", sessionCwd: "/repo/project" },
          rules,
        ).action,
      ).toBe("allow");
    });

    it("checks within against bash cwd even without explicit path args", () => {
      const rules: PermissionRule[] = [
        {
          tool: "Bash",
          matches: { cmd: "printf ok", within: "." },
          action: "allow",
        },
        {
          tool: "Bash",
          matches: { cmd: "printf ok" },
          action: "reject",
          message: "workspace only",
        },
        { tool: "*", action: "allow" },
      ];

      expect(
        evaluatePermission(
          "Bash",
          {
            cmd: "printf ok",
            cwd: "/repo/project",
            sessionCwd: "/repo/project",
          },
          rules,
        ).action,
      ).toBe("allow");
      expect(
        evaluatePermission(
          "Bash",
          {
            cmd: "printf ok",
            cwd: "/tmp",
            sessionCwd: "/repo/project",
          },
          rules,
        ),
      ).toEqual({ action: "reject", message: "workspace only" });
    });
  });
}
