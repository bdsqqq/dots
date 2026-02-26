import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PaletteEntry } from "./types";

/**
 * Builds the flat list of palette entries from all available command sources.
 * Called each time the palette opens so it reflects current state.
 */
export function buildEntries(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  const commands = pi.getCommands();

  for (const cmd of commands) {
    // skip the palette's own command to avoid recursion
    if (cmd.name === "palette") continue;

    entries.push({
      id: cmd.name,
      label: cmd.name,
      description: cmd.description,
      source: cmd.source === "extension"
        ? "extension"
        : cmd.source === "skill"
          ? "skill"
          : "builtin",
      action: (_ctx) => {
        pi.sendUserMessage(`/${cmd.name}`);
      },
    });
  }

  // sort: builtin first, then extension, then skill. alphabetical within.
  const sourceOrder = { builtin: 0, extension: 1, skill: 2 };
  entries.sort((a, b) => {
    const so = sourceOrder[a.source] - sourceOrder[b.source];
    if (so !== 0) return so;
    return a.label.localeCompare(b.label);
  });

  return entries;
}
