import type { LoadedSession } from "../../sessions/contracts.js";
import { projectRepositoryId } from "../project.js";
import type * as C from "./contracts.js";

export type NativeProjectContext = NonNullable<
  Extract<C.SourceRef["origin"], { kind: "session" }>["project"]
>;

/** Run in a producer worker, never on the inference event loop. Supplied context
 * owns discovery; null explicitly opts out. A remote identifies the repository,
 * but today's HEAD cannot establish the revision of historical experience. */
export function observeNativeProject(
  cwd: string,
  supplied?: NativeProjectContext | null,
): NativeProjectContext | null {
  if (supplied !== undefined) return supplied;
  const repositoryId = projectRepositoryId(cwd);
  return repositoryId ? { repositoryId } : null;
}

export function nativeSessionSource(
  snapshot: LoadedSession,
  project: NativeProjectContext | null,
): C.SourceRef {
  return {
    sourceId: snapshot.header.id as C.SourceId,
    producer: "pi-native",
    origin: {
      kind: "session",
      sessionId: snapshot.header.id as C.SessionId,
      ...(project ? { project } : {}),
    },
  };
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  it("keeps supplied context authoritative and an unavailable historical workspace personal", () => {
    const supplied = {
      repositoryId: "example.com/team/project",
      revision: "producer-recorded-revision",
    };
    expect(
      observeNativeProject("/unavailable/historical/workspace", supplied),
    ).toBe(supplied);
    expect(
      observeNativeProject("/unavailable/historical/workspace", null),
    ).toBeNull();
    const project = observeNativeProject("/unavailable/historical/workspace");
    expect(project).toBeNull();
    expect(
      nativeSessionSource(
        { header: { id: "native-source" } } as LoadedSession,
        project,
      ),
    ).toEqual({
      sourceId: "native-source",
      producer: "pi-native",
      origin: { kind: "session", sessionId: "native-source" },
    });
  });
}
