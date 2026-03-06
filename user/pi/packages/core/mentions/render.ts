import type { ResolvedMention } from "./types";

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function renderResolvedMentionsBlock(mentions: ResolvedMention[]): string {
  const resolved = mentions.filter((mention) => mention.status === "resolved");
  if (resolved.length === 0) return "";

  const lines = resolved.map((mention) => {
    const subject = JSON.stringify(singleLine(mention.commit.subject));
    return [
      mention.token.raw,
      mention.commit.sha,
      mention.commit.committedAt,
      subject,
    ].join("\t");
  });

  return `<!-- pi-mentions\n${lines.join("\n")}\n-->`;
}

