import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  SelectList,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";

type Action = () => void | Promise<void>;
const ownPath = realpathSync(fileURLToPath(import.meta.url));
type ArgumentEntry = SelectItem & {
  submit: (args: string) => void;
  warning: string;
};
type ActionEntry = SelectItem & { run: Action };
type SubmenuEntry = SelectItem & { children: ActionEntry[] };
type Entry = ActionEntry | SubmenuEntry | ArgumentEntry;
type PaletteState =
  | { kind: "root"; input: Input }
  | { kind: "submenu"; entry: SubmenuEntry; input: Input }
  | { kind: "arguments"; entry: ArgumentEntry; input: Input };
type Command = ReturnType<ExtensionAPI["getCommands"]>[number];

/** native interactive commands are absent from getCommands and cannot be dispatched
 * through prompt; keep their public-API adapters separate. runtime dispatches
 * extensions before expanding skills, then templates; hide shadowed names. */
function resolveInvocations(pi: ExtensionAPI): Command[] {
  const names = new Set<string>();
  const order = { extension: 0, skill: 1, prompt: 2 };
  return [...pi.getCommands()]
    .sort((a, b) => order[a.source] - order[b.source])
    .filter(({ name }) => {
      if (names.has(name)) return false;
      names.add(name);
      return true;
    });
}

function isOwnCommand(command: Command, cwd: string): boolean {
  if (
    command.source !== "extension" ||
    !/^palette(?::\d+)?$/.test(command.name)
  )
    return false;
  // collision suffixes identify invocations, not owners; compare provenance.
  try {
    return realpathSync(resolve(cwd, command.sourceInfo.path)) === ownPath;
  } catch {
    // virtual or removed sources are not evidence that this is our command.
    return false;
  }
}

function dispatchCommand(
  pi: ExtensionAPI,
  command: Command,
  args: string,
): void {
  const current = resolveInvocations(pi).find(
    (item) => item.name === command.name,
  );
  if (
    !current ||
    current.source !== command.source ||
    current.sourceInfo.path !== command.sourceInfo.path
  ) {
    throw new Error(
      `/${command.name} changed or is no longer available; reopen palette`,
    );
  }
  // names are already invokable; runtime expands prompts before follow-up queueing.
  // this API returns void: later errors/completion belong to the runtime, not us.
  pi.sendUserMessage(`/${command.name}${args ? ` ${args}` : ""}`, {
    expandPromptTemplates: true,
    deliverAs: "followUp",
  });
}

export function paletteEntries(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Entry[] {
  const current = pi.getThinkingLevel();
  const levels = ctx.model
    ? getSupportedThinkingLevels(ctx.model)
    : ["off" as const];
  const models = ctx.scopedModels.length
    ? ctx.scopedModels
    : ctx.modelRegistry
        .getAvailable()
        .map((model) => ({ model, thinkingLevel: undefined }));
  return [
    {
      value: "thinking",
      label: "thinking level…",
      description: `${current} · this session`,
      children: levels.map((level) => ({
        value: level,
        label: `${level}${level === current ? " ✓" : ""}`,
        run: () => {
          pi.setThinkingLevel(level);
        },
      })),
    },
    {
      value: "model",
      label: "model…",
      description: "change model for this session",
      children: models.map(({ model, thinkingLevel }) => ({
        value: `${model.provider}/${model.id}`,
        label: `${ctx.model?.provider === model.provider && ctx.model.id === model.id ? "✓ " : ""}${model.id}`,
        description: `${model.provider} · ${model.name}${thinkingLevel ? ` · thinking: ${thinkingLevel}` : ""}`,
        run: async () => {
          if (!(await pi.setModel(model))) {
            throw new Error(
              `no authentication configured for ${model.provider}/${model.id}`,
            );
          }
          // a scope's pinned level applies only after the model switch succeeds.
          if (thinkingLevel !== undefined) pi.setThinkingLevel(thinkingLevel);
        },
      })),
    },
    {
      value: "tools",
      label: ctx.ui.getToolsExpanded()
        ? "collapse tool output"
        : "expand tool output",
      description: "display only",
      run: () => ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded()),
    },
    {
      value: "theme",
      label: "theme…",
      description: "change appearance",
      children: ctx.ui.getAllThemes().map(({ name }) => ({
        value: name,
        label: `${name}${name === ctx.ui.theme.name ? " ✓" : ""}`,
        run: () => {
          const result = ctx.ui.setTheme(name);
          if (!result.success)
            throw new Error(result.error ?? `could not load theme ${name}`);
        },
      })),
    },
    ...resolveInvocations(pi)
      .filter((command) => !isOwnCommand(command, ctx.cwd))
      .map(
        (command): ArgumentEntry => ({
          value: `command:${command.source}:${command.name}`,
          label: `/${command.name}`,
          description: `${command.source === "prompt" ? "template prompt" : command.source === "skill" ? "skill prompt" : "extension"} · ${command.description ?? command.sourceInfo.source}`,
          warning:
            command.source === "extension"
              ? "extension: runs immediately; may change draft"
              : "prompt submission: follow-up while streaming",
          submit: (args) => dispatchCommand(pi, command, args),
        }),
      ),
  ];
}

export class CommandPalette implements Component, Focusable {
  private readonly rootState = {
    kind: "root" as const,
    input: new Input({ placeholder: "search commands…" }),
  };
  private state: PaletteState = this.rootState;
  private list!: SelectList;
  private hasFocus = false;
  private visibleItems = 0;

  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.state.input.focused = value;
  }

  constructor(
    private readonly root: Entry[],
    private readonly theme: Pick<Theme, "fg">,
    private readonly keys: KeybindingsManager,
    private readonly done: (action: Action | undefined) => void,
    private readonly requestRender: () => void,
    private readonly terminalRows: () => number,
  ) {
    this.filter();
  }

  private get entries(): Entry[] {
    return this.state.kind === "submenu"
      ? this.state.entry.children
      : this.root;
  }

  /** reserve seven chrome rows and SelectList's optional scroll indicator. */
  private itemCapacity(): number {
    return Math.max(0, Math.min(8, this.overlayHeight() - 8));
  }

  private overlayHeight(): number {
    return Math.max(1, Math.floor(this.terminalRows() * 0.8));
  }

  private resize(): void {
    if (this.visibleItems !== this.itemCapacity()) this.filter(true);
  }

  private filter(preserveSelection = false): void {
    const selected = preserveSelection
      ? this.list?.getSelectedItem()?.value
      : undefined;
    this.visibleItems = this.itemCapacity();
    const input =
      this.state.kind === "arguments" ? this.rootState.input : this.state.input;
    const words = input.getValue().toLowerCase().trim().split(/\s+/);
    const entries = this.entries.filter((entry) => {
      const text =
        `${entry.value} ${entry.label} ${entry.description ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
    this.list = new SelectList(
      entries,
      Math.max(1, this.visibleItems),
      {
        selectedPrefix: (s) => this.theme.fg("accent", s),
        selectedText: (s) => this.theme.fg("accent", s),
        description: (s) => this.theme.fg("muted", s),
        scrollInfo: (s) => this.theme.fg("dim", s),
        noMatch: (s) => this.theme.fg("warning", s),
      },
      {
        minPrimaryColumnWidth: 16,
        maxPrimaryColumnWidth: 52,
        // retain both the current marker and model suffix when identifiers are long.
        truncatePrimary: ({ text, maxWidth }) => {
          const width = visibleWidth(text);
          if (width <= maxWidth || maxWidth < 4)
            return truncateToWidth(text, maxWidth, "");
          const tail = Math.floor((maxWidth - 1) / 2);
          return (
            truncateToWidth(text, maxWidth - tail - 1, "") +
            "…" +
            sliceByColumn(text, width - tail, tail)
          );
        },
      },
    );
    if (selected !== undefined)
      this.list.setSelectedIndex(
        entries.findIndex((entry) => entry.value === selected),
      );
  }

  handleInput(data: string): void {
    this.resize();
    const state = this.state;
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (state.kind === "root") return this.done(undefined);
      this.state = this.rootState;
      this.filter(state.kind === "arguments");
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      // a resize may arrive before the next render; never select a hidden row.
      if (this.visibleItems === 0) return;
      if (state.kind === "arguments") {
        const args = state.input.getValue();
        return this.done(() => state.entry.submit(args));
      }
      const selected = this.list.getSelectedItem();
      const entry = this.entries.find((item) => item.value === selected?.value);
      if (entry && "children" in entry) {
        this.state = {
          kind: "submenu",
          entry,
          input: new Input({ placeholder: "search commands…" }),
        };
        this.filter();
      } else if (entry && "run" in entry) {
        return this.done(entry.run);
      } else if (entry && "submit" in entry) {
        // a fresh input also discards cancelled arguments' undo history.
        this.state = {
          kind: "arguments",
          entry,
          input: new Input({ placeholder: "arguments (blank allowed)…" }),
        };
      }
    } else if (state.kind === "arguments") {
      // ProcessTerminal rewraps complete StdinBuffer paste events; Input strips
      // newlines, so preserve separators before handing the event to it.
      state.input.handleInput(
        data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")
          ? data.replace(/\r\n|\r|\n/g, " ")
          : data,
      );
    } else if (
      this.keys.matches(data, "tui.select.up") ||
      this.keys.matches(data, "tui.select.down")
    ) {
      this.list.handleInput(data);
    } else {
      const before = state.input.getValue();
      state.input.handleInput(data);
      if (before !== state.input.getValue()) this.filter();
    }
    this.state.input.focused = this.focused;
    this.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    this.resize();
    if (this.visibleItems === 0) {
      return [
        truncateToWidth(
          this.theme.fg(
            "warning",
            "resize terminal to use palette · esc back/close",
          ),
          width,
          "",
        ),
      ];
    }
    const inner = Math.max(4, width - 2);
    const state = this.state;
    if (state.kind === "arguments") {
      return [
        this.theme.fg("borderAccent", "─".repeat(width)),
        this.theme.fg("accent", `${state.entry.label} · arguments`),
        ...state.input.render(inner),
        this.theme.fg("warning", state.entry.warning),
        this.theme.fg(
          "dim",
          `${this.keys.getKeys("tui.select.confirm").join("/")} run · ${this.keys.getKeys("tui.select.cancel").join("/")} back`,
        ),
        this.theme.fg("borderAccent", "─".repeat(width)),
      ].map((line) => truncateToWidth(line, width, ""));
    }
    const hint = `${this.keys.getKeys("tui.select.up").join("/")}/${this.keys.getKeys("tui.select.down").join("/")} navigate · ${this.keys.getKeys("tui.select.confirm").join("/")} select · ${this.keys.getKeys("tui.select.cancel").join("/")} ${state.kind === "submenu" ? "back" : "close"}`;
    return [
      this.theme.fg("borderAccent", "─".repeat(width)),
      this.theme.fg(
        "accent",
        state.kind === "submenu"
          ? `command palette › ${state.entry.label.replace(/…$/, "")}`
          : "command palette",
      ),
      ...state.input.render(inner),
      "",
      ...this.list.render(inner),
      "",
      this.theme.fg("dim", hint),
      this.theme.fg("borderAccent", "─".repeat(width)),
    ].map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {
    this.state.input.invalidate();
    this.list.invalidate();
  }
}

export default function commandPaletteExtension(pi: ExtensionAPI): void {
  let open = false;
  const show = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui" || open) return;
    open = true;
    try {
      const entries = paletteEntries(pi, ctx);
      const action = await ctx.ui.custom<Action | undefined>(
        (tui, theme, keys, done) =>
          new CommandPalette(
            entries,
            theme,
            keys,
            done,
            () => tui.requestRender(),
            () => tui.terminal.rows,
          ),
        {
          overlay: true,
          overlayOptions: {
            width: 76,
            anchor: "top-center",
            offsetY: 2,
            maxHeight: "80%",
          },
        },
      );
      // close the overlay before changing UI state. never snapshot/rewrite the editor:
      // text alone cannot preserve its cursor, undo history, paste blocks, or attachments.
      await action?.();
    } catch (error) {
      ctx.ui.notify(
        `command palette: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      open = false;
    }
  };
  pi.registerShortcut("ctrl+shift+p", {
    description: "Open command palette",
    handler: show,
  });
  pi.registerCommand("palette", {
    description: "Open command palette",
    handler: async (_args, ctx) => show(ctx),
  });
}

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;
  const { stripVTControlCharacters } = await import("node:util");
  const { CURSOR_MARKER, visibleWidth, getKeybindings, StdinBuffer } =
    await import("@earendil-works/pi-tui");
  const theme = {
    name: "dark",
    fg: (_color: string, text: string) => text,
  } as Theme;
  const model: NonNullable<ExtensionContext["model"]> = {
    id: "reasoner",
    name: "Reasoner",
    provider: "test",
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      xhigh: null,
      max: "max",
    },
  };

  function harness() {
    let shortcut!: (ctx: ExtensionContext) => Promise<void> | void;
    let palette!: CommandPalette;
    let finish!: (action: Action | undefined) => void;
    let level: ReturnType<ExtensionAPI["getThinkingLevel"]> = "high";
    let expanded = false;
    let activeModel = model;
    let activeTheme = "dark";
    const terminal = { rows: 30 };
    const inventory: { commands: ReturnType<ExtensionAPI["getCommands"]> } = {
      commands: [],
    };
    const notices: string[] = [];
    const api = {
      getCommands: () => inventory.commands,
      sendUserMessage: vi.fn<ExtensionAPI["sendUserMessage"]>(),
      registerShortcut: vi.fn((_key, options) => {
        shortcut = options.handler;
      }),
      registerCommand: vi.fn(),
      getThinkingLevel: () => level,
      setThinkingLevel: (next: typeof level) => {
        level = next;
      },
      setModel: vi.fn(async (next) => {
        activeModel = next;
        return true;
      }),
    };
    const pi = api as unknown as ExtensionAPI;
    const custom = vi.fn((factory, options) => {
      expect(options.overlay).toBe(true);
      return new Promise<Action | undefined>((resolve) => {
        finish = resolve;
        palette = factory(
          { requestRender() {}, terminal },
          theme,
          getKeybindings(),
          resolve,
        );
        palette.focused = true;
      });
    });
    const ui = {
      custom,
      theme,
      notify: (text: string) => notices.push(text),
      getToolsExpanded: () => expanded,
      setToolsExpanded: (value: boolean) => {
        expanded = value;
      },
      getAllThemes: () => [{ name: "dark" }, { name: "light" }],
      setTheme: vi.fn(
        (name): ReturnType<ExtensionContext["ui"]["setTheme"]> => {
          activeTheme = name;
          return { success: true };
        },
      ),
      getEditorText: vi.fn(),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
      setEditorComponent: vi.fn(),
    };
    const ctx = {
      cwd: process.cwd(),
      mode: "tui",
      hasUI: true,
      model,
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [model, { ...model, id: "other", name: "Other" }],
      },
      ui,
    } as unknown as ExtensionContext;
    commandPaletteExtension(pi);
    return {
      pi,
      api,
      ui,
      ctx,
      notices,
      custom,
      terminal,
      inventory,
      start: () => shortcut(ctx),
      get palette() {
        return palette;
      },
      get level() {
        return level;
      },
      get expanded() {
        return expanded;
      },
      get activeModel() {
        return activeModel;
      },
      get activeTheme() {
        return activeTheme;
      },
      finish: () => finish(undefined),
      type: (text: string) => {
        for (const char of text) palette.handleInput(char);
      },
      key: (key: string) => palette.handleInput(key),
      text: () => palette.render(76).join("\n"),
      assertNoEditorAccess() {
        for (const method of [
          ui.getEditorText,
          ui.setEditorText,
          ui.pasteToEditor,
          ui.setEditorComponent,
        ]) {
          expect(method).not.toHaveBeenCalled();
        }
      },
    };
  }

  describe("command palette", () => {
    function command(
      name: string,
      source: "extension" | "prompt" | "skill" = "extension",
    ): ReturnType<ExtensionAPI["getCommands"]>[number] {
      return {
        name,
        source,
        description: `description for ${name}`,
        sourceInfo: {
          path: `/commands/${name}`,
          source: "test-package",
          scope: "user",
          origin: "package",
        },
      };
    }

    it.each([false, true])(
      "keeps the other palette invocation after the real resolver qualifies collisions (own first: %s)",
      async (ownFirst) => {
        const { ExtensionRunner, createExtensionRuntime, SessionManager } =
          await import("@earendil-works/pi-coding-agent");
        const h = harness();
        const paths = [
          ownPath,
          resolve(h.ctx.cwd, "packages/extensions/editor/index.ts"),
        ];
        if (!ownFirst) paths.reverse();
        const extensions: ConstructorParameters<typeof ExtensionRunner>[0] =
          paths.map((path) => {
            const sourceInfo = { ...command("palette").sourceInfo, path };
            return {
              path,
              resolvedPath: path,
              sourceInfo,
              handlers: new Map(),
              tools: new Map(),
              messageRenderers: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
              commands: new Map([
                [
                  "palette",
                  { name: "palette", sourceInfo, handler: async () => {} },
                ],
              ]),
            };
          });
        const runner = new ExtensionRunner(
          extensions,
          createExtensionRuntime(),
          h.ctx.cwd,
          SessionManager.inMemory(),
          h.ctx.modelRegistry,
        );
        h.inventory.commands = runner.getRegisteredCommands().map((entry) => ({
          name: entry.invocationName,
          source: "extension",
          sourceInfo: entry.sourceInfo,
        }));
        expect(h.inventory.commands.map((entry) => entry.name)).toEqual([
          "palette:1",
          "palette:2",
        ]);
        const otherName = ownFirst ? "palette:2" : "palette:1";
        const entries = paletteEntries(h.pi, h.ctx).filter((entry) =>
          entry.label.startsWith("/palette"),
        );
        expect(entries.map((entry) => entry.label)).toEqual([`/${otherName}`]);
        const pending = h.start();
        h.type(`/${otherName}`);
        h.key("\r");
        h.key("\r");
        await pending;
        expect(h.api.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
          `/${otherName}`,
          { expandPromptTemplates: true, deliverAs: "followUp" },
        );
        h.assertNoEditorAccess();
      },
    );

    it.each([
      ["\x1b[200~src/a.ts\nsrc/b.ts\x1b[201~"],
      ["\x1b[200~src/a.ts\r\nsrc/b.ts\x1b[201~"],
      ["\x1b[200~src/a.ts", "\r", "\n", "src/b.ts\x1b[20", "1~"],
      ["\x1b[20", "0~src/a.ts\r", "src/b.ts\x1b[201~"],
    ])(
      "preserves paste separators through native StdinBuffer transport %#",
      async (...chunks) => {
        const h = harness();
        h.inventory.commands = [command("review")];
        const pending = h.start();
        h.type("/review");
        h.key("\r");
        const stdin = new StdinBuffer();
        stdin.on("data", (data: string) => h.key(data));
        // Match ProcessTerminal's paste forwarding, not raw stdin chunks.
        stdin.on("paste", (content: string) =>
          h.key(`\x1b[200~${content}\x1b[201~`),
        );
        try {
          for (const chunk of chunks) stdin.process(chunk);
        } finally {
          stdin.destroy();
        }
        expect(h.api.sendUserMessage).not.toHaveBeenCalled();
        expect(stripVTControlCharacters(h.text())).toContain(
          "src/a.ts src/b.ts",
        );
        h.key("\r");
        await pending;
        expect(h.api.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
          "/review src/a.ts src/b.ts",
          { expandPromptTemplates: true, deliverAs: "followUp" },
        );
        h.assertNoEditorAccess();
      },
    );

    it("discovers newly registered commands on each opening and removes stale ones", async () => {
      const h = harness();
      let pending = h.start();
      expect(h.text()).not.toContain("/new-command");
      h.key("\x1b");
      await pending;
      h.inventory.commands = [command("new-command")];
      pending = h.start();
      expect(h.text()).toContain("/new-command");
      expect(h.text()).toContain("extension · description");
      h.key("\x1b");
      await pending;
      h.inventory.commands = [];
      pending = h.start();
      expect(h.text()).not.toContain("/new-command");
      h.key("\x1b");
      await pending;
      h.assertNoEditorAccess();
    });

    it.each(["", 'file.ts "two words" --flag'])(
      "dispatches exact invocation names and arguments (%s) only after closing",
      async (args) => {
        const h = harness();
        h.inventory.commands = [command("review:2")];
        h.ctx.isIdle = () => false;
        const pending = h.start();
        h.type("/review:2");
        h.key("\r");
        expect(h.text()).toContain("/review:2 · arguments");
        expect(h.text()).toContain("runs immediately; may change draft");
        expect(h.text()).toContain(CURSOR_MARKER);
        h.type(args);
        expect(h.api.sendUserMessage).not.toHaveBeenCalled();
        h.key("\r");
        expect(h.api.sendUserMessage).not.toHaveBeenCalled();
        await pending;
        expect(h.api.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
          `/review:2${args ? ` ${args}` : ""}`,
          { expandPromptTemplates: true, deliverAs: "followUp" },
        );
        expect(h.notices).toEqual([]);
        h.assertNoEditorAccess();
      },
    );

    it("cancels argument input back to the search without submitting or accessing editor APIs", async () => {
      const h = harness();
      h.inventory.commands = [command("review")];
      const pending = h.start();
      h.type("/review");
      h.key("\r");
      h.type("discard these args");
      h.key("\x1b");
      expect(h.text()).not.toContain("· arguments");
      expect(stripVTControlCharacters(h.text())).toContain("> /review");
      h.key("\r");
      expect(h.text()).not.toContain("discard these args");
      h.key("\x1b");
      h.key("\x1b");
      await pending;
      expect(h.api.sendUserMessage).not.toHaveBeenCalled();
      h.assertNoEditorAccess();
    });

    it("does not carry argument undo history into another command", async () => {
      const h = harness();
      h.inventory.commands = [command("first"), command("second")];
      const pending = h.start();
      h.type("/first");
      h.key("\r");
      h.type("cancelled private arguments");
      h.key("\x1b");
      h.key("\x15");
      h.type("/second");
      h.key("\r");
      h.key("\x1b[45;5u");
      expect(stripVTControlCharacters(h.text())).toContain(
        "arguments (blank allowed)…",
      );
      expect(h.text()).not.toContain("cancelled private");
      h.key("\r");
      await pending;
      expect(h.api.sendUserMessage).toHaveBeenCalledExactlyOnceWith("/second", {
        expandPromptTemplates: true,
        deliverAs: "followUp",
      });
      h.assertNoEditorAccess();
    });

    it("does not re-read display-only provenance during dispatch", async () => {
      const h = harness();
      const own = command("palette");
      const readOwnPath = vi.fn(() => ownPath);
      Object.defineProperty(own.sourceInfo, "path", { get: readOwnPath });
      h.inventory.commands = [own, command("review")];
      const pending = h.start();
      expect(readOwnPath).toHaveBeenCalledTimes(1);
      h.type("/review");
      h.key("\r");
      h.key("\r");
      await pending;
      expect(readOwnPath).toHaveBeenCalledTimes(1);
      expect(h.api.sendUserMessage).toHaveBeenCalledExactlyOnceWith("/review", {
        expandPromptTemplates: true,
        deliverAs: "followUp",
      });
      h.assertNoEditorAccess();
    });

    it("excludes palette recursion and keeps builtin adapters distinct from discovered names", async () => {
      const h = harness();
      h.inventory.commands = [
        ...[command("palette"), command("palette:1")].map((entry) => ({
          ...entry,
          sourceInfo: { ...entry.sourceInfo, path: ownPath },
        })),
        command("palette", "prompt"),
        command("tools"),
        command("model"),
      ];
      const entries = paletteEntries(h.pi, h.ctx);
      expect(entries.some((entry) => entry.label.startsWith("/palette"))).toBe(
        false,
      );
      expect(entries.find((entry) => entry.value === "tools")).toHaveProperty(
        "run",
      );
      expect(entries.find((entry) => entry.value === "model")).toHaveProperty(
        "children",
      );
      expect(
        entries.find((entry) => entry.value === "command:extension:model"),
      ).toHaveProperty("submit");
      const pending = h.start();
      h.type("/tools");
      h.key("\r");
      h.key("\r");
      await pending;
      expect(h.expanded).toBe(false);
      expect(h.api.sendUserMessage).toHaveBeenCalledWith(
        "/tools",
        expect.any(Object),
      );
      h.assertNoEditorAccess();
    });

    it.each(["prompt", "skill"] as const)(
      "labels %s as a prompt submission and opts into expansion with follow-up delivery",
      async (source) => {
        const h = harness();
        const name = source === "skill" ? "skill:review" : "review-template";
        h.inventory.commands = [command(name, source)];
        // followUp is always explicit, avoiding a race if streaming starts after opening.
        h.ctx.isIdle = () => false;
        const pending = h.start();
        h.type(`/${name}`);
        expect(h.text()).toContain(
          source === "prompt" ? "template prompt" : "skill prompt",
        );
        h.key("\r");
        expect(h.text()).toContain(
          "prompt submission: follow-up while streaming",
        );
        h.type("focus on tests");
        h.key("\r");
        await pending;
        expect(h.api.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
          `/${name} focus on tests`,
          { expandPromptTemplates: true, deliverAs: "followUp" },
        );
        h.assertNoEditorAccess();
      },
    );

    it("does not mislabel a template shadowed by an extension command", () => {
      const h = harness();
      h.inventory.commands = [command("review"), command("review", "prompt")];
      const entries = paletteEntries(h.pi, h.ctx).filter(
        (entry) => entry.label === "/review",
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.description).toContain("extension");
    });

    it("prefers skill expansion over a template with the same skill: invocation", () => {
      const h = harness();
      h.inventory.commands = [
        command("skill:review", "prompt"),
        command("skill:review", "skill"),
      ];
      const entries = paletteEntries(h.pi, h.ctx).filter(
        (entry) => entry.label === "/skill:review",
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.description).toContain("skill prompt");
    });

    it.each(["removed", "replaced", "shadowed"])(
      "rejects a %s command instead of submitting a stale slash prompt",
      async (change) => {
        const h = harness();
        const original = command("review", "prompt");
        h.inventory.commands = [original];
        const pending = h.start();
        h.type("/review");
        h.key("\r");
        h.inventory.commands =
          change === "removed"
            ? []
            : change === "shadowed"
              ? [command("review"), original]
              : [
                  {
                    ...original,
                    sourceInfo: {
                      ...original.sourceInfo,
                      path: "/replacement.md",
                    },
                  },
                ];
        h.key("\r");
        await pending;
        expect(h.api.sendUserMessage).not.toHaveBeenCalled();
        expect(h.notices[0]).toContain("changed or is no longer available");
        h.assertNoEditorAccess();
      },
    );

    it("blocks argument submission when the terminal becomes too short", async () => {
      const h = harness();
      h.inventory.commands = [command("review")];
      const pending = h.start();
      h.type("/review");
      h.key("\r");
      h.type("args");
      h.terminal.rows = 3;
      h.key("\r");
      await Promise.resolve();
      expect(h.api.sendUserMessage).not.toHaveBeenCalled();
      h.key("\x1b");
      h.key("\x1b");
      await pending;
      h.assertNoEditorAccess();
    });

    it("keeps the selected row within the overlay at 80x12 and across resizes", async () => {
      const h = harness();
      h.terminal.rows = 12;
      h.ctx.modelRegistry.getAvailable = () =>
        Array.from({ length: 12 }, (_, i) => ({ ...model, id: `model-${i}` }));
      const pending = h.start();
      h.type("model");
      h.key("\r");
      for (let i = 0; i < 12; i++) {
        const lines = h.palette.render(76);
        expect(lines.length).toBeLessThanOrEqual(
          Math.floor(h.terminal.rows * 0.8),
        );
        expect(lines.join("\n")).toContain(`→ model-${i} `);
        if (i < 11) h.key("\x1b[B");
      }
      h.terminal.rows = 30;
      const tall = h.palette.render(76);
      expect(tall.join("\n")).toContain("→ model-11");
      expect(tall.length).toBeGreaterThan(9);
      h.terminal.rows = 12;
      expect(h.palette.render(76).length).toBeLessThanOrEqual(9);
      expect(h.text()).toContain("→ model-11");
      h.key("\r");
      await pending;
      expect(h.activeModel.id).toBe("model-11");
      h.assertNoEditorAccess();
    });

    it("blocks confirmation when a resize leaves no room for an action, even before rendering", async () => {
      const h = harness();
      const pending = h.start();
      h.type("tools");
      expect(h.text()).toContain("→ expand tool output");
      for (const rows of [10, 8, 3, 1]) {
        h.terminal.rows = rows;
        h.key("\r");
        await Promise.resolve();
        expect(h.expanded).toBe(false);
        const lines = h.palette.render(76);
        expect(lines.length).toBeLessThanOrEqual(
          Math.max(1, Math.floor(rows * 0.8)),
        );
        expect(lines.join("\n")).toContain("resize terminal");
        expect(lines.join("\n")).not.toContain("→");
      }
      h.key("\x1b");
      await pending;
      h.assertNoEditorAccess();
    });

    it("distinguishes gateway model ids with identical names and shows the current marker", async () => {
      const h = harness();
      const base = {
        ...model,
        provider: "vercel-ai-gateway",
        name: "GPT 5.2",
        id: "openai/gpt-5.2",
      };
      const pro = { ...base, id: "openai/gpt-5.2-pro" };
      h.ctx.model = pro;
      h.ctx.scopedModels = [{ model: base }, { model: pro }];
      const pending = h.start();
      h.type("model");
      h.key("\r");
      expect(h.text()).toContain("→ openai/gpt-5.2 ");
      expect(h.text()).toContain("✓ openai/gpt-5.2-pro");
      expect(h.text()).toContain("vercel-ai-gateway");
      h.key("\x1b[B");
      expect(h.text()).toContain("→ ✓ openai/gpt-5.2-pro");
      h.key("\r");
      await pending;
      expect(h.activeModel.id).toBe(pro.id);
    });

    it("retains long model suffixes and the current marker with bounded middle truncation", async () => {
      const h = harness();
      const long = { ...model, id: `${"shared-prefix-".repeat(8)}gpt-5.2-pro` };
      h.ctx.model = long;
      h.ctx.scopedModels = [{ model: long }];
      const pending = h.start();
      h.type("model");
      h.key("\r");
      const lines = h.palette.render(40);
      const selected = lines.find((line) => line.startsWith("→"))!;
      expect(selected).toContain("→ ✓ shared");
      expect(selected).toContain("…");
      expect(selected).toContain("gpt-5.2-pro");
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
      h.key("\x1b");
      h.key("\x1b");
      await pending;
    });

    it("registers the shortcut and slash fallback", () => {
      const h = harness();
      expect(h.api.registerShortcut).toHaveBeenCalledWith(
        "ctrl+shift+p",
        expect.any(Object),
      );
      expect(h.api.registerCommand).toHaveBeenCalledWith(
        "palette",
        expect.any(Object),
      );
    });

    it("searches, enters thinking, returns to the root query, and cancels without accessing editor APIs", async () => {
      const h = harness();
      const pending = h.start();
      expect(h.text()).toContain("thinking level…");
      expect(h.text()).toContain("expand tool output");
      h.type("THINK");
      expect(h.text()).not.toContain("expand tool output");
      h.key("\r");
      expect(h.text()).toContain("command palette › thinking level");
      expect(h.text()).toContain("high ✓");
      expect(h.text()).toContain("max");
      expect(h.text()).not.toContain("minimal");
      h.key("\x1b");
      expect(h.text()).not.toContain("› thinking");
      expect(stripVTControlCharacters(h.text())).toContain("THINK");
      h.key("\x1b");
      await pending;
      expect(h.level).toBe("high");
      expect(h.notices).toEqual([]);
      h.assertNoEditorAccess();
    });

    it("applies a supported thinking level only after closing the overlay", async () => {
      const h = harness();
      const pending = h.start();
      h.key("\r");
      h.type("max");
      h.key("\r");
      expect(h.level).toBe("high");
      await pending;
      expect(h.level).toBe("max");
      h.assertNoEditorAccess();
    });

    it("supports arrow selection and a display toggle without editor access", async () => {
      const h = harness();
      const pending = h.start();
      h.key("\x1b[B");
      h.key("\x1b[B");
      expect(h.text()).toContain("→ expand tool output");
      h.key("\r");
      await pending;
      expect(h.expanded).toBe(true);
      h.assertNoEditorAccess();
    });

    it("shows only off for non-reasoning models and handles no current model", () => {
      const h = harness();
      for (const current of [{ ...model, reasoning: false }, undefined]) {
        h.ctx.model = current;
        const entry = paletteEntries(h.pi, h.ctx)[0]!;
        expect(
          "children" in entry && entry.children.map((child) => child.value),
        ).toEqual(["off"]);
      }
    });

    it("uses scoped models and their pinned thinking levels", async () => {
      const h = harness();
      h.ctx.scopedModels = [
        { model: { ...model, id: "scoped" }, thinkingLevel: "max" },
      ];
      const pending = h.start();
      h.type("model");
      h.key("\r");
      expect(h.text()).toContain("→ scoped");
      expect(h.text()).not.toContain("other");
      h.key("\r");
      await pending;
      expect(h.activeModel.id).toBe("scoped");
      expect(h.level).toBe("max");
      h.assertNoEditorAccess();
    });

    it("searches available models by provider/id and name when there is no scope", async () => {
      const h = harness();
      const pending = h.start();
      h.type("model");
      h.key("\r");
      h.type("TEST Other");
      expect(h.text()).toContain("→ other");
      expect(h.text()).not.toContain("reasoner");
      h.key("\r");
      await pending;
      expect(h.activeModel.id).toBe("other");
      expect(h.level).toBe("high");
      h.assertNoEditorAccess();
    });

    it.each(["auth", "throw"])(
      "reports model rejection (%s) without applying the pinned level",
      async (failure) => {
        const h = harness();
        h.ctx.scopedModels = [{ model, thinkingLevel: "max" }];
        if (failure === "auth")
          vi.mocked(h.api.setModel).mockResolvedValue(false);
        else
          vi.mocked(h.api.setModel).mockRejectedValue(
            new Error("model switch rejected"),
          );
        const pending = h.start();
        h.type("model");
        h.key("\r");
        h.key("\r");
        await pending;
        expect(h.level).toBe("high");
        expect(h.notices[0]).toContain(
          failure === "auth" ? "no authentication" : "model switch rejected",
        );
        h.assertNoEditorAccess();
        const retry = h.start();
        h.key("\x1b");
        await retry;
        expect(h.custom).toHaveBeenCalledTimes(2);
      },
    );

    it("handles empty matches and empty catalogs without executing anything", async () => {
      const h = harness();
      h.ctx.modelRegistry.getAvailable = () => [];
      const pending = h.start();
      h.type("model");
      h.key("\r");
      expect(h.text()).toContain("No matching commands");
      h.type("missing");
      h.key("\r");
      expect(h.api.setModel).not.toHaveBeenCalled();
      h.key("\x1b");
      h.key("\x1b");
      await pending;
      h.assertNoEditorAccess();
    });

    it.each([true, false])(
      "selects themes and reports rejected themes (success: %s)",
      async (success) => {
        const h = harness();
        if (!success)
          vi.mocked(h.ui.setTheme).mockReturnValue({
            success,
            error: "invalid theme",
          });
        const pending = h.start();
        h.type("theme");
        h.key("\r");
        h.type("light");
        h.key("\r");
        await pending;
        expect(h.ui.setTheme).toHaveBeenCalledWith("light");
        expect(h.activeTheme).toBe(success ? "light" : "dark");
        expect(h.notices).toEqual(
          success ? [] : ["command palette: invalid theme"],
        );
        h.assertNoEditorAccess();
      },
    );

    it("forwards focus for IME and bounds every rendered line, including empty search results", async () => {
      const h = harness();
      const pending = h.start();
      expect(h.text()).toContain(CURSOR_MARKER);
      h.palette.focused = false;
      expect(h.text()).not.toContain(CURSOR_MARKER);
      h.palette.focused = true;
      for (const query of ["", "不存在".repeat(40)]) {
        h.type(query);
        h.palette.invalidate();
        for (const width of [0, 1, 2, 4, 10, 20, 40, 76]) {
          expect(
            h.palette
              .render(width)
              .every((line) => visibleWidth(line) <= width),
          ).toBe(true);
        }
      }
      h.key("\x1b");
      await pending;
    });

    it("ignores reentrant opens and releases its guard after cancel and UI failure", async () => {
      const h = harness();
      const first = h.start();
      await h.start();
      expect(h.custom).toHaveBeenCalledTimes(1);
      h.finish();
      await first;
      h.custom.mockRejectedValueOnce(new Error("overlay unavailable"));
      await h.start();
      expect(h.notices).toEqual(["command palette: overlay unavailable"]);
      const last = h.start();
      h.finish();
      await last;
      expect(h.custom).toHaveBeenCalledTimes(3);
      h.assertNoEditorAccess();
    });

    it.each(["rpc", "json", "print"] as const)(
      "does not open a TUI overlay in %s mode",
      async (mode) => {
        const h = harness();
        h.ctx.mode = mode;
        await h.start();
        expect(h.custom).not.toHaveBeenCalled();
        h.assertNoEditorAccess();
      },
    );
  });
}
