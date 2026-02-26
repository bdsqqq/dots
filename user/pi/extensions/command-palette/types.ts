import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface PaletteEntry {
  id: string;
  label: string;
  description?: string;
  source: "builtin" | "extension" | "skill";
  action: (ctx: ExtensionContext) => void | Promise<void>;
}
