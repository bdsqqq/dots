import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type * as C from "./contracts.js";
import {
  canonicalJSON,
  hashSourceWindow,
  sha256,
  windowId,
} from "./identity.js";
import { createNoteRevision } from "./markdown.js";
import { durableCreate } from "./durability.js";
import { redact } from "../evidence.js";

/** explicit file list only; retain original bytes and mark prose as historical derivation. */
export async function importLegacyMarkdown(input: {
  readonly paths: readonly string[];
  readonly store: C.MemoryStore;
  readonly scope: C.MemoryScope;
  readonly archive: string;
}): Promise<readonly C.CommitResult[]> {
  if (!input.paths.length || input.paths.length > 128)
    throw new Error("import requires 1..128 explicit Markdown paths");
  const paths = input.paths.map((p) => resolve(p));
  if (new Set(paths).size !== paths.length)
    throw new Error("duplicate legacy path");
  const ids = new Map(
    paths.map((path) => [
      path,
      `legacy-${sha256(path).slice(0, 24)}` as C.NoteId,
    ]),
  );
  const results: C.CommitResult[] = [];
  for (const path of paths) {
    if (!path.endsWith(".md"))
      throw new Error("legacy import requires Markdown files");
    const bytes = readFileSync(path);
    if (bytes.length > 128 * 1024 || !bytes.length)
      throw new Error("legacy file outside 1..128 KiB budget");
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (redact(text).text !== text)
      throw new Error("legacy file requires explicit redaction before import");
    const authoredAt = statSync(path).mtime.toISOString();
    durableCreate(join(input.archive, `${sha256(bytes)}.md`), bytes);
    const source: C.SourceRef = {
      sourceId: `legacy:${sha256(path)}` as C.SourceId,
      producer: "legacy-markdown",
      origin: { kind: "file", path },
    };
    const windows: C.SourceWindow[] = [];
    for (let start = 0; start < bytes.length;) {
      let end = Math.min(start + 8192, bytes.length);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      const base = {
        source,
        scope: input.scope,
        excerpts: [
          {
            span: {
              entryId: `file:${sha256(bytes)}` as C.EntryId,
              partId: "markdown",
              start,
              end,
            },
            parentEntryId: null,
            producerRole: "legacy-derived",
            occurredAt: authoredAt,
            text: bytes.subarray(start, end).toString("utf8"),
          },
        ] as const,
      };
      windows.push({
        ...base,
        sourceHash: hashSourceWindow(base),
        windowId: windowId(base),
        capturedAt: authoredAt,
        importance: "ordinary",
      });
      start = end;
    }
    const noteId = ids.get(path)!;
    const slug =
      basename(path, ".md")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .slice(0, 80) || "legacy-memory";
    const links = [...text.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)].flatMap(
      (m) => {
        const id = ids.get(resolve(dirname(path), m[1]!));
        return id ? [id] : [];
      },
    );
    const body = `# imported legacy memory\n\nhistorical derived attribution from ${basename(path)}; not an original user statement or current repository truth.\noriginal file: ${path}\noriginal bytes: sha256:${sha256(bytes)}\n\n${text}`;
    const metadata = {
      noteId,
      ancestry: { kind: "known" as const, parents: [] },
      scope: input.scope,
      path: `${slug}--${noteId}.md`,
      links: [...new Set(links)],
      exposure: { kind: "active" as const },
      authoredAt,
    };
    const evidence: C.EvidenceRef[] = windows.map((window) => ({
      windowId: window.windowId,
      source: window.source,
      sourceHash: window.sourceHash,
      spans: [window.excerpts[0].span],
    }));
    let offset = 0;
    let revision: C.NoteRevision;
    for (;;) {
      revision = createNoteRevision({
        ...metadata,
        body,
        claims: [
          {
            kind: "observation",
            markdownSpan: {
              start: offset,
              end: offset + Buffer.byteLength(body),
            },
            evidence: [evidence[0]!, ...evidence.slice(1)],
            derivedFrom: [],
          },
        ],
      });
      const next =
        Buffer.byteLength(revision.markdown) - Buffer.byteLength(body);
      if (next === offset) break;
      offset = next;
    }
    results.push(
      await input.store.commit({
        commitId:
          `legacy:${sha256(canonicalJSON({ revision, windows }))}` as C.CommitId,
        now: authoredAt,
        windows,
        edits: [{ revision, expectedHeads: [] }],
        suppressions: [],
        outcomes: [],
        lease: null,
      }),
    );
  }
  return results;
}
