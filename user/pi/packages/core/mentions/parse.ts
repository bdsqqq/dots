import { isMentionKind, listMentionKinds } from "./sources";
import type { MentionPrefix, MentionToken } from "./types";

const PREFIX_RE = /(?:^|[\s([{"'])@([A-Za-z-]*)?(?:\/([A-Za-z0-9._-]*))?$/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\\$&`);
}

function getTokenRegex(): RegExp | null {
  const familyPattern = listMentionKinds().map(escapeRegex).join("|");
  if (familyPattern.length === 0) return null;

  return new RegExp(
    String.raw`(?<![\w/])@(${familyPattern})/([A-Za-z0-9][A-Za-z0-9._-]*)`,
    "g",
  );
}

export function parseMentions(text: string): MentionToken[] {
  const mentions: MentionToken[] = [];
  const tokenRegex = getTokenRegex();

  if (!tokenRegex) return mentions;

  for (const match of text.matchAll(tokenRegex)) {
    const raw = match[0];
    const kind = match[1];
    const value = match[2];
    const start = match.index ?? -1;

    if (!kind || !isMentionKind(kind) || value === undefined || start < 0)
      continue;

    mentions.push({
      kind,
      raw,
      value,
      start,
      end: start + raw.length,
    });
  }

  return mentions;
}

export function detectMentionPrefix(
  text: string,
  cursor: number = text.length,
): MentionPrefix | null {
  const head = text.slice(0, cursor);
  const match = head.match(PREFIX_RE);
  if (!match) return null;

  const raw = match[0].trimStart();
  const atIndex = head.lastIndexOf("@");
  if (atIndex < 0) return null;

  const familyQuery = match[1] ?? "";
  const valueQuery = match[2] ?? "";
  const kind = isMentionKind(familyQuery) ? familyQuery : null;

  return {
    raw,
    start: atIndex,
    end: cursor,
    familyQuery,
    kind,
    valueQuery,
    hasSlash: raw.includes("/"),
  };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

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
}
