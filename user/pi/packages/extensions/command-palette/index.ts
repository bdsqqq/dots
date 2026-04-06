/**
 * command palette — ctrl+p overlay for navigating tools, commands, and settings.
 *
 * renders as a centered overlay (72-char, top-anchored) using pi's ctx.ui.custom()
 * API. views are composable via StackPalette — each view pushes onto a stack,
 * esc pops back. adapters (buildRootView) wire extension-registered commands
 * and tools into palette items.
 *
 * also registered as `/palette` command for non-shortcut access.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildRootView } from "./adapters";
import { StackPalette } from "./palette";

export default function commandPaletteExtension(pi: ExtensionAPI): void {
  async function openPalette(
    ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
  ) {
    if (!ctx.hasUI) return;

    const rootView = buildRootView(pi, ctx);

    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        const palette = new StackPalette(rootView, theme, pi, ctx, done);
        return {
          render: (w: number) => palette.render(w),
          handleInput: (data: string) => {
            palette.handleInput(data);
            tui.requestRender();
          },
          invalidate: () => palette.invalidate(),
          get focused() {
            return palette.focused;
          },
          set focused(v: boolean) {
            palette.focused = v;
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-center",
          width: 72,
          minWidth: 40,
          maxHeight: "60%",
          offsetY: 2,
        },
      },
    );
  }

  pi.registerShortcut("ctrl+p", {
    description: "Open command palette",
    handler: async (ctx) => {
      await openPalette(ctx);
    },
  });

  pi.registerCommand("palette", {
    description: "Open command palette",
    handler: async (_args, ctx) => {
      await openPalette(ctx);
    },
  });
}

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;
  const { default: commandPaletteExtension } = await import("./index");

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
}

