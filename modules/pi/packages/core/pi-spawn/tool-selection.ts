/** legacy names must be resolved before the SDK filters the tool registry. */
export const TOOL_ALIASES: Record<string, string> = {
  glob: "find",
  edit_file: "apply_patch",
  create_file: "apply_patch",
};

export function resolveAliases(names: string[]): string[] {
  return [...new Set(names.map((name) => TOOL_ALIASES[name] ?? name))];
}

/** undefined preserves defaults; the legacy NONE sentinel disables all tools. */
export function parseIncludedTools(
  raw: string | undefined,
): string[] | undefined {
  if (raw === "NONE") return [];
  const names =
    raw
      ?.split(",")
      .map((name) => name.trim())
      .filter(Boolean) ?? [];
  return names.length ? resolveAliases(names) : undefined;
}
