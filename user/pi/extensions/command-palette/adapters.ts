import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PaletteItem, PaletteView, PaletteActionContext } from "./types";

// ── sub-view builders ────────────────────────────────────────────────────

function buildModelView(pi: ExtensionAPI, ctx: ExtensionContext): PaletteView {
  const models = ctx.modelRegistry.getAvailable();
  const items: PaletteItem[] = models.map((model) => ({
    id: `model:${model.provider}:${model.id}`,
    label: model.name,
    category: model.provider,
    onSelect: async (actx: PaletteActionContext) => {
      const ok = await actx.pi.setModel(model);
      if (!ok) {
        actx.ctx.ui.notify("No API key for this model", "error");
      }
      actx.close();
    },
  }));
  return { title: "Select Model", items };
}

function buildThinkingView(pi: ExtensionAPI): PaletteView {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
  const current = pi.getThinkingLevel();
  const items: PaletteItem[] = levels.map((level) => ({
    id: `thinking:${level}`,
    label: `${level === current ? "● " : "  "}${level}`,
    category: "setting",
    onSelect: (actx: PaletteActionContext) => {
      actx.pi.setThinkingLevel(level);
      actx.close();
    },
  }));
  return { title: "Thinking Level", items, searchable: false };
}

function buildToolsView(pi: ExtensionAPI): PaletteView {
  const all = pi.getAllTools();
  const active = new Set(pi.getActiveTools());
  const items: PaletteItem[] = all.map((tool) => ({
    id: `tool:${tool.name}`,
    label: `${active.has(tool.name) ? "✓" : "○"} ${tool.name}`,
    description: tool.description,
    category: "tool",
    onSelect: (actx: PaletteActionContext) => {
      const currentActive = new Set(actx.pi.getActiveTools());
      if (currentActive.has(tool.name)) {
        currentActive.delete(tool.name);
      } else {
        currentActive.add(tool.name);
      }
      actx.pi.setActiveTools([...currentActive]);
      // refresh view in-place so user can keep toggling
      actx.push(buildToolsView(actx.pi));
    },
  }));
  return { title: "Toggle Tools", items };
}

// ── helpers ──────────────────────────────────────────────────────────────

function fireAndForget(
  id: string,
  label: string,
  description: string,
  action: (actx: PaletteActionContext) => void | Promise<void>,
): PaletteItem {
  return {
    id,
    label,
    description,
    category: "cmd",
    onSelect: async (actx) => {
      await action(actx);
      actx.close();
    },
  };
}

function delegate(name: string, description: string): PaletteItem {
  return {
    id: `builtin:${name}`,
    label: name,
    description,
    category: "cmd",
    delegate: true,
    onSelect: (actx) => {
      actx.close();
      actx.pi.sendUserMessage(`/${name}`);
    },
  };
}

function drillDown(
  id: string,
  label: string,
  description: string,
  viewFn: () => PaletteView,
): PaletteItem {
  return {
    id,
    label,
    description,
    category: "cmd",
    onSelect: (actx) => {
      actx.push(viewFn());
    },
  };
}

// ── root view ────────────────────────────────────────────────────────────

export function buildRootView(pi: ExtensionAPI, ctx: ExtensionContext): PaletteView {
  const items: PaletteItem[] = [];

  // fire-and-forget
  items.push(
    fireAndForget("builtin:new", "new", "Start a new session", (actx) => {
      actx.pi.sendUserMessage("/new");
    }),
    fireAndForget("builtin:fork", "fork", "Fork current session", (actx) => {
      actx.pi.sendUserMessage("/fork");
    }),
    fireAndForget("builtin:copy", "copy", "Copy last message to clipboard", (actx) => {
      actx.pi.sendUserMessage("/copy");
    }),
    fireAndForget("builtin:reload", "reload", "Reload extensions, skills, prompts", (actx) => {
      actx.pi.sendUserMessage("/reload");
    }),
    fireAndForget("builtin:quit", "quit", "Quit pi", (actx) => {
      actx.ctx.shutdown();
    }),
    fireAndForget("builtin:exit", "exit", "Quit pi", (actx) => {
      actx.ctx.shutdown();
    }),
  );

  // drill-down
  items.push(
    drillDown("builtin:model", "model", "Switch models", () => buildModelView(pi, ctx)),
    drillDown("setting:thinking", "thinking", "Set thinking level", () => buildThinkingView(pi)),
    drillDown("setting:tools", "tools", "Toggle active tools", () => buildToolsView(pi)),
  );

  // delegate — text input needed
  items.push(
    delegate("name", "Set session display name"),
    delegate("compact", "Manually compact context"),
    delegate("export", "Export session to HTML file"),
  );

  // delegate — complex flows / no programmatic API
  items.push(
    delegate("login", "OAuth authentication"),
    delegate("logout", "OAuth authentication"),
    delegate("scoped-models", "Enable/disable models for Ctrl+P cycling"),
    delegate("settings", "Thinking level, theme, message delivery, transport"),
    delegate("resume", "Pick from previous sessions"),
    delegate("session", "Show session info"),
    delegate("tree", "Jump to any point in the session"),
    delegate("share", "Upload as private GitHub gist"),
    delegate("hotkeys", "Show all keyboard shortcuts"),
    delegate("changelog", "Display version history"),
  );

  // dynamic commands from pi.getCommands()
  const commands = pi.getCommands();
  const sourceCategory: Record<string, string> = {
    extension: "ext",
    skill: "skill",
    prompt: "tpl",
  };
  for (const cmd of commands) {
    if (cmd.name === "palette") continue;
    const cat = sourceCategory[cmd.source] ?? "ext";
    items.push({
      id: `${cmd.source}:${cmd.name}`,
      label: cmd.name,
      description: cmd.description,
      category: cat,
      onSelect: (actx) => {
        actx.pi.sendUserMessage(`/${cmd.name}`);
        actx.close();
      },
    });
  }

  // sort: builtin/setting first, then ext, then tpl, then skill. alphabetical within.
  const order: Record<string, number> = { cmd: 0, setting: 0, ext: 1, tpl: 2, skill: 3 };
  items.sort((a, b) => {
    const so = (order[a.category ?? ""] ?? 99) - (order[b.category ?? ""] ?? 99);
    if (so !== 0) return so;
    return a.label.localeCompare(b.label);
  });

  return { title: "Command Palette", items };
}
