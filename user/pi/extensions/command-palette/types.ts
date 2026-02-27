import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * A single selectable item in a palette list view.
 * This is the universal unit — every command, model, thinking level, etc.
 * becomes a PaletteItem. The palette doesn't know what it's rendering.
 */
export interface PaletteItem {
  id: string;
  /** Display label (the main text) */
  label: string;
  /** Secondary text shown dimmed after the label */
  description?: string;
  /** Left-side category badge, right-aligned (e.g. "cmd", "ext", "skill") */
  category?: string;
  /** Right-side shortcut hint (e.g. "Ctrl+L") */
  shortcut?: string;
  /** Whether this item delegates to pi's native UI (shows * marker) */
  delegate?: boolean;
  /**
   * Called when the user selects this item.
   * - To drill down: call push() with a new view.
   * - To execute and close: do the work, then call close().
   * - For delegate: call close() then sendUserMessage.
   */
  onSelect: (ctx: PaletteActionContext) => void | Promise<void>;
}

/** Context passed to PaletteItem.onSelect for controlling the palette */
export interface PaletteActionContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  /** Push a new view onto the palette stack (drill-down) */
  push: (view: PaletteView) => void;
  /** Close the palette overlay entirely */
  close: () => void;
}

/**
 * A single view in the palette stack.
 * The palette renders whichever view is on top of the stack.
 */
export interface PaletteView {
  /** Title shown in the overlay header */
  title: string;
  /** Items to display (searchable by default) */
  items: PaletteItem[];
  /** Whether fuzzy search is enabled (default: true) */
  searchable?: boolean;
}
