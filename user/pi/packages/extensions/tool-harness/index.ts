/**
 * tool-harness — env-gated tool filtering for pi extensions.
 *
 * pi's --tools/--no-tools flags only gate built-in tools. extension tools
 * registered via pi.registerTool() always load. this extension reads
 * PI_INCLUDE_TOOLS on session start and calls pi.setActiveTools() to
 * filter down to exactly the specified set — both built-in and extension.
 *
 * env var format: PI_INCLUDE_TOOLS=read,grep,find,bash
 * when unset, all tools remain active (no filtering).
 * when set to "NONE", all extension tools are disabled.
 *
 * designed for sub-agent spawning: the sub-agents extension passes
 * PI_INCLUDE_TOOLS in the child process env to control tool visibility.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * backward-compat alias map: old names -> registered names.
 */
const TOOL_ALIASES: Record<string, string> = {
  glob: "find",
  edit_file: "edit",
  create_file: "write",
};

export function resolveAliases(names: string[]): string[] {
  return names.map((name) => TOOL_ALIASES[name] ?? name);
}

export const TOOL_ALIASES_EXPORT = TOOL_ALIASES;

export default function (pi: ExtensionAPI): void {
  const raw = process.env.PI_INCLUDE_TOOLS;
  if (!raw) return;

  // explicit "no extension tools" sentinel
  if (raw === "NONE") {
    const applyEmpty = () => pi.setActiveTools([]);
    pi.on("session_start", async () => {
      applyEmpty();
    });
    pi.on("before_agent_start", async () => {
      applyEmpty();
    });
    return;
  }

  const allowed = resolveAliases(
    raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );

  if (allowed.length === 0) return;

  const applyFilter = () => pi.setActiveTools(allowed);

  pi.on("session_start", async () => {
    applyFilter();
  });

  // sub-agents/index.ts re-registers the subagent tool on before_agent_start
  // to pick up project-scoped agents. re-registration may bypass a prior
  // setActiveTools() call, so we re-apply the filter on the same event.
  pi.on("before_agent_start", async () => {
    applyFilter();
  });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("resolveAliases", () => {
    it("returns names unchanged when no aliases match", () => {
      expect(resolveAliases(["read", "grep", "bash"])).toEqual(["read", "grep", "bash"]);
    });

    it("resolves glob -> find", () => {
      expect(resolveAliases(["glob", "read"])).toEqual(["find", "read"]);
    });

    it("resolves edit_file -> edit", () => {
      expect(resolveAliases(["edit_file"])).toEqual(["edit"]);
    });

    it("resolves create_file -> write", () => {
      expect(resolveAliases(["create_file"])).toEqual(["write"]);
    });

    it("resolves multiple aliases in one call", () => {
      expect(resolveAliases(["glob", "edit_file", "create_file", "bash"])).toEqual([
        "find",
        "edit",
        "write",
        "bash",
      ]);
    });

    it("returns empty array unchanged", () => {
      expect(resolveAliases([])).toEqual([]);
    });
  });
}
