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

export const TOOL_ALIASES_EXPORT: typeof TOOL_ALIASES = TOOL_ALIASES as const;

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
  const { describe, expect, it, beforeEach, afterEach } = import.meta.vitest;
  const toolHarnessExt = (await import("./index.js")).default;

  describe("resolveAliases", () => {
    it("returns names unchanged when no aliases match", () => {
      expect(resolveAliases(["read", "grep", "bash"])).toEqual([
        "read",
        "grep",
        "bash",
      ]);
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
      expect(
        resolveAliases(["glob", "edit_file", "create_file", "bash"]),
      ).toEqual(["find", "edit", "write", "bash"]);
    });

    it("returns empty array unchanged", () => {
      expect(resolveAliases([])).toEqual([]);
    });
  });

  describe("tool-harness extension (SDK integration)", () => {
    const originalEnv = process.env.PI_INCLUDE_TOOLS;

    beforeEach(() => {
      delete process.env.PI_INCLUDE_TOOLS;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.PI_INCLUDE_TOOLS = originalEnv;
      } else {
        delete process.env.PI_INCLUDE_TOOLS;
      }
    });

    describe("env var not set", () => {
      it("does nothing when PI_INCLUDE_TOOLS is unset", () => {
        const calls: string[] = [];
        const mockPi = {
          setActiveTools: (tools: string[]) =>
            calls.push(`setActiveTools:${tools.join(",")}`),
          on: (event: string) => calls.push(`on:${event}`),
        } as any;

        toolHarnessExt(mockPi);

        expect(calls).toHaveLength(0);
      });
    });

    describe("PI_INCLUDE_TOOLS=NONE", () => {
      it("registers handlers that call setActiveTools with empty array", async () => {
        process.env.PI_INCLUDE_TOOLS = "NONE";

        const calls: { type: string; event?: string; tools?: string[] }[] = [];
        const handlers: Record<string, () => void> = {};

        const mockPi = {
          setActiveTools: (tools: string[]) =>
            calls.push({ type: "setActiveTools", tools }),
          on: (event: string, handler: () => void) => {
            calls.push({ type: "on", event });
            handlers[event] = handler;
          },
        } as any;

        toolHarnessExt(mockPi);

        // Verify both handlers are registered
        expect(
          calls
            .filter((c) => c.type === "on")
            .map((c) => c.event)
            .sort((a, b) => a!.localeCompare(b!)),
        ).toEqual(["before_agent_start", "session_start"]);

        // Simulate session_start event
        handlers["session_start"]!();
        expect(calls.filter((c) => c.type === "setActiveTools")).toEqual([
          { type: "setActiveTools", tools: [] },
        ]);

        // Simulate before_agent_start event
        handlers["before_agent_start"]!();
        expect(calls.filter((c) => c.type === "setActiveTools")).toHaveLength(
          2,
        );
      });
    });

    describe("PI_INCLUDE_TOOLS with tool list", () => {
      it("registers handlers that filter to specified tools", async () => {
        process.env.PI_INCLUDE_TOOLS = "read,grep,bash";

        const calls: { type: string; event?: string; tools?: string[] }[] = [];
        const handlers: Record<string, () => void> = {};

        const mockPi = {
          setActiveTools: (tools: string[]) =>
            calls.push({ type: "setActiveTools", tools }),
          on: (event: string, handler: () => void) => {
            calls.push({ type: "on", event });
            handlers[event] = handler;
          },
        } as any;

        toolHarnessExt(mockPi);

        // Verify handlers are registered
        expect(
          calls
            .filter((c) => c.type === "on")
            .map((c) => c.event)
            .sort((a, b) => a!.localeCompare(b!)),
        ).toEqual(["before_agent_start", "session_start"]);

        // Simulate session_start event
        handlers["session_start"]!();
        expect(calls.filter((c) => c.type === "setActiveTools")).toEqual([
          { type: "setActiveTools", tools: ["read", "grep", "bash"] },
        ]);
      });

      it("trims whitespace from tool names", async () => {
        process.env.PI_INCLUDE_TOOLS = "  read ,  grep  , bash  ";

        const calls: { tools?: string[] }[] = [];
        const handlers: Record<string, () => void> = {};

        const mockPi = {
          setActiveTools: (tools: string[]) => calls.push({ tools }),
          on: (_event: string, handler: () => void) => {
            handlers[_event] = handler;
          },
        } as any;

        toolHarnessExt(mockPi);

        handlers["session_start"]!();

        expect(calls[0]!.tools).toEqual(["read", "grep", "bash"]);
      });

      it("resolves aliases in tool names", async () => {
        process.env.PI_INCLUDE_TOOLS = "glob,edit_file,create_file";

        const calls: { tools?: string[] }[] = [];
        const handlers: Record<string, () => void> = {};

        const mockPi = {
          setActiveTools: (tools: string[]) => calls.push({ tools }),
          on: (_event: string, handler: () => void) => {
            handlers[_event] = handler;
          },
        } as any;

        toolHarnessExt(mockPi);

        handlers["session_start"]!();

        expect(calls[0]!.tools).toEqual(["find", "edit", "write"]);
      });

      it("handles mixed aliases and non-aliases", async () => {
        process.env.PI_INCLUDE_TOOLS = "glob,read,edit_file,bash";

        const calls: { tools?: string[] }[] = [];
        const handlers: Record<string, () => void> = {};

        const mockPi = {
          setActiveTools: (tools: string[]) => calls.push({ tools }),
          on: (_event: string, handler: () => void) => {
            handlers[_event] = handler;
          },
        } as any;

        toolHarnessExt(mockPi);

        handlers["session_start"]!();

        expect(calls[0]!.tools).toEqual(["find", "read", "edit", "bash"]);
      });
    });

    describe("edge cases", () => {
      it("does nothing when PI_INCLUDE_TOOLS is empty string after trim", () => {
        process.env.PI_INCLUDE_TOOLS = "   ,  ,  ";

        const calls: string[] = [];
        const mockPi = {
          setActiveTools: () => calls.push("setActiveTools"),
          on: () => calls.push("on"),
        } as any;

        toolHarnessExt(mockPi);

        expect(calls).toHaveLength(0);
      });

      it("does nothing for single comma", () => {
        process.env.PI_INCLUDE_TOOLS = ",";

        const calls: string[] = [];
        const mockPi = {
          setActiveTools: () => calls.push("setActiveTools"),
          on: () => calls.push("on"),
        } as any;

        toolHarnessExt(mockPi);

        expect(calls).toHaveLength(0);
      });
    });

    describe("re-application on before_agent_start", () => {
      it("re-applies filter on before_agent_start to handle re-registration", async () => {
        process.env.PI_INCLUDE_TOOLS = "read,grep";

        let activeTools: string[] = ["all"];
        const handlers: Record<string, () => void> = {};

        const mockPi = {
          setActiveTools: (tools: string[]) => {
            activeTools = tools;
          },
          on: (_event: string, handler: () => void) => {
            handlers[_event] = handler;
          },
        } as any;

        toolHarnessExt(mockPi);

        // session_start applies the filter
        handlers["session_start"]!();
        expect(activeTools).toEqual(["read", "grep"]);

        // Simulate external re-registration bypassing filter (sub-agents scenario)
        activeTools = ["all", "tools", "again"];

        // before_agent_start re-applies the filter
        handlers["before_agent_start"]!();
        expect(activeTools).toEqual(["read", "grep"]);
      });
    });
  });
}
