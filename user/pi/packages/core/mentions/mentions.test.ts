import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMentions, detectMentionPrefix } from "./parse";
import { renderResolvedMentionsBlock } from "./render";
import {
  clearCommitIndexCache,
  getCommitIndex,
  lookupCommitByPrefix,
  parseCommitLog,
} from "./commit-index";

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

  it("returns null outside mention context", () => {
    expect(detectMentionPrefix("check this", 10)).toBeNull();
  });
});

describe("renderResolvedMentionsBlock", () => {
  it("renders only resolved mentions in a hidden block", () => {
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
            raw: "@session/test",
            value: "test",
            start: 16,
            end: 29,
          },
          status: "unresolved",
          reason: "unsupported",
        },
      ]),
    ).toBe(
      '<!-- pi-mentions\n@commit/abc1234\tabc1234def5678abc1234def5678abc1234def5\t2026-03-06T16:00:00.000Z\t"fix mention parser"\n-->',
    );
  });

  it("returns empty string when nothing resolved", () => {
    expect(
      renderResolvedMentionsBlock([
        {
          token: {
            kind: "session",
            raw: "@session/test",
            value: "test",
            start: 0,
            end: 13,
          },
          status: "unresolved",
          reason: "unsupported",
        },
      ]),
    ).toBe("");
  });
});

const repos: string[] = [];

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mentions-commit-index-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "pi"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "pi@example.com"], { cwd: dir });
  return dir;
}

function commitFile(repo: string, name: string, contents: string, message: string): string {
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
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
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
