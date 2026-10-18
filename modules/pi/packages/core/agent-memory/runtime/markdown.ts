import { Type } from "typebox";
import { Check } from "typebox/value";
import type { NoteId, NoteRevision, RevisionId } from "./contracts.js";
import { canonicalJSON, revisionId } from "./identity.js";
import { parseRevision } from "./wire.js";

const marker = /^<!-- pi-memory (.+) -->\n/;
const noteMarker = Type.Object({ noteId: Type.String({ minLength: 1 }), base: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false });
/** the base is a claimed basis, never evidence that an editor saw that revision. */
export function markdownIdentity(markdown: string): { noteId: NoteId; base: RevisionId | null } | null {
  const match = marker.exec(markdown); if (!match) return null;
  const value: unknown = JSON.parse(match[1]!);
  if (!Check(noteMarker, value)) throw new Error("invalid markdown identity");
  return { noteId: value.noteId as NoteId, base: value.base as RevisionId | null };
}
export function createNoteRevision(input: Omit<NoteRevision, "revisionId" | "markdown"> & { readonly body: string; readonly base?: RevisionId | null }): NoteRevision {
  const { body, base = null, ...metadata } = input;
  const markdown = `<!-- pi-memory ${canonicalJSON({ noteId: input.noteId, base })} -->\n${body}`;
  const envelope = { ...metadata, markdown };
  return parseRevision({ ...envelope, revisionId: revisionId(envelope) });
}
/** metadata is retained in the immutable envelope; the editable identity survives renames. */
export function reviseMarkdown(basis: NoteRevision, markdown: string, path: string, heads: readonly RevisionId[], knownBasis: boolean): NoteRevision {
  const { revisionId: _old, ...previous } = basis;
  const envelope = { ...previous, path, markdown, ancestry: knownBasis ? { kind: "known" as const, parents: [basis.revisionId] } : { kind: "unknown-base" as const, observedHeads: heads }, claims: [] };
  // edited spans cannot inherit byte offsets or turn user edits into model evidence.
  return parseRevision({ ...envelope, revisionId: revisionId(envelope) });
}
