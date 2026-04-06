/**
 * SDK-backed integration tests for command-palette extension.
 *
 * Tests extension registration and handler behavior using minimal mocks.
 */

import { describe, it, expect, vi } from "vitest";
import commandPaletteExtension from "../index";

describe("command-palette extension (SDK integration)", () => {
	describe("extension registration", () => {
		it("registers ctrl+p shortcut and /palette command", () => {
			const calls: { type: string; name?: string; key?: string }[] = [];
			const mockPi = {
				registerShortcut: (key: string, opts: { description: string }) => {
					calls.push({ type: "shortcut", key });
				},
				registerCommand: (name: string, opts: { description: string }) => {
					calls.push({ type: "command", name });
				},
			} as any;

			commandPaletteExtension(mockPi);

			expect(calls).toEqual([
				{ type: "shortcut", key: "ctrl+p" },
				{ type: "command", name: "palette" },
			]);
		});
	});

	describe("shortcut handler", () => {
		it("returns early when ctx.hasUI is false", async () => {
			const shortcutCalls: { key: string; handler: Function }[] = [];
			const mockPi = {
				registerShortcut: (key: string, opts: any) => {
					shortcutCalls.push({ key, handler: opts.handler });
				},
				registerCommand: () => {},
				getCommands: () => [],
			} as any;

			commandPaletteExtension(mockPi);

			const handler = shortcutCalls.find((s) => s.key === "ctrl+p")!.handler;
			const ctx = { hasUI: false };

			// Should not throw, should return early
			await handler(ctx);
			// No error thrown = pass
		});

		it("calls ctx.ui.custom when hasUI is true", async () => {
			const shortcutCalls: { key: string; handler: Function }[] = [];
			const mockPi = {
				registerShortcut: (key: string, opts: any) => {
					shortcutCalls.push({ key, handler: opts.handler });
				},
				registerCommand: () => {},
				getCommands: () => [],
			} as any;

			commandPaletteExtension(mockPi);

			const handler = shortcutCalls.find((s) => s.key === "ctrl+p")!.handler;
			let customCalled = false;
			const ctx = {
				hasUI: true,
				ui: {
					custom: async () => {
						customCalled = true;
					},
				},
				modelRegistry: { getAvailable: () => [] },
			};

			await handler(ctx);
			expect(customCalled).toBe(true);
		});
	});

	describe("command handler", () => {
		it("returns early when ctx.hasUI is false", async () => {
			const commandCalls: { name: string; handler: Function }[] = [];
			const mockPi = {
				registerShortcut: () => {},
				registerCommand: (name: string, opts: any) => {
					commandCalls.push({ name, handler: opts.handler });
				},
				getCommands: () => [],
			} as any;

			commandPaletteExtension(mockPi);

			const handler = commandCalls.find((c) => c.name === "palette")!.handler;
			const ctx = { hasUI: false };

			await handler([], ctx);
			// No error thrown = pass
		});
	});
});
