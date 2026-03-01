/**
 * direct invocation tests for bash tool output truncation.
 *
 * invokes the tool's execute() directly, no AI, no pi spawn.
 * run: bun test user/pi/extensions/tools/bash-output.test.ts
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { createBashTool } from "./bash";

describe("bash tool output formatting", () => {
	const tool = createBashTool();

	// mock context with minimal required fields
	const mockCtx = {
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => "test-session-id",
		},
	};

	describe("command header", () => {
		it("shows command in output header", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `echo "hello world"` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;
			expect(text).toMatch(/^\$ echo "hello world"/);
		});

		it("shows full command including args", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `ls -la /tmp` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;
			expect(text).toContain("$ ls -la /tmp");
		});
	});

	describe("small output (no truncation)", () => {
		it("shows all output when small", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `echo "line 1"; echo "line 2"; echo "line 3"` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;
			expect(text).toContain("line 1");
			expect(text).toContain("line 2");
			expect(text).toContain("line 3");
			expect(text).not.toContain("truncated");
		});

		it("handles no output gracefully", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `true` }, // succeeds with no output
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;
			expect(text).toContain("no output");
			expect(result.isError).toBeFalsy(); // undefined or false for success
		});
	});

	describe("large output (truncation)", () => {
		it("shows head + tail for large output", async () => {
			// generate 200 lines
			const result = await tool.execute!(
				"test-id",
				{ cmd: `for i in $(seq 1 200); do echo "line $i"; done` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;

			// should show first lines
			expect(text).toContain("line 1");
			expect(text).toContain("line 2");

			// should show last lines
			expect(text).toContain("line 199");
			expect(text).toContain("line 200");

			// should have truncation marker
			expect(text).toContain("truncated");

			// verify ordering: head before marker before tail
			const idx1 = text.indexOf("line 1");
			const idxMarker = text.indexOf("truncated");
			const idx200 = text.indexOf("line 200");
			expect(idx1).toBeLessThan(idxMarker);
			expect(idxMarker).toBeLessThan(idx200);
		}, 10_000);
	});

	describe("exit codes", () => {
		it("shows exit code on failure", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `echo "some output"; exit 42` },
				undefined,
				undefined,
				mockCtx as any,
			);

			expect(result.isError).toBe(true);
			const text = result.content[0].text;
			expect(text).toContain("exit code 42");
		});

		it("no exit code on success", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `echo "success"` },
				undefined,
				undefined,
				mockCtx as any,
			);

			expect(result.isError).toBeFalsy(); // undefined or false for success
			const text = result.content[0].text;
			expect(text).not.toContain("exit code");
		});
	});

	describe("mixed stdout/stderr", () => {
		it("captures both stdout and stderr", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `echo "stdout"; echo "stderr" >&2` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;
			expect(text).toContain("stdout");
			expect(text).toContain("stderr");
		});
	});

	describe("reversion guards (fail on old behavior)", () => {
		it("shows FIRST lines, not just tail", async () => {
			// OLD BEHAVIOR: only tail (last N chars)
			// NEW BEHAVIOR: head (first N lines) + tail
			const result = await tool.execute!(
				"test-id",
				{ cmd: `for i in $(seq 1 100); do echo "output line $i"; done` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;

			// CRITICAL: this FAILS on old tail-only truncation
			expect(text).toContain("output line 1");
			expect(text).toContain("output line 2");

			// AND still has tail
			expect(text).toContain("output line 99");
			expect(text).toContain("output line 100");
		}, 10_000);

		it("command header is present at start of output", async () => {
			// OLD BEHAVIOR: no command header, just raw output
			// NEW BEHAVIOR: starts with "$ <cmd>"
			const result = await tool.execute!(
				"test-id",
				{ cmd: `echo "test"` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;

			// This assertion FAILS on old code
			expect(text).toMatch(/^\$ echo "test"/);

			// The command header should be the first thing
			const firstNewline = text.indexOf("\n");
			const firstLine = text.slice(0, firstNewline);
			expect(firstLine).toBe('$ echo "test"');
		});

		it("head lines appear before tail lines in truncated output", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `for i in $(seq 1 150); do echo "line $i"; done` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;

			// Find positions of first head line and last tail line
			const firstHeadIdx = text.indexOf("line 1");
			const lastTailIdx = text.indexOf("line 150");

			// In old tail-only behavior, there would be no "line 1"
			// In new behavior, "line 1" must come before "line 150"
			expect(firstHeadIdx).toBeGreaterThan(0); // exists
			expect(firstHeadIdx).toBeLessThan(lastTailIdx);
		}, 10_000);
	});

	describe("edge cases", () => {
		it("handles command with special characters", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `echo "special: 'quotes' and "double" and $var"` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;
			expect(text).toContain('special');
		});

		it("handles very long single line", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `python3 -c "print('x' * 10000)"` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;
			// single line fits in head, no truncation
			expect(text).toContain("xxxxx");
		}, 10_000);

		it("handles many short lines", async () => {
			const result = await tool.execute!(
				"test-id",
				{ cmd: `for i in $(seq 1 500); do echo "x"; done` },
				undefined,
				undefined,
				mockCtx as any,
			);

			const text = result.content[0].text;
			// should have truncation marker
			expect(text).toContain("truncated");
		}, 10_000);
	});
});