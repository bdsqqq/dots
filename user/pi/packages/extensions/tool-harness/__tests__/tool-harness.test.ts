/**
 * SDK-backed integration tests for tool-harness extension.
 *
 * Tests env-gated tool filtering behavior using minimal tracking mocks
 * that verify observable outcomes (setActiveTools calls, event registrations).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import toolHarnessExtension, { resolveAliases } from "../index";

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
        setActiveTools: (tools: string[]) => calls.push(`setActiveTools:${tools.join(",")}`),
        on: (event: string) => calls.push(`on:${event}`),
      } as any;

      toolHarnessExtension(mockPi);

      expect(calls).toHaveLength(0);
    });
  });

  describe("PI_INCLUDE_TOOLS=NONE", () => {
    it("registers handlers that call setActiveTools with empty array", async () => {
      process.env.PI_INCLUDE_TOOLS = "NONE";

      const calls: { type: string; event?: string; tools?: string[] }[] = [];
      const handlers: Record<string, () => void> = {};

      const mockPi = {
        setActiveTools: (tools: string[]) => calls.push({ type: "setActiveTools", tools }),
        on: (event: string, handler: () => void) => {
          calls.push({ type: "on", event });
          handlers[event] = handler;
        },
      } as any;

      toolHarnessExtension(mockPi);

      // Verify both handlers are registered
      expect(calls.filter((c) => c.type === "on").map((c) => c.event).sort()).toEqual([
        "before_agent_start",
        "session_start",
      ]);

      // Simulate session_start event
      await handlers["session_start"]();
      expect(calls.filter((c) => c.type === "setActiveTools")).toEqual([
        { type: "setActiveTools", tools: [] },
      ]);

      // Simulate before_agent_start event
      await handlers["before_agent_start"]();
      expect(calls.filter((c) => c.type === "setActiveTools")).toHaveLength(2);
    });
  });

  describe("PI_INCLUDE_TOOLS with tool list", () => {
    it("registers handlers that filter to specified tools", async () => {
      process.env.PI_INCLUDE_TOOLS = "read,grep,bash";

      const calls: { type: string; event?: string; tools?: string[] }[] = [];
      const handlers: Record<string, () => void> = {};

      const mockPi = {
        setActiveTools: (tools: string[]) => calls.push({ type: "setActiveTools", tools }),
        on: (event: string, handler: () => void) => {
          calls.push({ type: "on", event });
          handlers[event] = handler;
        },
      } as any;

      toolHarnessExtension(mockPi);

      // Verify handlers are registered
      expect(calls.filter((c) => c.type === "on").map((c) => c.event).sort()).toEqual([
        "before_agent_start",
        "session_start",
      ]);

      // Simulate session_start event
      await handlers["session_start"]();
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

      toolHarnessExtension(mockPi);

      await handlers["session_start"]();

      expect(calls[0].tools).toEqual(["read", "grep", "bash"]);
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

      toolHarnessExtension(mockPi);

      await handlers["session_start"]();

      expect(calls[0].tools).toEqual(["find", "edit", "write"]);
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

      toolHarnessExtension(mockPi);

      await handlers["session_start"]();

      expect(calls[0].tools).toEqual(["find", "read", "edit", "bash"]);
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

      toolHarnessExtension(mockPi);

      expect(calls).toHaveLength(0);
    });

    it("does nothing for single comma", () => {
      process.env.PI_INCLUDE_TOOLS = ",";

      const calls: string[] = [];
      const mockPi = {
        setActiveTools: () => calls.push("setActiveTools"),
        on: () => calls.push("on"),
      } as any;

      toolHarnessExtension(mockPi);

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

      toolHarnessExtension(mockPi);

      // session_start applies the filter
      await handlers["session_start"]();
      expect(activeTools).toEqual(["read", "grep"]);

      // Simulate external re-registration bypassing filter (sub-agents scenario)
      activeTools = ["all", "tools", "again"];

      // before_agent_start re-applies the filter
      await handlers["before_agent_start"]();
      expect(activeTools).toEqual(["read", "grep"]);
    });
  });
});
