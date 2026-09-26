/**
 * tool-harness — env-gated tool filtering for pi extensions.
 *
 * compatibility for direct PI_INCLUDE_TOOLS consumers. piSpawn also compiles
 * this selection into native CLI flags: setActiveTools cannot restore tools
 * omitted from the SDK registry, or enforce exclusions across registry refresh.
 *
 * env var format: PI_INCLUDE_TOOLS=read,grep,find,bash
 * when unset, all tools remain active (no filtering).
 * when set to "NONE", all tools are disabled.
 *
 * designed for sub-agent spawning: piSpawn passes
 * PI_INCLUDE_TOOLS in the child process env to control tool visibility.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseIncludedTools,
  resolveAliases,
} from "../../core/pi-spawn/tool-selection.js";
export {
  resolveAliases,
  TOOL_ALIASES as TOOL_ALIASES_EXPORT,
} from "../../core/pi-spawn/tool-selection.js";

export default function (pi: ExtensionAPI): void {
  const allowed = parseIncludedTools(process.env.PI_INCLUDE_TOOLS);
  if (allowed === undefined) return;

  const applyFilter = () => pi.setActiveTools(allowed);

  pi.on("session_start", async () => {
    applyFilter();
  });

  // direct env consumers still need a per-turn filter when tools change.
  // piSpawn's native allowlist enforces exclusions during registry refresh too.
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

    it("resolves legacy mutation aliases to apply_patch", () => {
      expect(resolveAliases(["edit_file"])).toEqual(["apply_patch"]);
      expect(resolveAliases(["create_file"])).toEqual(["apply_patch"]);
    });

    it("resolves multiple aliases in one call", () => {
      expect(
        resolveAliases(["glob", "edit_file", "create_file", "bash"]),
      ).toEqual(["find", "apply_patch", "bash"]);
    });

    it("returns empty array unchanged", () => {
      expect(resolveAliases([])).toEqual([]);
    });
  });

  describe("tool-harness event handlers", () => {
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

        expect(calls[0]!.tools).toEqual(["find", "apply_patch"]);
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

        expect(calls[0]!.tools).toEqual([
          "find",
          "read",
          "apply_patch",
          "bash",
        ]);
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
