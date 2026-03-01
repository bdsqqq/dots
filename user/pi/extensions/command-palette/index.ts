import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildRootView } from "./adapters";
import { StackPalette } from "./palette";

export default function commandPaletteExtension(pi: ExtensionAPI) {
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

  pi.registerShortcut("ctrl+shift+p", {
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
