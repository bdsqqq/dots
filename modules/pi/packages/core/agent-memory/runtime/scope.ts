import type { MemoryScope, SourceWindow } from "./contracts.js";

export function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return a.kind === "personal"
    ? b.kind === "personal" && a.ownerId === b.ownerId
    : b.kind === "project" && a.repositoryId === b.repositoryId;
}

/** classification may narrow authorized source access, never widen it. */
export function permitsSourceScope(
  window: SourceWindow,
  target: MemoryScope,
  ownerId?: string,
): boolean {
  return (
    sameScope(window.scope, target) ||
    (window.scope.kind === "personal" &&
      (ownerId === undefined || window.scope.ownerId === ownerId) &&
      target.kind === "project" &&
      window.source.origin.kind === "session" &&
      window.source.origin.project?.repositoryId === target.repositoryId)
  );
}
