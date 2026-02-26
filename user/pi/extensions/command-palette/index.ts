import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { buildEntries } from "./entries";
import { CommandPalette } from "./palette";
import type { PaletteEntry } from "./types";

export default function commandPaletteExtension(pi: ExtensionAPI) {
  async function openPalette(ctx: import("@mariozechner/pi-coding-agent").ExtensionContext) {
    if (!ctx.hasUI) return;

    const entries = buildEntries(pi, ctx);

    const selected = await ctx.ui.custom<PaletteEntry | null>(
      (tui, theme, _kb, done) => {
        const palette = new CommandPalette(entries, theme, done);
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

    if (selected) {
      try {
        await selected.action(ctx);
      } catch (err) {
        ctx.ui.notify(`Command failed: ${err}`, "error");
      }
    }
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
