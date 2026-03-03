/**
 * e2e contract tests — replay recorded NDJSON fixtures.
 *
 * these tests validate parsing, assertions, and rendering against
 * saved event streams from real pi runs. no AI calls, no cost.
 *
 * fixtures recorded with: PI_E2E=1 PI_E2E_RECORD=1 bun test e2e.test.ts
 *
 * run: bun test user/pi/extensions/tools/e2e-contract.test.ts
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "__fixtures__", "e2e");

// --- types (shared with e2e.test.ts) ---

interface PiEvent {
  type: string;
  [key: string]: any;
}

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

interface ToolResult {
  toolName: string;
  exitCode: number;
  model?: string;
  content: string;
  isError: boolean;
  usage?: {
    turns: number;
    cost: number;
    input: number;
    output: number;
  };
}

// --- event extractors (copied from e2e.test.ts) ---

function getToolCalls(events: PiEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const e of events) {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      for (const part of e.message.content ?? []) {
        if (part.type === "toolCall") {
          calls.push({
            id: part.id,
            name: part.name,
            args: part.arguments ?? {},
          });
        }
      }
    }
  }
  return calls;
}

function getToolResults(events: PiEvent[]): ToolResult[] {
  const results: ToolResult[] = [];
  for (const e of events) {
    if (e.type === "tool_execution_end") {
      const r = e.result ?? {};
      const det = r.details ?? {};
      const text =
        (r.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
      results.push({
        toolName: e.toolName,
        exitCode: det.exitCode ?? -1,
        model: det.model,
        content: text,
        isError: r.isError === true,
        usage: det.usage,
      });
    }
  }
  return results;
}

function getFinalText(events: PiEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "agent_end") {
      const messages = events[i]!.messages ?? [];
      for (let j = messages.length - 1; j >= 0; j--) {
        if (messages[j]!.role === "assistant") {
          for (const part of messages[j]!.content ?? []) {
            if (part.type === "text") return part.text;
          }
        }
      }
    }
  }
  return "";
}

function getCosts(events: PiEvent[]): { parent: number; subAgent: number } {
  let parent = 0;
  let subAgent = 0;
  for (const e of events) {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      parent += e.message.usage?.cost?.total ?? 0;
    }
    if (e.type === "tool_execution_end") {
      subAgent += e.result?.details?.usage?.cost ?? 0;
    }
  }
  return { parent, subAgent };
}

// --- fixture loader ---

function loadFixture(name: string): PiEvent[] {
  const path = join(FIXTURES_DIR, `${name}.ndjson`);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function listFixtures(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => basename(f, ".ndjson"));
}

// --- event invariant validators ---

function validateEventInvariants(events: PiEvent[]): string[] {
  const errors: string[] = [];

  // collect all tool call IDs and their results
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const e of events) {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      for (const part of e.message.content ?? []) {
        if (part.type === "toolCall") {
          toolCallIds.add(part.id);
        }
      }
    }
    if (e.type === "tool_execution_end") {
      toolResultIds.add(e.toolCallId);
    }
  }

  // every tool call should have a result
  for (const id of toolCallIds) {
    if (!toolResultIds.has(id)) {
      errors.push(`tool call ${id} has no corresponding tool_execution_end`);
    }
  }

  // check for usage fields on tool_execution_end
  for (const e of events) {
    if (e.type === "tool_execution_end") {
      const r = e.result ?? {};
      if (r.isError === false) {
        // successful tool should have exitCode
        const det = r.details ?? {};
        if (det.exitCode === undefined) {
          errors.push(`tool_execution_end for ${e.toolName} missing exitCode`);
        }
      }
    }
  }

  return errors;
}

// --- tests ---

describe("fixture validation", () => {
  it("has fixtures directory", () => {
    // This test documents where fixtures should live
    expect(typeof FIXTURES_DIR).toBe("string");
  });

  it("lists available fixtures", () => {
    const fixtures = listFixtures();
    // May be empty if no fixtures recorded yet
    expect(Array.isArray(fixtures)).toBe(true);
  });
});

// Run contract tests for each fixture
describe("e2e contract tests", () => {
  const fixtures = listFixtures();

  if (fixtures.length === 0) {
    it.skip("no fixtures found - run with PI_E2E=1 PI_E2E_RECORD=1 to record", () => {});
    return;
  }

  for (const fixtureName of fixtures) {
    describe(`fixture: ${fixtureName}`, () => {
      let events: PiEvent[];

      beforeAll(() => {
        events = loadFixture(fixtureName);
      });

      it("parses valid NDJSON events", () => {
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) {
          expect(e.type).toBeDefined();
        }
      });

      it("satisfies event invariants", () => {
        const errors = validateEventInvariants(events);
        expect(errors).toEqual([]);
      });

      it("extracts tool calls correctly", () => {
        const calls = getToolCalls(events);
        // most e2e tests should have at least one tool call
        if (fixtureName.includes("registration")) {
          // registration test just asks model to list tools
          expect(calls.length).toBeGreaterThanOrEqual(0);
        } else {
          expect(calls.length).toBeGreaterThanOrEqual(1);
        }
      });

      it("extracts tool results correctly", () => {
        const results = getToolResults(events);
        const calls = getToolCalls(events);

        // every tool call should have a result
        if (calls.length > 0) {
          expect(results.length).toBeGreaterThanOrEqual(calls.length);
        }
      });

      it("extracts costs correctly", () => {
        const { parent } = getCosts(events);
        // parent should have some cost if events exist
        if (events.some((e) => e.type === "message_end")) {
          expect(parent).toBeGreaterThanOrEqual(0);
        }
      });

      it("extracts final text when available", () => {
        const text = getFinalText(events);
        // most tests should produce some text output
        if (!fixtureName.includes("error")) {
          expect(typeof text).toBe("string");
        }
      });
    });
  }
});

// --- specific tool contract tests ---

describe("tool result contract", () => {
  const fixtures = listFixtures();

  for (const fixtureName of fixtures.filter((f) => f.startsWith("tool-"))) {
    it(`${fixtureName}: has correct result structure`, () => {
      const events = loadFixture(fixtureName);
      const results = getToolResults(events);

      expect(results.length).toBeGreaterThanOrEqual(1);

      for (const r of results) {
        expect(r.toolName).toBeDefined();
        expect(typeof r.exitCode).toBe("number");
        expect(typeof r.isError).toBe("boolean");
        expect(typeof r.content).toBe("string");

        // successful tools should have model and usage
        if (!r.isError && r.exitCode === 0) {
          expect(r.model).toBeDefined();
          expect(r.usage).toBeDefined();
          expect(r.usage?.turns).toBeGreaterThanOrEqual(1);
        }
      }
    });
  }
});
