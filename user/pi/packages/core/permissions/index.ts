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

// --- types ---

export interface PermissionRule {
  tool: string;
  matches?: { cmd?: string | string[] };
  action: "allow" | "reject";
  message?: string;
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

// --- evaluation ---

export function evaluatePermission(
  toolName: string,
  params: { cmd?: string },
  rules: PermissionRule[],
): PermissionVerdict {
  for (const rule of rules) {
    if (!globToRegex(rule.tool).test(toolName)) continue;

    if (rule.matches?.cmd) {
      const patterns = Array.isArray(rule.matches.cmd)
        ? rule.matches.cmd
        : [rule.matches.cmd];
      if (!patterns.some((p) => globToRegex(p).test(params.cmd ?? "")))
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
  });
}
