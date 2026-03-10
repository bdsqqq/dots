import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { detectMentionPrefix, parseMentions } from "./parse";
import { MentionAwareProvider } from "./provider";
import {
  renderResolvedMentionsBlock,
  renderResolvedMentionsText,
} from "./render";
import {
  clearCommitIndexCache,
  getCommitIndex,
  lookupCommitByPrefix,
  parseCommitLog,
} from "./commit-index";
import { resolveMentions } from "./resolve";
import {
  clearSessionMentionCache,
  resolveMentionableSession,
  type MentionableSession,
} from "./session-index";
import {
  getMentionSource,
  registerMentionSource,
  type MentionSource,
} from "./sources";
import { toResolvedSessionMention } from "./types";

describe("parseMentions", () => {
  it("parses canonical mention tokens", () => {
    expect(
      parseMentions(
        "use @commit/abc1234 then check @session/123e4567-e89b and @handoff/run-42",
      ),
    ).toEqual([
      {
        kind: "commit",
        raw: "@commit/abc1234",
        value: "abc1234",
        start: 4,
        end: 19,
      },
      {
        kind: "session",
        raw: "@session/123e4567-e89b",
        value: "123e4567-e89b",
        start: 31,
        end: 53,
      },
      {
        kind: "handoff",
        raw: "@handoff/run-42",
        value: "run-42",
        start: 58,
        end: 73,
      },
    ]);
  });

  it("ignores embedded email-ish strings", () => {
    expect(parseMentions("foo@commit/abc1234 bar")).toEqual([]);
  });

  it("keeps parsing registry-backed kinds when no source is registered", () => {
    expect(getMentionSource("session")).toBeNull();

    expect(parseMentions("see @session/alpha1234")).toEqual([
      {
        kind: "session",
        raw: "@session/alpha1234",
        value: "alpha1234",
        start: 4,
        end: 22,
      },
    ]);
  });
});

describe("detectMentionPrefix", () => {
  it("detects a bare family prefix", () => {
    expect(detectMentionPrefix("check @com")).toEqual({
      raw: "@com",
      start: 6,
      end: 10,
      familyQuery: "com",
      kind: null,
      valueQuery: "",
      hasSlash: false,
    });
  });

  it("detects a value prefix for a known family", () => {
    expect(detectMentionPrefix("check @commit/abc", 17)).toEqual({
      raw: "@commit/abc",
      start: 6,
      end: 17,
      familyQuery: "commit",
      kind: "commit",
      valueQuery: "abc",
      hasSlash: true,
    });
  });

  it("keeps registry-backed families available for prefix detection", () => {
    expect(getMentionSource("handoff")).toBeNull();

    expect(detectMentionPrefix("check @handoff/run-42", 22)).toEqual({
      raw: "@handoff/run-42",
      start: 6,
      end: 22,
      familyQuery: "handoff",
      kind: "handoff",
      valueQuery: "run-42",
      hasSlash: true,
    });
  });

  it("returns null outside mention context", () => {
    expect(detectMentionPrefix("check this", 10)).toBeNull();
  });
});

describe("renderResolvedMentions", () => {
  it("renders commit, session, and handoff summaries", () => {
    expect(
      renderResolvedMentionsText([
        {
          token: {
            kind: "commit",
            raw: "@commit/abc1234",
            value: "abc1234",
            start: 0,
            end: 15,
          },
          status: "resolved",
          kind: "commit",
          commit: {
            sha: "abc1234def5678abc1234def5678abc1234def5",
            shortSha: "abc1234",
            subject: "fix mention parser",
            committedAt: "2026-03-06T16:00:00.000Z",
          },
        },
        {
          token: {
            kind: "session",
            raw: "@session/alpha1234",
            value: "alpha1234",
            start: 16,
            end: 34,
          },
          status: "resolved",
          kind: "session",
          session: {
            sessionId: "alpha1234",
            sessionName: "alpha work",
            workspace: "/repo/app",
            startedAt: "2026-03-06T17:00:00.000Z",
            updatedAt: "2026-03-06T17:10:00.000Z",
            firstUserMessage: "alpha task",
          },
        },
        {
          token: {
            kind: "handoff",
            raw: "@handoff/handoffabcd",
            value: "handoffabcd",
            start: 35,
            end: 55,
          },
          status: "resolved",
          kind: "handoff",
          session: {
            sessionId: "handoffabcd",
            sessionName: "handoff alpha",
            workspace: "/repo/app",
            startedAt: "2026-03-06T17:00:00.000Z",
            updatedAt: "2026-03-06T17:20:00.000Z",
            firstUserMessage: "resume alpha",
            parentSessionPath: "/sessions/parent.jsonl",
          },
        },
      ]),
    ).toBe(
      [
        "resolved mention context:",
        '@commit/abc1234\tcommit\tabc1234def5678abc1234def5678abc1234def5\t2026-03-06T16:00:00.000Z\t"fix mention parser"',
        '@session/alpha1234\tsession\talpha1234\t2026-03-06T17:10:00.000Z\t"alpha work"\t"/repo/app"\t"alpha task"',
        '@handoff/handoffabcd\thandoff\thandoffabcd\t2026-03-06T17:20:00.000Z\t"handoff alpha"\t"/repo/app"\t"resume alpha"\t"/sessions/parent.jsonl"',
      ].join("\n"),
    );
  });

  it("wraps rendered summaries in a hidden block", () => {
    expect(
      renderResolvedMentionsBlock([
        {
          token: {
            kind: "commit",
            raw: "@commit/abc1234",
            value: "abc1234",
            start: 0,
            end: 15,
          },
          status: "resolved",
          kind: "commit",
          commit: {
            sha: "abc1234def5678abc1234def5678abc1234def5",
            shortSha: "abc1234",
            subject: "fix mention parser",
            committedAt: "2026-03-06T16:00:00.000Z",
          },
        },
      ]),
    ).toBe(
      '<!-- pi-mentions\nresolved mention context:\n@commit/abc1234\tcommit\tabc1234def5678abc1234def5678abc1234def5\t2026-03-06T16:00:00.000Z\t"fix mention parser"\n-->',
    );
  });

  it("returns empty string when nothing resolved", () => {
    expect(
      renderResolvedMentionsText([
        {
          token: {
            kind: "session",
            raw: "@session/test",
            value: "test",
            start: 0,
            end: 13,
          },
          status: "unresolved",
          reason: "session_not_found",
        },
      ]),
    ).toBe("");
  });
});

describe("mention autocomplete", () => {
  const baseProvider: AutocompleteProvider = {
    getSuggestions: () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({
      lines,
      cursorLine,
      cursorCol,
    }),
  };

  it("hides commit namespace outside git repositories", () => {
    const provider = new MentionAwareProvider({
      baseProvider,
      cwd: tmpdir(),
    });

    expect(provider.getSuggestions(["@c"], 0, 2)).toBeNull();

    expect(provider.getSuggestions(["@commit/abc123"], 0, 14)).toEqual({
      items: [],
      prefix: "@commit/abc123",
    });
  });
});

describe("resolveMentions", () => {
  it("resolves session and handoff mentions from a provided session index", async () => {
    const unregisterSession = registerMentionSource(
      createTestSessionMentionSource("session"),
    );
    const unregisterHandoff = registerMentionSource(
      createTestSessionMentionSource("handoff"),
    );

    try {
      await expect(
        resolveMentions("see @session/alpha1234 then @handoff/handoffabcd", {
          cwd: "/repo/app",
          sessions: MENTIONABLE_SESSIONS,
        }),
      ).resolves.toEqual([
        {
          token: {
            kind: "session",
            raw: "@session/alpha1234",
            value: "alpha1234",
            start: 4,
            end: 22,
          },
          status: "resolved",
          kind: "session",
          session: {
            sessionId: "alpha1234",
            sessionName: "alpha work",
            workspace: "/repo/app",
            startedAt: "2026-03-06T17:00:00.000Z",
            updatedAt: "2026-03-06T17:10:00.000Z",
            firstUserMessage: "alpha task",
            parentSessionPath: undefined,
          },
        },
        {
          token: {
            kind: "handoff",
            raw: "@handoff/handoffabcd",
            value: "handoffabcd",
            start: 28,
            end: 48,
          },
          status: "resolved",
          kind: "handoff",
          session: {
            sessionId: "handoffabcd",
            sessionName: "handoff alpha",
            workspace: "/repo/app",
            startedAt: "2026-03-06T17:00:00.000Z",
            updatedAt: "2026-03-06T17:20:00.000Z",
            firstUserMessage: "resume alpha",
            parentSessionPath: "/sessions/parent.jsonl",
          },
        },
      ]);
    } finally {
      unregisterHandoff();
      unregisterSession();
    }
  });

  it("quietly misses when a parsed mention kind has no registered source", async () => {
    await expect(
      resolveMentions("see @session/alpha1234", {
        cwd: "/repo/app",
        sessions: [],
      }),
    ).resolves.toEqual([
      {
        token: {
          kind: "session",
          raw: "@session/alpha1234",
          value: "alpha1234",
          start: 4,
          end: 22,
        },
        status: "unresolved",
        reason: "session_mentions_not_supported_yet",
      },
    ]);
  });
});

const MENTIONABLE_SESSIONS: MentionableSession[] = [
  {
    sessionId: "alpha1234",
    sessionName: "alpha work",
    workspace: "/repo/app",
    filePath: "/sessions/alpha.jsonl",
    startedAt: "2026-03-06T17:00:00.000Z",
    updatedAt: "2026-03-06T17:10:00.000Z",
    firstUserMessage: "alpha task",
    searchableText: "alpha task",
    branchCount: 1,
    isHandoffCandidate: false,
  },
  {
    sessionId: "handoffabcd",
    sessionName: "handoff alpha",
    workspace: "/repo/app",
    filePath: "/sessions/handoff.jsonl",
    startedAt: "2026-03-06T17:00:00.000Z",
    updatedAt: "2026-03-06T17:20:00.000Z",
    firstUserMessage: "resume alpha",
    searchableText: "resume alpha",
    branchCount: 1,
    parentSessionPath: "/sessions/parent.jsonl",
    isHandoffCandidate: true,
  },
];

function createTestSessionMentionSource(
  kind: "session" | "handoff",
): MentionSource {
  return {
    kind,
    description: kind,
    getSuggestions(query, context) {
      return (context.sessions ?? [])
        .filter((session) => kind !== "handoff" || session.isHandoffCandidate)
        .filter(
          (session) =>
            query.length === 0 ||
            session.sessionId.toLowerCase().startsWith(query.toLowerCase()),
        )
        .slice(0, 8)
        .map((session) => ({
          value: `@${kind}/${session.sessionId}`,
          label: `@${kind}/${session.sessionId}`,
          description:
            session.sessionName ||
            session.firstUserMessage ||
            session.workspace,
        }));
    },
    resolve(token, context) {
      const result = resolveMentionableSession(
        context.sessions ?? [],
        token.value,
        kind,
      );

      if (result.status === "resolved") {
        return {
          token,
          status: "resolved",
          kind,
          session: toResolvedSessionMention(result.session),
        };
      }

      return {
        token,
        status: "unresolved",
        reason:
          result.status === "ambiguous"
            ? `${kind}_prefix_ambiguous`
            : `${kind}_not_found`,
      };
    },
  };
}

const repos: string[] = [];

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mentions-commit-index-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "pi"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "pi@example.com"], { cwd: dir });
  return dir;
}

function commitFile(
  repo: string,
  name: string,
  contents: string,
  message: string,
): string {
  writeFileSync(join(repo, name), contents);
  execFileSync("git", ["add", name], { cwd: repo });
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-03-06T16:00:00.000Z",
    GIT_COMMITTER_DATE: "2026-03-06T16:00:00.000Z",
  };
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo, env });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

afterEach(() => {
  clearCommitIndexCache();
  clearSessionMentionCache();
  for (const repo of repos.splice(0))
    rmSync(repo, { recursive: true, force: true });
});

describe("parseCommitLog", () => {
  it("parses git log output deterministically", () => {
    expect(
      parseCommitLog(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t2026-03-06T16:00:00.000Z\tfirst\n",
      ),
    ).toEqual([
      {
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        shortSha: "aaaaaaaaaaaa",
        committedAt: "2026-03-06T16:00:00.000Z",
        subject: "first",
      },
    ]);
  });
});

describe("lookupCommitByPrefix", () => {
  it("resolves a unique commit prefix from a temp repo", () => {
    const repo = createRepo();
    repos.push(repo);
    const sha = commitFile(repo, "a.txt", "one", "first commit");
    commitFile(repo, "b.txt", "two", "second commit");

    const index = getCommitIndex(repo);
    expect(index).not.toBeNull();
    expect(lookupCommitByPrefix(sha.slice(0, 12), index!)).toEqual({
      status: "resolved",
      commit: expect.objectContaining({
        sha: sha.toLowerCase(),
        shortSha: sha.slice(0, 12).toLowerCase(),
        subject: "first commit",
      }),
    });
  });
});
