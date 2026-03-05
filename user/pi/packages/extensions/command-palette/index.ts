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
