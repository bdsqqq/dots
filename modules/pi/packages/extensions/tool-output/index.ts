import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ToolCall } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

type PersistedOutput = {
  call: ToolCall | null;
  callEntry: SessionMessageEntry | null;
  resultEntry: SessionMessageEntry & {
    message: Extract<SessionMessageEntry["message"], { role: "toolResult" }>;
  };
};

/** Raw branch entries, not the compacted/model-visible projection or nested-call metadata. */
export function collectToolOutputs(
  branch: readonly SessionEntry[],
): PersistedOutput[] {
  const calls = new Map<
    string,
    { call: ToolCall; entry: SessionMessageEntry }
  >();
  const outputs: PersistedOutput[] = [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      for (const call of entry.message.content) {
        if (call.type === "toolCall") calls.set(call.id, { call, entry });
      }
    } else if (entry.message.role === "toolResult") {
      const original = calls.get(entry.message.toolCallId);
      outputs.push({
        call: original?.call ?? null,
        callEntry: original?.entry ?? null,
        resultEntry: { ...entry, message: entry.message },
      });
    }
  }
  return outputs.reverse();
}

function labelText(text: string, limit = 80): string {
  const plain = text.replace(/[\p{C}\s]+/gu, " ").trim();
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
}

function outputLabel(output: PersistedOutput, index: number): string {
  const { message, timestamp } = output.resultEntry;
  return `${index + 1}. ${labelText(message.toolName)} · ${message.isError ? "error" : "ok"} · ${labelText(timestamp)} · ${labelText(message.toolCallId)}`;
}

/**
 * User-invoked only: results may contain secrets/images. Keep exports private,
 * outside the repo, until the user or OS removes them; never export on render/load.
 * This preserves stored JSON, not output discarded at execution or a full child transcript.
 */
async function exportOutput(output: PersistedOutput): Promise<string> {
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-output-"));
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "persisted-result.json");
    await writeFile(path, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return path;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function spillNotice(output: PersistedOutput): Promise<string> {
  const details: unknown = output.resultEntry.message.details;
  if (!details || typeof details !== "object" || !("fullOutputPath" in details))
    return "";
  const path = details.fullOutputPath;
  if (typeof path !== "string" || !path) return "";
  // Only inspect local absolute file metadata; never read/open output or follow a relative cwd guess.
  let available = false;
  if (isAbsolute(path)) {
    try {
      available = (await stat(path)).isFile();
    } catch {
      // A persisted path may outlive its execution-time spill file.
    }
  }
  return `\nExecution spill file ${available ? "available" : "unavailable (stale, inaccessible, or not an absolute file)"}: ${JSON.stringify(path)}`;
}

export default function toolOutput(pi: ExtensionAPI): void {
  pi.registerCommand("tool-output", {
    description:
      "Export a persisted raw tool result from this branch: /tool-output [tool-call-id]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI)
        throw new Error(
          "/tool-output requires notification-capable UI (TUI or RPC); no file written.",
        );
      const id = args.trim();
      if (!id && ctx.mode !== "tui") {
        ctx.ui.notify(
          "/tool-output selection requires TUI; supply an exact tool-call-id in RPC. No file written.",
          "error",
        );
        return;
      }
      const outputs = collectToolOutputs(ctx.sessionManager.getBranch());
      if (!outputs.length) {
        ctx.ui.notify(
          "No persisted tool results on the active branch. No file written.",
          "info",
        );
        return;
      }
      let selected: PersistedOutput | undefined;
      if (id) {
        const matches = outputs.filter(
          (output) => output.resultEntry.message.toolCallId === id,
        );
        if (matches.length !== 1) {
          ctx.ui.notify(
            matches.length
              ? "Ambiguous tool-call-id on the active branch; use /tool-output to select a result. No file written."
              : "No persisted result with that exact tool-call-id on the active branch. No file written.",
            "error",
          );
          return;
        }
        selected = matches[0];
      } else {
        const labels = outputs.map(outputLabel);
        const choice = await ctx.ui.select(
          "Persisted tool results · active branch · newest first",
          labels,
        );
        if (choice === undefined) return;
        selected = outputs[labels.indexOf(choice)];
      }
      if (!selected) return;
      try {
        const spill = await spillNotice(selected);
        const path = await exportOutput(selected);
        ctx.ui.notify(
          `PERSISTED RAW RESULT: ${path}\nStored call + result only; not a full child transcript. Cannot recover execution output missing due to truncation.${selected.call ? "" : "\nOriginal assistant tool call unavailable on this branch (call: null)."}${spill}\nPrivate temporary copy; retained until you or the OS remove it.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Could not export persisted result: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach, vi } = import.meta
    .vitest;
  const fs = await import("node:fs/promises");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { fauxAssistantMessage, fauxToolCall } =
    await import("@earendil-works/pi-ai");
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  type Context = Parameters<Command["handler"]>[1];
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "pi-tool-output-test-"));
    vi.stubEnv("TMPDIR", root);
    vi.stubEnv("TMP", root);
    vi.stubEnv("TEMP", root);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  function harness(
    manager = SessionManager.inMemory(root),
    choice: number | null = 0,
  ) {
    let command!: Command;
    toolOutput({
      registerCommand(name, registered) {
        expect(name).toBe("tool-output");
        command = registered;
      },
    } as ExtensionAPI);
    const notices: string[] = [];
    const options: string[][] = [];
    const ctx = {
      mode: "tui",
      hasUI: true,
      sessionManager: manager,
      ui: {
        notify(text: string) {
          notices.push(text);
        },
        async select(_title: string, labels: string[]) {
          options.push(labels);
          return choice === null ? undefined : labels[choice];
        },
      },
    } as unknown as Context;
    return { command, ctx, notices, options, manager };
  }
  function fixture(
    manager: ReturnType<typeof SessionManager.inMemory>,
    id = "call-raw",
    spill?: string,
  ) {
    const call = fauxToolCall("codemode", {
      code: "return { route: 'original' };",
    });
    call.id = id;
    const assistant = fauxAssistantMessage(call, { stopReason: "toolUse" });
    manager.appendMessage(assistant);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "codemode",
      isError: true,
      content: [
        {
          type: "text",
          text: `${"hidden sentinel ".repeat(12000)}END-ORIGINAL`,
        },
        { type: "image", data: "original-base64", mimeType: "image/png" },
      ],
      details: {
        route: "original",
        errors: ["original error"],
        ...(spill ? { fullOutputPath: spill } : {}),
      },
      nestedCalls: {
        calls: [
          { id: `${id}/1`, name: "read", status: "error", error: "original" },
        ],
        complete: false,
      },
      usage: assistant.usage,
      timestamp: 1,
    });
    const branch = manager.getBranch();
    return { call, callEntry: branch.at(-2), resultEntry: branch.at(-1) };
  }
  async function artifacts() {
    return (await fs.readdir(root)).filter((name) =>
      name.startsWith("pi-tool-output-"),
    );
  }
  async function exported(h: ReturnType<typeof harness>) {
    const notice = h.notices.find((text) =>
      text.startsWith("PERSISTED RAW RESULT: "),
    )!;
    expect(notice).toBeDefined();
    const path = notice.split("\n")[0]!.slice("PERSISTED RAW RESULT: ".length);
    return { path, value: JSON.parse(await fs.readFile(path, "utf8")) };
  }

  describe("/tool-output", () => {
    it("registers without writes and exports exact original JSON, not a rendered preview, privately on demand", async () => {
      const h = harness();
      const original = fixture(h.manager);
      const before = JSON.stringify(h.manager.getBranch());
      const leaf = h.manager.getLeafId();
      expect(await artifacts()).toEqual([]);
      await h.command.handler("call-raw", h.ctx);
      const first = await exported(h);
      expect(first.value).toEqual(JSON.parse(JSON.stringify(original)));
      expect(first.value.resultEntry.message.content[0].text).toContain(
        "END-ORIGINAL",
      );
      if (process.platform !== "win32") {
        expect((await fs.stat(first.path)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(join(first.path, ".."))).mode & 0o777).toBe(
          0o700,
        );
      }
      expect(h.options).toEqual([]);
      h.notices.length = 0;
      await h.command.handler("call-raw", h.ctx);
      expect((await exported(h)).path).not.toBe(first.path);
      expect(JSON.stringify(h.manager.getBranch())).toBe(before);
      expect(h.manager.getLeafId()).toBe(leaf);
      expect(h.notices.join()).toContain("not a full child transcript");
    });
    it("uses the native picker, newest first, and excludes sibling branches", async () => {
      const h = harness(undefined, 1);
      fixture(h.manager, "common");
      const commonLeaf = h.manager.getLeafId()!;
      fixture(h.manager, "sibling");
      h.manager.branch(commonLeaf);
      fixture(h.manager, "recent");
      await h.command.handler("", h.ctx);
      expect(h.options[0]).toHaveLength(2);
      expect(h.options[0]![0]).toContain("recent");
      expect(h.options[0]![0]).toContain("codemode · error");
      expect(h.options[0]!.join()).not.toContain("sibling");
      expect((await exported(h)).value.call.id).toBe("common");
    });
    it("cancels, rejects unknown/prefix ids and an empty branch without writes", async () => {
      const h = harness(undefined, null);
      await h.command.handler("", h.ctx);
      expect(h.notices.join()).toContain("No persisted tool results");
      fixture(h.manager);
      await h.command.handler("missing", h.ctx);
      await h.command.handler("call", h.ctx);
      await h.command.handler("", h.ctx);
      expect(await artifacts()).toEqual([]);
      expect(h.notices.join()).toContain("exact tool-call-id");
    });
    it("keeps orphan results honest and rejects ambiguous or nested ids without guessing", async () => {
      const h = harness();
      const result = fixture(h.manager).resultEntry!;
      h.manager.resetLeaf();
      if (result.type !== "message" || result.message.role !== "toolResult")
        throw new Error("expected result fixture");
      h.manager.appendMessage(result.message);
      await h.command.handler("call-raw", h.ctx);
      expect((await exported(h)).value).toMatchObject({
        call: null,
        callEntry: null,
      });
      expect(h.notices.join()).toContain(
        "Original assistant tool call unavailable",
      );
      const count = (await artifacts()).length;
      h.notices.length = 0;
      await h.command.handler("call-raw/1", h.ctx);
      expect(h.notices.join()).toContain("exact tool-call-id");
      fixture(h.manager);
      h.notices.length = 0;
      await h.command.handler("call-raw", h.ctx);
      expect(h.notices.join()).toContain("Ambiguous tool-call-id");
      expect(await artifacts()).toHaveLength(count);
    });
    it("reports existing and stale spill paths separately, without copying their contents", async () => {
      const path = join(root, "spill.txt");
      await fs.writeFile(path, "SPILL-ONLY-CONTENT");
      const h = harness();
      fixture(h.manager, "available", path);
      fixture(h.manager, "stale", join(root, "missing.txt"));
      await h.command.handler("available", h.ctx);
      const first = await exported(h);
      expect(h.notices.join()).toContain(
        `Execution spill file available: ${JSON.stringify(path)}`,
      );
      expect(await fs.readFile(first.path, "utf8")).not.toContain(
        "SPILL-ONLY-CONTENT",
      );
      h.notices.length = 0;
      await h.command.handler("stale", h.ctx);
      expect(h.notices.join()).toContain("Execution spill file unavailable");
      expect(h.notices.join()).toContain(
        "Cannot recover execution output missing due to truncation",
      );
    });
    it("never invokes a selector in RPC/print; explicit RPC ids can export", async () => {
      const h = harness();
      fixture(h.manager);
      h.ctx.mode = "rpc";
      await h.command.handler("", h.ctx);
      expect(h.options).toEqual([]);
      expect(await artifacts()).toEqual([]);
      await h.command.handler("call-raw", h.ctx);
      expect((await exported(h)).value.call.id).toBe("call-raw");
      h.ctx.mode = "print";
      h.ctx.hasUI = false;
      await expect(h.command.handler("call-raw", h.ctx)).rejects.toThrow(
        "no file written",
      );
      expect(await artifacts()).toHaveLength(1);
    });
  });
}
