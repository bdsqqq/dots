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
