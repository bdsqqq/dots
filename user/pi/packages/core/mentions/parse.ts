import {
  MENTION_KINDS,
  type MentionKind,
  type MentionPrefix,
  type MentionToken,
} from "./types";

const FAMILY_PATTERN = MENTION_KINDS.join("|");
const TOKEN_RE = new RegExp(
  String.raw`(?<![\w/])@(${FAMILY_PATTERN})/([A-Za-z0-9][A-Za-z0-9._-]*)`,
  "g",
);
const PREFIX_RE = /(?:^|[\s([{"'])@([A-Za-z-]*)?(?:\/([A-Za-z0-9._-]*))?$/;

export function parseMentions(text: string): MentionToken[] {
  const mentions: MentionToken[] = [];

  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0];
    const kind = match[1] as MentionKind | undefined;
    const value = match[2];
    const start = match.index ?? -1;

    if (kind === undefined || value === undefined || start < 0) continue;

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
  const kind = MENTION_KINDS.includes(familyQuery as MentionKind)
    ? (familyQuery as MentionKind)
    : null;

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

