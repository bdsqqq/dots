import { createHash } from "node:crypto";
import type {
  NoteRevision,
  RevisionId,
  SourceHash,
  SourceRef,
  SourceWindow,
  WindowId,
} from "./contracts.js";

/** rejects values whose JSON representation would silently discard identity. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJSON(Reflect.get(value, key))}`,
      )
      .join(",")}}`;
  }
  throw new Error("non-JSON identity value");
}
export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export type SourceWindowIdentity = Pick<
  SourceWindow,
  "source" | "scope" | "excerpts"
>;
/** capture time, importance and worker clocks are deliberately outside identity. */
export function hashSourceWindow(input: SourceWindowIdentity): SourceHash {
  return sha256(
    canonicalJSON({
      source: input.source,
      scope: input.scope,
      excerpts: input.excerpts,
    }),
  ) as SourceHash;
}
export function windowId(input: SourceWindowIdentity): WindowId {
  return sha256(
    canonicalJSON({
      kind: "source-window",
      sourceHash: hashSourceWindow(input),
    }),
  ) as WindowId;
}
export function revisionId(
  input: Omit<NoteRevision, "revisionId">,
): RevisionId {
  return sha256(canonicalJSON(input)) as RevisionId;
}
/** locators/context and window hashes may change without creating independent evidence. */
export function sameProducerSource(a: SourceRef, b: SourceRef): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.producer === b.producer &&
    (a.origin.kind === "file"
      ? b.origin.kind === "file"
      : b.origin.kind === "session" &&
        a.origin.sessionId === b.origin.sessionId)
  );
}
export function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  it("canonicalizes keys and rejects lossy values", () => {
    expect(canonicalJSON({ z: 1, a: ["x"] })).toBe('{"a":["x"],"z":1}');
    expect(() => canonicalJSON({ a: undefined })).toThrow();
  });
}
