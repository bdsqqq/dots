# session history

`listSessions({ workspace? , sessionDir? , sessions? })` discovers native pi
sessions. omit `sessionDir` for SDK `listAll()` discovery across workspace
directories; pass a native custom session directory for flat-directory discovery.
the extension supplies its native `sessionDir` setting/environment override.
workspace matching is exact, not a substring search.

`readSession({ workspace, source, branch })` returns typed raw entries on one
root-to-entry path, never an LLM extraction. source is a file, an id/prefix
resolved by discovery, or caller-loaded `{ header, entries, sessionFile }`.
loaded input does no filesystem work. each call owns its selection.

stored `persisted-last-entry` means the last entry in the file, NOT the live
active leaf: navigation alone need not persist a new entry. use an explicit
`entry` selection for reproducible reads. callers owning a live manager can
supply its header/entries and `{ kind: "current", leafId: manager.getLeafId() }`.
no read mutates a live manager or rewrites/migrates its file.

results are `{ ok: true, value }` or `{ ok: false, error }`. discovery inherits
the SDK's best-effort behavior (unreadable/malformed files may be skipped).
explicit file reads instead report JSON parse and I/O failures. raw history is
not compaction-resolved model context and may contain sensitive data.

deliberate text/indexed searches belong to `rg`/qmd, not another session index.
history access is not a fallback personal-memory source.
