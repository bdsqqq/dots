import type { ResolvedMention } from "./types";

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quote(value: string): string {
  return JSON.stringify(singleLine(value));
}

function summarizeResolvedMention(
  mention: Extract<ResolvedMention, { status: "resolved" }>,
): string {
  if (mention.kind === "commit") {
    return [
      mention.token.raw,
      "commit",
      mention.commit.sha,
      mention.commit.committedAt,
      quote(mention.commit.subject),
    ].join("\t");
  }

  const parent = mention.session.parentSessionPath
    ? `\t${quote(mention.session.parentSessionPath)}`
    : "";

  return (
    [
      mention.token.raw,
      mention.kind,
      mention.session.sessionId,
      mention.session.updatedAt,
      quote(mention.session.sessionName || mention.session.firstUserMessage),
      quote(mention.session.workspace),
      quote(mention.session.firstUserMessage),
    ].join("\t") + parent
  );
}

export function renderResolvedMentionsText(
  mentions: ResolvedMention[],
): string {
  const resolved = mentions.filter((mention) => mention.status === "resolved");
  if (resolved.length === 0) return "";
  return `resolved mention context:\n${resolved.map(summarizeResolvedMention).join("\n")}`;
}

export function renderResolvedMentionsBlock(
  mentions: ResolvedMention[],
): string {
  const text = renderResolvedMentionsText(mentions);
  if (!text) return "";
  return `<!-- pi-mentions\n${text}\n-->`;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

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
}
