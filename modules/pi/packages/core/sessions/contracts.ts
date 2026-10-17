import type {
  FileEntry,
  SessionEntry,
  SessionHeader,
  SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface NativeSessionRootOptions {
  cwd?: string;
  sessionManager?: Pick<SessionManager, "getSessionDir">;
  allowProjectConfig?: boolean;
  /** supplying even {} avoids reading settings again. */
  settings?: Readonly<{ sessionDir?: string }>;
}

/** grouped roots contain workspace directories; flat roots contain session files. */
export interface NativeSessionSelection {
  root: string;
  kind: "grouped" | "flat";
}

export interface SessionIdentity {
  sessionId: string;
  workspace: string;
  sessionFile: string | null;
  sessionDir: string | null;
  parentSessionFile: string | null;
}

/** discovery metadata covers the whole file, not a selected branch. */
export interface SessionSummary extends SessionIdentity {
  name: string | null;
  firstMessage: string;
  created: string;
  modified: string;
}

export interface LoadedSession {
  header: SessionHeader;
  entries: readonly SessionEntry[];
  sessionFile: string | null;
}

export type SessionBranch =
  | { kind: "entry"; entryId: string }
  | { kind: "persisted-last-entry" };

export type ReadSessionInput = {
  workspace: string;
} & (
  | {
      source: { kind: "file"; path: string };
      branch: SessionBranch;
    }
  | {
      source: { kind: "id"; sessionId: string; sessionDir?: string };
      branch: SessionBranch;
    }
  | {
      source: { kind: "loaded"; session: LoadedSession };
      branch: SessionBranch | { kind: "current"; leafId: string | null };
    }
);

export interface ListSessionsInput {
  workspace?: string;
  sessionDir?: string;
  /** even an empty supplied list suppresses discovery. */
  sessions?: readonly SessionInfo[];
}

export interface SessionHistory extends SessionIdentity {
  selection: SessionBranch["kind"] | "current";
  leafId: string | null;
  rootEntryId: string | null;
  /** raw root-to-selected-entry history; not compaction-resolved model context. */
  entries: SessionEntry[];
}

export type HistoryError =
  | { code: "not_found"; message: string }
  | { code: "ambiguous"; message: string; candidates: SessionIdentity[] }
  | { code: "workspace_mismatch"; message: string }
  | { code: "branch_not_found"; message: string }
  | { code: "parse"; message: string; path: string }
  | { code: "io"; message: string; path?: string }
  | { code: "aborted"; message: string };

export type HistoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HistoryError };

export interface HistoryDependencies {
  discover(sessionDir?: string, signal?: AbortSignal): Promise<SessionInfo[]>;
  load(path: string, signal?: AbortSignal): Promise<FileEntry[]>;
}
