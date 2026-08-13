export type CallNodeKind = "call" | "branch" | "callback";

export type CallbackRelation = "registers" | "invokes" | "passes";
export interface CallbackEdge {
  contractId: string;
  role: string;
  relation: CallbackRelation;
  target: string;
}

/** Source location as shown in editors: `file:line` or `file:line-line`. */
export interface SourceLoc {
  file: string;
  /** 1-based start line */
  line: number;
  /** 1-based end line when the span covers multiple lines */
  endLine?: number;
}

export interface CallNode {
  /** Stable identity used for matching across versions, e.g. "PiService.createAgentSession" */
  key: string;
  /** Display label, e.g. "PiService.createAgentSession" or "if (!options.sessionId)" */
  label: string;
  /** Branches omit the continuing │ rail so arms read as alternate paths */
  kind?: CallNodeKind;
  callback?: CallbackEdge;
  /** Syntax-level data crossing this call boundary. Present for JS/TS. */
  data?: {
    /** Expressions supplied by the caller. */
    arguments?: string[];
    /** Parameters declared by the resolved callee/callback. */
    parameters?: string[];
    /** Expressions explicitly returned by the resolved callee/callback. */
    returns?: string[];
    /** Local binding or return boundary receiving the call result. */
    result?: string;
  };
  /**
   * Root: definition location. Children: call-site (or branch keyword) in the parent.
   * Matching/diff keys ignore these fields.
   */
  file?: string;
  line?: number;
  endLine?: number;
  children: CallNode[];
}

/** One step in a function body: a call, or a conditional branch with nested steps. */
export type CallStep =
  | {
      type: "call";
      key: string;
      /** Call-expression span in the caller file. */
      file?: string;
      line?: number;
      endLine?: number;
      /** Parser offsets used to attach callback contracts to this exact call. */
      start?: number;
      end?: number;
      /** Inline children (e.g. JSX component children at the call site). */
      children?: CallStep[];
      /** Deferred callback edges declared by a recognized API contract. */
      callbacks?: CallStep[];
      /** Call-site argument expressions, when supported by the extractor. */
      arguments?: string[];
      /** Local binding or return boundary receiving the call result. */
      result?: string;
    }
  | {
      type: "callback";
      key: string;
      callback: CallbackEdge;
      file?: string;
      line?: number;
      endLine?: number;
    }
  | {
      type: "branch";
      key: string;
      label: string;
      /** Branch keyword / condition span. */
      file?: string;
      line?: number;
      endLine?: number;
      children: CallStep[];
    };

export type DiffStatus = "same" | "added" | "removed";

export interface DiffNode {
  key: string;
  label: string;
  status: DiffStatus;
  kind?: CallNodeKind;
  callback?: CallbackEdge;
  file?: string;
  line?: number;
  endLine?: number;
  children: DiffNode[];
}

export interface FunctionInfo {
  /** Stable key: "foo" or "ClassName.method" or "ClassName.constructor" */
  key: string;
  label: string;
  file: string;
  /** Ordered body steps (calls + if/else branches) */
  steps: CallStep[];
  /** Declared parameter patterns, when supported by the extractor. */
  parameters?: string[];
  /** Explicit return expressions, when supported by the extractor. */
  returns?: string[];
  exported: boolean;
  /** Source span for change detection */
  start: number;
  end: number;
  /** 1-based definition line (derived from start/end + source) */
  line?: number;
  endLine?: number;
}

export interface Snapshot {
  kind: "commit" | "worktree";
  /** Commit-ish, or "WORKTREE" */
  ref: string;
}

export type CliMode = "diff" | "tree" | "reach";

export interface DiffTreeResult {
  entry: string;
  /** Colorless ASCII rendering of this entry's diff tree. */
  ascii: string;
  tree: DiffNode;
}

export interface DiffResult {
  mode: "diff";
  from: string;
  to: string;
  message?: string;
  trees: DiffTreeResult[];
  /** Full human-oriented ASCII output (may include ANSI colors). */
  ascii: string;
}

export interface TreeEntryResult {
  entry: string;
  /** Colorless ASCII rendering of this entry's call tree. */
  ascii: string;
  tree: CallNode;
}

export interface TreeResult {
  mode: "tree";
  ref: string;
  trees: TreeEntryResult[];
  /** Full human-oriented ASCII output (may include ANSI colors). */
  ascii: string;
}

export interface ReachPathResult {
  /** Colorless ASCII rendering of this path. */
  ascii: string;
  tree: CallNode;
}

export interface ReachResult {
  mode: "reach";
  ref: string;
  from: string;
  to: string;
  message?: string;
  paths: ReachPathResult[];
  /** Full human-oriented ASCII output (may include ANSI colors). */
  ascii: string;
}
