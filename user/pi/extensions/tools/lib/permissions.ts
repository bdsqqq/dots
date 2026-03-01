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
