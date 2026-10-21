# whatsapp native readiness

`my.wacli.integration` defaults to disabled: importing installs the CLI and
`wacli-ready`, but does not assert readiness. enabled mode requires `account`
(a human identity binding), a private absolute `storeDir`, and an approved
`probeGroupJid` (`…@g.us`). pair the selected store explicitly with native
`wacli --store DIR auth`; that command also bootstraps sync. no activation hook
pairs, syncs, copies databases, or performs network checks.

`wacli-ready --local` checks existing DB metadata and parses native doctor JSON:
`success` and `authenticated` must be true; `lock_held` and `session_revoked`
must be false, `store_error` absent or empty, and `fts_enabled` true. it opens
native databases and acquires the native lock; it is not filesystem-only inspection or online proof.
`wacli-ready` adds `doctor --connect`, then exactly one
`groups info --jid GROUP` authenticated read. a successful transport connection
alone is insufficient. the group read caches group metadata in the native DB;
it does not start sync/catch-up. native session lifecycle may also write state.
account identity is bound by deliberate store selection. doctor exposes
`linked_jid`, but the human `account` label is not a machine-verified identity.
the selected group JID must match the response. no private payload
is displayed; each subprocess is killed after 15 seconds (`--timeout 10s` upstream).

sources: [v0.24.0 doctor](https://github.com/openclaw/wacli/blob/v0.24.0/cmd/wacli/doctor.go),
[group info](https://github.com/openclaw/wacli/blob/v0.24.0/cmd/wacli/groups_info_rename.go),
[JSON envelope](https://github.com/openclaw/wacli/blob/v0.24.0/internal/out/out.go),
[connection behavior](https://github.com/openclaw/wacli/blob/v0.24.0/internal/wa/client.go),
[JID serialization](https://github.com/tulir/whatsmeow/blob/b2b1e71d45e2/types/jid.go).

isolated tests preserve fixture DB bytes through mocked commands. they prove the
wrapper does not replace state, not that native doctor/group commands never write.

## fallback package

the fallback is `0.24.0` from `openclaw/wacli`, built with the affected host's
`pkgs.buildGo127Module` (go `1.27.3`) and SQLite FTS5 enabled. the builder is
selected only for this package; the host's default go is unchanged. an existing
`pkgs.wacli` still takes precedence.

source: [v0.24.0 release](https://github.com/openclaw/wacli/releases/tag/v0.24.0)
and [toolchain requirement](https://github.com/openclaw/wacli/blob/v0.24.0/go.mod).
`doctor --read-only` rejects `--connect`; `groups info` also rejects read-only
mode because it caches live metadata. the readiness helper therefore retains
the native writable lifecycle, including for local doctor checks.
