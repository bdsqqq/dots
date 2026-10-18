import type { NoteId, NoteRevision, RevisionId } from "./contracts.js";
import { canonicalJSON, revisionId, sha256 } from "./identity.js";
import { parseRevision, parseNoteMetadata } from "./wire.js";

const marker = /^<!-- pi-memory (.+) -->\n/;
/** the complete metadata travels with editable markdown, including after a rename. */
export function readMarkdownRevision(
  markdown: string,
  path?: string,
  preserveClaims = true,
): NoteRevision | null {
  const match = marker.exec(markdown);
  if (!match) return null;
  const metadata = parseNoteMetadata(JSON.parse(match[1]!));
  const envelope = {
    ...metadata,
    ...(path === undefined ? {} : { path }),
    markdown,
    ...(preserveClaims ? {} : { claims: [] }),
  };
  return parseRevision({
    ...envelope,
    revisionId: sha256(canonicalJSON(envelope)),
  });
}
export function markdownIdentity(
  markdown: string,
): { noteId: NoteId; base: RevisionId | null } | null {
  const note = readMarkdownRevision(markdown, undefined, false);
  if (!note) return null;
  return {
    noteId: note.noteId,
    base:
      note.ancestry.kind === "known" && note.ancestry.parents.length === 1
        ? note.ancestry.parents[0]!
        : null,
  };
}
export function createNoteRevision(
  input: Omit<NoteRevision, "revisionId" | "markdown"> & {
    readonly body: string;
  },
): NoteRevision {
  const { body, ...metadata } = input;
  const markdown = `<!-- pi-memory ${canonicalJSON(metadata)} -->\n${body}`;
  const envelope = { ...metadata, markdown };
  return parseRevision({ ...envelope, revisionId: revisionId(envelope) });
}
export function reviseMarkdown(
  basis: NoteRevision,
  markdown: string,
  path: string,
  heads: readonly RevisionId[],
  knownBasis: boolean,
): NoteRevision {
  const { revisionId: _old, ...previous } = basis;
  const envelope = {
    ...previous,
    path,
    markdown,
    ancestry: knownBasis
      ? { kind: "known" as const, parents: [basis.revisionId] }
      : { kind: "unknown-base" as const, observedHeads: heads },
    claims: [],
  };
  // changed byte offsets cannot inherit source attribution from the previous text.
  return parseRevision({ ...envelope, revisionId: revisionId(envelope) });
}
