/**
 * tests for github tools — helpers + integration via pi spawn.
 *
 * two layers:
 *
 * 1. unit tests for lib/github.ts (parseRepoUrl, ghApi, etc.)
 *    — no pi deps, no AI, runs directly with bun.
 *
 * 2. integration tests for the 7 github tools via pi spawn.
 *    — spawns `pi --mode json` asking it to call specific tools.
 *    — guarded by PI_E2E=1 (costs real API calls + AI tokens).
 *    — validates the full flow: model → tool call → gh api → result.
 *
 * the unit tests prove the plumbing works. the integration tests
 * prove the tools register, execute, and return correct results
 * inside pi's runtime where @mariozechner/pi-tui is available.
 *
 * usage:
 *   bun test user/pi/extensions/tools/github.test.ts          # unit only
 *   PI_E2E=1 bun test user/pi/extensions/tools/github.test.ts # all
 */

import { spawn as nodeSpawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "bun:test";
import {
  parseRepoUrl,
  repoSlug,
  ghApi,
  decodeBase64Content,
  addLineNumbers,
  truncate,
} from "./lib/github";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CWD = process.env.PI_E2E_CWD ?? resolve(__dirname, "../../../..");
const ENABLED = process.env.PI_E2E === "1";

// --- shared pi runner (same as e2e.test.ts) ---

interface PiEvent {
  type: string;
  [key: string]: any;
}
interface PiResult {
  events: PiEvent[];
  exitCode: number;
  stderr: string;
}

function runPi(prompt: string, opts?: { timeout?: number }): Promise<PiResult> {
  const timeout = opts?.timeout ?? 120_000;
  return new Promise((resolve, reject) => {
    const events: PiEvent[] = [];
    let stderr = "";
    let buffer = "";
    const proc = nodeSpawn(
      "pi",
      ["--mode", "json", "-p", "--no-session", prompt],
      {
        cwd: CWD,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
      reject(new Error(`pi timed out after ${timeout}ms`));
    }, timeout);
    proc.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
    });
    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) {
        try {
          events.push(JSON.parse(buffer));
        } catch {}
      }
      resolve({ events, exitCode: code ?? 1, stderr });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function getToolCalls(events: PiEvent[]) {
  const calls: { name: string; args: any }[] = [];
  for (const e of events) {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      for (const part of e.message.content ?? []) {
        if (part.type === "toolCall")
          calls.push({ name: part.name, args: part.arguments ?? {} });
      }
    }
  }
  return calls;
}

function getToolResults(events: PiEvent[]) {
  const results: { toolName: string; content: string; isError: boolean }[] = [];
  for (const e of events) {
    if (e.type === "tool_execution_end") {
      const r = e.result ?? {};
      const text =
        (r.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
      results.push({
        toolName: e.toolName,
        content: text,
        isError: r.isError === true,
      });
    }
  }
  return results;
}

// ============================================================
// layer 1: unit tests for lib/github.ts — no pi deps, no cost
// ============================================================

describe("lib/github.ts", () => {
  describe("parseRepoUrl", () => {
    it("parses full https URL", () => {
      expect(parseRepoUrl("https://github.com/owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses URL without protocol", () => {
      expect(parseRepoUrl("github.com/owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses shorthand owner/repo", () => {
      expect(parseRepoUrl("owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("strips trailing .git", () => {
      expect(parseRepoUrl("https://github.com/owner/repo.git")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("strips trailing slash", () => {
      expect(parseRepoUrl("https://github.com/owner/repo/")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("throws on invalid input", () => {
      expect(() => parseRepoUrl("just-a-name")).toThrow(/invalid repository/);
    });
  });

  describe("repoSlug", () => {
    it("returns owner/repo", () => {
      expect(repoSlug({ owner: "a", repo: "b" })).toBe("a/b");
    });
  });

  describe("decodeBase64Content", () => {
    it("decodes base64 with embedded newlines", () => {
      const encoded = Buffer.from("hello world").toString("base64");
      const withNewlines = encoded.slice(0, 4) + "\n" + encoded.slice(4);
      expect(decodeBase64Content(withNewlines)).toBe("hello world");
    });
  });

  describe("addLineNumbers", () => {
    it("numbers from 1 by default", () => {
      expect(addLineNumbers("a\nb\nc")).toBe("1: a\n2: b\n3: c");
    });

    it("numbers from custom start", () => {
      expect(addLineNumbers("x\ny", 10)).toBe("10: x\n11: y");
    });
  });

  describe("truncate", () => {
    it("returns short strings unchanged", () => {
      expect(truncate("hello", 100)).toBe("hello");
    });

    it("truncates with indicator", () => {
      const result = truncate("a".repeat(200), 50);
      expect(result.length).toBeLessThan(200);
      expect(result).toContain("truncated");
      expect(result).toContain("200 total characters");
    });
  });
});

// ============================================================
// layer 1b: gh api integration (no pi deps, but hits real API)
// ============================================================

describe("ghApi", () => {
  it("fetches repo info", () => {
    const data = ghApi("repos/bdsqqq/dots");
    expect(data.full_name).toBe("bdsqqq/dots");
    expect(data.default_branch).toBeTruthy();
  });

  it("passes query params correctly", () => {
    const data = ghApi("repos/bdsqqq/dots/commits", {
      params: { per_page: 1 },
    });
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
  });

  it("reads file contents via contents API", () => {
    const data = ghApi("repos/bdsqqq/dots/contents/flake.nix");
    expect(data.type).toBe("file");
    expect(data.content).toBeTruthy();
    const decoded = decodeBase64Content(data.content);
    expect(decoded).toContain("description");
  });

  it("lists directory via contents API", () => {
    const data = ghApi("repos/bdsqqq/dots/contents/");
    expect(Array.isArray(data)).toBe(true);
    const names = data.map((e: any) => e.name);
    expect(names).toContain("flake.nix");
  });

  it("searches code", () => {
    const data = ghApi("search/code", {
      params: { q: "nixpkgs repo:bdsqqq/dots", per_page: 3 },
      accept: "application/vnd.github.text-match+json",
    });
    expect(data.total_count).toBeGreaterThan(0);
    expect(data.items.length).toBeGreaterThan(0);
  });

  it("fetches git tree recursively", () => {
    const repo = ghApi("repos/bdsqqq/dots");
    const tree = ghApi(
      `repos/bdsqqq/dots/git/trees/${repo.default_branch}?recursive=1`,
    );
    expect(tree.tree.length).toBeGreaterThan(10);
    const paths = tree.tree.map((t: any) => t.path);
    expect(paths).toContain("flake.nix");
  });

  it("compares refs", () => {
    const data = ghApi("repos/bdsqqq/dots/compare/HEAD~1...HEAD");
    expect(data.status).toBeTruthy();
    expect(data.files).toBeTruthy();
  });

  it("throws on nonexistent repo", () => {
    expect(() => ghApi("repos/bdsqqq/nonexistent-repo-12345")).toThrow();
  });
});

// ============================================================
// layer 2: tool integration tests via pi spawn (PI_E2E=1 only)
// ============================================================

describe.skipIf(!ENABLED)("github tools via pi", () => {
  it("read_github: reads a file and returns line-numbered content", async () => {
    const { events, exitCode } = await runPi(
      'Use the read_github tool to read the file "flake.nix" from repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
    );
    expect(exitCode).toBe(0);

    const calls = getToolCalls(events);
    const readCalls = calls.filter((c) => c.name === "read_github");
    expect(readCalls.length).toBeGreaterThanOrEqual(1);

    const results = getToolResults(events);
    const readResults = results.filter((r) => r.toolName === "read_github");
    expect(readResults.length).toBeGreaterThanOrEqual(1);
    expect(readResults[0].isError).toBe(false);
    expect(readResults[0].content).toContain("1:");
    expect(readResults[0].content).toContain("description");
  }, 60_000);

  it("search_github: finds code matching a pattern", async () => {
    const { events, exitCode } = await runPi(
      'Use the search_github tool to search for "nixpkgs" in repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
    );
    expect(exitCode).toBe(0);

    const results = getToolResults(events);
    const searchResults = results.filter((r) => r.toolName === "search_github");
    expect(searchResults.length).toBeGreaterThanOrEqual(1);
    expect(searchResults[0].isError).toBe(false);
    expect(searchResults[0].content).toContain("Found");
  }, 60_000);

  it("list_directory_github: lists root directory entries", async () => {
    const { events, exitCode } = await runPi(
      'Use the list_directory_github tool to list the root directory (path "") of repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
    );
    expect(exitCode).toBe(0);

    const results = getToolResults(events);
    const dirResults = results.filter(
      (r) => r.toolName === "list_directory_github",
    );
    expect(dirResults.length).toBeGreaterThanOrEqual(1);
    expect(dirResults[0].isError).toBe(false);
    expect(dirResults[0].content).toContain("flake.nix");
  }, 60_000);

  it("commit_search: returns recent commits", async () => {
    const { events, exitCode } = await runPi(
      'Use the commit_search tool to get the 3 most recent commits from repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
    );
    expect(exitCode).toBe(0);

    const results = getToolResults(events);
    const commitResults = results.filter((r) => r.toolName === "commit_search");
    expect(commitResults.length).toBeGreaterThanOrEqual(1);
    expect(commitResults[0].isError).toBe(false);
    expect(commitResults[0].content).toContain("Found");
  }, 60_000);

  it("glob_github: finds files by pattern", async () => {
    const { events, exitCode } = await runPi(
      'Use the glob_github tool to find all "*.nix" files in repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
    );
    expect(exitCode).toBe(0);

    const results = getToolResults(events);
    const globResults = results.filter((r) => r.toolName === "glob_github");
    expect(globResults.length).toBeGreaterThanOrEqual(1);
    expect(globResults[0].isError).toBe(false);
    expect(globResults[0].content).toContain("flake.nix");
  }, 60_000);

  it("diff: compares two refs", async () => {
    const { events, exitCode } = await runPi(
      'Use the diff tool to compare "HEAD~1" to "HEAD" in repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
    );
    expect(exitCode).toBe(0);

    const results = getToolResults(events);
    const diffResults = results.filter((r) => r.toolName === "diff");
    expect(diffResults.length).toBeGreaterThanOrEqual(1);
    expect(diffResults[0].isError).toBe(false);
    expect(diffResults[0].content).toContain("Comparing");
    expect(diffResults[0].content).toContain("Changed files");
  }, 60_000);
});

// ============================================================
// layer 2b: librarian sub-agent e2e (PI_E2E=1 only)
// ============================================================

describe.skipIf(!ENABLED)("librarian e2e", () => {
  it("registration: librarian and github tools visible to model", async () => {
    const { events, exitCode } = await runPi(
      "List every tool you have available. Just the names, one per line.",
    );
    expect(exitCode).toBe(0);

    // extract final assistant text
    let text = "";
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "agent_end") {
        for (const msg of (events[i].messages ?? []).reverse()) {
          if (msg.role === "assistant") {
            for (const part of msg.content ?? []) {
              if (part.type === "text") {
                text = part.text;
                break;
              }
            }
          }
          if (text) break;
        }
      }
      if (text) break;
    }

    expect(text).toContain("librarian");
    expect(text).toContain("read_github");
    expect(text).toContain("search_github");
    expect(text).toContain("diff");
  }, 60_000);

  it("librarian: sub-agent explores a repo and answers a question", async () => {
    const { events, exitCode } = await runPi(
      'Use the librarian tool with query "What inputs does the flake.nix define?" and context "Looking at the bdsqqq/dots repository on GitHub." Just call librarian, nothing else.',
    );
    expect(exitCode).toBe(0);

    const calls = getToolCalls(events);
    const librarianCalls = calls.filter((c) => c.name === "librarian");
    expect(librarianCalls.length).toBeGreaterThanOrEqual(1);

    const results = getToolResults(events);
    const librarianResults = results.filter((r) => r.toolName === "librarian");
    expect(librarianResults.length).toBeGreaterThanOrEqual(1);

    const result = librarianResults[0];
    expect(result.isError).toBe(false);
    // the librarian should have read flake.nix and found inputs
    expect(result.content.toLowerCase()).toContain("nixpkgs");
    expect(result.content.length).toBeGreaterThan(100);
  }, 180_000);
});
