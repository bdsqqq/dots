import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@mariozechner/pi-tui";

const MAX_SUGGESTIONS = 20;
const STATUS_VALUE_PREFIX = "__zmx_status__:";
const ZMX_TOKEN = /(?:^|[ \t])@zmx\/([^\s@]*)$/;

export interface ZmxSession {
  name: string;
  clients: string;
  pid: string;
  created?: string;
  startDir: string;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

type ExecZmx = (command: string, args: readonly string[]) => Promise<ExecResult>;

type LoadZmxSessionsResult =
  | { status: "ok"; sessions: ZmxSession[] }
  | { status: "unavailable" }
  | { status: "empty" };

function extractZmxFragment(textBeforeCursor: string): string | undefined {
  return textBeforeCursor.match(ZMX_TOKEN)?.[1];
}

function parseKeyValueFields(line: string): ZmxSession | undefined {
  const fields = new Map<string, string>();
  for (const field of line.split("\t")) {
    const index = field.indexOf("=");
    if (index === -1) continue;
    fields.set(field.slice(0, index), field.slice(index + 1));
  }

  const name = fields.get("name") ?? fields.get("session_name");
  if (!name) return undefined;

  return {
    name,
    clients: fields.get("clients") ?? "?",
    pid: fields.get("pid") ?? "?",
    created: fields.get("created"),
    startDir: fields.get("start_dir") ?? fields.get("started_in") ?? "",
  };
}

function parseRowsFields(line: string): ZmxSession | undefined {
  const [name, clientsField, pidField, createdField, startDir = ""] =
    line.split("\t");
  if (!name) return undefined;

  return {
    name,
    clients: clientsField?.replace(/^clients:/, "") || "?",
    pid: pidField?.replace(/^pid:/, "") || "?",
    created: createdField?.replace(/^created:/, ""),
    startDir,
  };
}

export function parseZmxSessions(output: string): ZmxSession[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line.includes("=") ? parseKeyValueFields(line) : parseRowsFields(line),
    )
    .filter((session): session is ZmxSession => Boolean(session?.name));
}

function formatSessionItem(session: ZmxSession): AutocompleteItem {
  return {
    value: `zmx session ${session.name}`,
    label: `@zmx/${session.name}`,
    description: `clients:${session.clients} pid:${session.pid} ${session.startDir}`,
  };
}

export function filterZmxSessions(
  sessions: ZmxSession[],
  fragment: string,
): AutocompleteItem[] {
  const sorted = [...sessions].sort((a, b) => a.name.localeCompare(b.name));
  const query = fragment.toLowerCase();

  const matches = query
    ? sorted.filter((session) => session.name.toLowerCase().startsWith(query))
    : sorted;

  return matches.slice(0, MAX_SUGGESTIONS).map(formatSessionItem);
}

function formatStatusItem(fragment: string, message: string): AutocompleteItem {
  return {
    value: `${STATUS_VALUE_PREFIX}${fragment}`,
    label: `@zmx/${fragment}`,
    description: message,
  };
}

async function loadZmxSessions(execZmx: ExecZmx): Promise<LoadZmxSessionsResult> {
  let sawSuccessfulCommand = false;

  for (const [command, args] of [
    ["zmx-rows", []],
    ["zmx", ["list"]],
  ] as const) {
    try {
      const result = await execZmx(command, args);
      if (result.code !== 0) continue;

      sawSuccessfulCommand = true;
      const sessions = parseZmxSessions(result.stdout);
      if (sessions.length > 0) return { status: "ok", sessions };
    } catch {
      continue;
    }
  }

  return sawSuccessfulCommand ? { status: "empty" } : { status: "unavailable" };
}

export function createZmxAutocompleteProvider(
  current: AutocompleteProvider,
  execZmx: ExecZmx,
): AutocompleteProvider {
  return {
    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const fragment = extractZmxFragment(beforeCursor);
      if (fragment === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      if (options.signal.aborted) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const result = await loadZmxSessions(execZmx);
      if (options.signal.aborted) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      if (result.status !== "ok") {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const items = filterZmxSessions(result.sessions, fragment);
      return {
        prefix: `@zmx/${fragment}`,
        items:
          items.length > 0
            ? items
            : [formatStatusItem(fragment, `no zmx sessions match "${fragment}"`)],
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (item.value.startsWith(STATUS_VALUE_PREFIX)) {
        return { lines, cursorLine, cursorCol };
      }

      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
      );
    },
  };
}

export default function zmxExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.addAutocompleteProvider((current) =>
      createZmxAutocompleteProvider(current, (command, args) =>
        pi.exec(command, [...args], { cwd: ctx.cwd, timeout: 2_000 }),
      ),
    );
  });
}

if (import.meta.vitest) {
  const { describe, expect, it, vi } = import.meta.vitest;

  function baseProvider(): AutocompleteProvider {
    return {
      getSuggestions: vi.fn().mockResolvedValue({
        prefix: "base",
        items: [{ value: "base" }],
      }),
      applyCompletion: vi.fn((lines) => ({ lines, cursorLine: 0, cursorCol: 0 })),
    };
  }

  describe("parseZmxSessions", () => {
    it("parses zmx-rows output", () => {
      expect(
        parseZmxSessions(
          "nix.build\tclients:0\tpid:123\tcreated:1770000000\t/Users/bdsqqq/commonplace\n",
        ),
      ).toEqual([
        {
          name: "nix.build",
          clients: "0",
          pid: "123",
          created: "1770000000",
          startDir: "/Users/bdsqqq/commonplace",
        },
      ]);
    });

    it("parses both zmx list key variants", () => {
      expect(
        parseZmxSessions(
          "name=nix.build\tpid=123\tclients=0\tcreated=177\tstart_dir=/repo\n" +
            "session_name=nix.yazi\tpid=456\tclients=1\tcreated=178\tstarted_in=/tmp\n",
        ),
      ).toEqual([
        {
          name: "nix.build",
          clients: "0",
          pid: "123",
          created: "177",
          startDir: "/repo",
        },
        {
          name: "nix.yazi",
          clients: "1",
          pid: "456",
          created: "178",
          startDir: "/tmp",
        },
      ]);
    });
  });

  describe("filterZmxSessions", () => {
    it("sorts names and prefers prefix matches", () => {
      expect(
        filterZmxSessions(
          [
            { name: "nix.yazi", clients: "0", pid: "1", startDir: "/" },
            { name: "nix", clients: "0", pid: "2", startDir: "/" },
            { name: "nix.build", clients: "0", pid: "3", startDir: "/" },
          ],
          "nix",
        ).map((item) => item.label),
      ).toEqual(["@zmx/nix", "@zmx/nix.build", "@zmx/nix.yazi"]);
    });
  });

  describe("createZmxAutocompleteProvider", () => {
    it("returns zmx completions with a full mention prefix", async () => {
      const current = baseProvider();
      const provider = createZmxAutocompleteProvider(current, vi.fn().mockResolvedValue({
        code: 0,
        stdout: "nix.build\tclients:0\tpid:123\tcreated:177\t/repo\n",
        stderr: "",
      }));

      await expect(
        provider.getSuggestions(["the build in @zmx/ni"], 0, 22, {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        prefix: "@zmx/ni",
        items: [
          {
            value: "zmx session nix.build",
            label: "@zmx/nix.build",
            description: "clients:0 pid:123 /repo",
          },
        ],
      });
      expect(current.getSuggestions).not.toHaveBeenCalled();
    });

    it("delegates silently when zmx commands fail", async () => {
      const current = baseProvider();
      const provider = createZmxAutocompleteProvider(
        current,
        vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "missing" }),
      );

      await expect(
        provider.getSuggestions(["@zmx/ni"], 0, 7, {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ prefix: "base", items: [{ value: "base" }] });
      expect(current.getSuggestions).toHaveBeenCalledTimes(1);
    });

    it("shows a status completion when no sessions match", async () => {
      const current = baseProvider();
      const provider = createZmxAutocompleteProvider(current, vi.fn().mockResolvedValue({
        code: 0,
        stdout: "nix.build\tclients:0\tpid:123\tcreated:177\t/repo\n",
        stderr: "",
      }));

      await expect(
        provider.getSuggestions(["@zmx/web"], 0, 8, {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        prefix: "@zmx/web",
        items: [
          {
            value: "__zmx_status__:web",
            label: "@zmx/web",
            description: 'no zmx sessions match "web"',
          },
        ],
      });
      expect(current.getSuggestions).not.toHaveBeenCalled();
    });

    it("leaves editor state unchanged when applying a status completion", () => {
      const current = baseProvider();
      const provider = createZmxAutocompleteProvider(current, vi.fn());
      const lines = ["check @zmx/web"];

      expect(
        provider.applyCompletion(
          lines,
          0,
          14,
          { value: "__zmx_status__:web", label: "@zmx/web" },
          "@zmx/web",
        ),
      ).toEqual({ lines, cursorLine: 0, cursorCol: 14 });
      expect(current.applyCompletion).not.toHaveBeenCalled();
    });
  });
}
