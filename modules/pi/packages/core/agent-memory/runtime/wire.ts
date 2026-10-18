import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type * as C from "./contracts.js";
import { hashSourceWindow, revisionId, windowId } from "./identity.js";

// brands have no wire representation; only their underlying bounded strings do.
const id = <T extends string>() => Type.Unsafe<T>(Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000\\r\\n]+$" }));
const text = Type.String();
const time = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const obj = <P extends Record<string, TSchema>>(p: P) => Type.Object(p, { additionalProperties: false });
const nonempty = <S extends TSchema>(s: S) => Type.Unsafe<readonly [Static<S>, ...Static<S>[]]>(Type.Array(s, { minItems: 1 }));
const scope = Type.Union([obj({ kind: Type.Literal("personal"), ownerId: id<string>() }), obj({ kind: Type.Literal("project"), repositoryId: id<string>() })]);
const source = obj({ sourceId: id<C.SourceId>(), producer: id<string>(), origin: Type.Union([obj({ kind: Type.Literal("session"), sessionId: id<C.SessionId>() }), obj({ kind: Type.Literal("file"), path: id<string>() })]) });
const offset = Type.Integer({ minimum: 0 });
const span = obj({ entryId: id<C.EntryId>(), partId: id<string>(), start: offset, end: offset });
const evidence = obj({ windowId: id<C.WindowId>(), source, sourceHash: id<C.SourceHash>(), spans: nonempty(span) });
const ref = obj({ noteId: id<C.NoteId>(), revisionId: id<C.RevisionId>() });
const ancestry = Type.Union([obj({ kind: Type.Literal("known"), parents: Type.Array(id<C.RevisionId>()) }), obj({ kind: Type.Literal("unknown-base"), observedHeads: Type.Array(id<C.RevisionId>()) })]);
const exposure = Type.Union([obj({ kind: Type.Literal("active") }), obj({ kind: Type.Literal("demoted"), reason: text }), obj({ kind: Type.Literal("superseded"), by: nonempty(id<C.NoteId>()) }), obj({ kind: Type.Literal("deleted"), reason: text })]);
const claim = obj({ kind: Type.Union([Type.Literal("producer-statement"), Type.Literal("observation"), Type.Literal("model-inference")]), markdownSpan: obj({ start: offset, end: offset }), evidence: nonempty(evidence), derivedFrom: Type.Array(ref) });
const revision = obj({ noteId: id<C.NoteId>(), revisionId: id<C.RevisionId>(), ancestry, scope, path: text, markdown: text, links: Type.Array(id<C.NoteId>()), claims: Type.Array(claim), exposure, authoredAt: time });
const window = obj({ windowId: id<C.WindowId>(), source, scope, sourceHash: id<C.SourceHash>(), excerpts: nonempty(obj({ span, parentEntryId: Type.Union([id<C.EntryId>(), Type.Null()]), producerRole: id<string>(), occurredAt: time, text })), capturedAt: time, importance: Type.Union([Type.Literal("ordinary"), Type.Literal("correction")]) });
const suppression = obj({ suppressionId: id<C.SuppressionId>(), scope, target: Type.Union([obj({ kind: Type.Literal("note"), noteId: id<C.NoteId>() }), obj({ kind: Type.Literal("evidence"), evidence })]), reason: text, createdAt: time });
const terminal = Type.Union([obj({ kind: Type.Literal("changed"), notes: nonempty(ref) }), obj({ kind: Type.Literal("no-change"), reason: text }), obj({ kind: Type.Literal("ineligible"), reason: text })]);
const outcome = obj({ windowId: id<C.WindowId>(), sourceHash: id<C.SourceHash>(), decision: Type.Union([terminal, obj({ kind: Type.Literal("retry"), reason: text, retryAt: time })]), recordedAt: time });
const lease = obj({ leaseId: id<C.LeaseId>(), jobId: id<C.JobId>(), owner: id<string>(), expiresAt: time });
const change = obj({ commitId: id<C.CommitId>(), now: time, windows: Type.Array(window), edits: Type.Array(obj({ revision, expectedHeads: Type.Array(id<C.RevisionId>()) })), suppressions: Type.Array(suppression), outcomes: Type.Array(outcome), lease: Type.Union([lease, Type.Null()]) });
const replica = obj({ commitId: id<C.CommitId>(), replicaId: id<C.ReplicaId>(), parents: Type.Array(id<C.CommitId>()), revisions: Type.Array(revision), windows: Type.Array(window), suppressions: Type.Array(suppression), outcomes: Type.Array(obj({ windowId: id<C.WindowId>(), sourceHash: id<C.SourceHash>(), decision: terminal, recordedAt: time })) });
const target = obj({ consumerId: id<string>(), sessionId: id<C.SessionId>(), scope });
const delivery = obj({ deliveryId: id<C.DeliveryId>(), intent: obj({ intentId: id<C.IntentId>(), target, entryId: id<C.EntryId>(), query: text, expiresAt: time, maxChars: Type.Integer({ minimum: 1 }), maxNotes: Type.Integer({ minimum: 1 }) }), context: obj({ text, notes: nonempty(ref), evidence: Type.Array(evidence) }) });
function decode<S extends TSchema>(schema: S, value: unknown): Static<S> {
  if (!Check(schema, value)) throw new Error("invalid memory wire value");
  return value;
}
export function parseRevision(value: unknown): C.NoteRevision {
  const r = decode(revision, value);
  const { revisionId: hash, ...envelope } = r;
  if (revisionId(envelope) !== hash) throw new Error("revision hash mismatch");
  if (!/^[^\\\0]+\.md$/.test(r.path) || r.path.startsWith("/") || r.path.split("/").some(x => !x || x === "." || x === "..")) throw new Error("unsafe markdown path");
  for (const c of r.claims) if (c.markdownSpan.end < c.markdownSpan.start || c.markdownSpan.end > Buffer.byteLength(r.markdown)) throw new Error("invalid claim span");
  return r;
}
export function parseWindow(value: unknown): C.SourceWindow {
  const w = decode(window, value);
  if (hashSourceWindow(w) !== w.sourceHash || windowId(w) !== w.windowId) throw new Error("source window hash mismatch");
  for (const e of w.excerpts) if (e.span.end - e.span.start !== Buffer.byteLength(e.text)) throw new Error("invalid source span");
  return w;
}
export function parseChange(value: unknown): C.LocalChangeSet {
  const c = decode(change, value); c.windows.forEach(parseWindow); c.edits.forEach(e => parseRevision(e.revision)); return c;
}
export function parseReplicaChange(value: unknown): C.ReplicaChange {
  const c = decode(replica, value); c.windows.forEach(parseWindow); c.revisions.forEach(parseRevision); return c;
}
export function parseDelivery(value: unknown): C.RecallDelivery { return decode(delivery, value); }
export function parseLease(value: unknown): C.LocalLease { return decode(lease, value); }
