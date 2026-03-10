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
