# whatsapp native readiness

`my.wacli.integration` defaults to disabled: importing installs the CLI and
`wacli-ready`, but does not assert readiness. enabled mode requires `account`
(a human identity binding), a private absolute `storeDir`, and an approved
`probeGroupJid` (`…@g.us`). pair the selected store explicitly with native
`wacli --store DIR auth`; that command also bootstraps sync. no activation hook
pairs, syncs, copies databases, or performs network checks.

`wacli-ready --local` checks existing DB metadata and parses native doctor JSON:
`success`, `authenticated`, and `lock_held` must match. it opens native databases
and acquires the native lock; it is not filesystem-only inspection or online proof.
`wacli-ready` adds `doctor --connect`, then exactly one
`groups info --jid GROUP` authenticated read. a successful transport connection
alone is insufficient. the group read caches group metadata in the native DB;
it does not start sync/catch-up. native session lifecycle may also write state.
account identity is bound by deliberate store selection; doctor has no account
identity field. the selected group JID must match the response. no private payload
is displayed; each subprocess is killed after 15 seconds (`--timeout 10s` upstream).

sources: [v0.2.0 doctor](https://github.com/steipete/wacli/blob/v0.2.0/cmd/wacli/doctor.go),
[group info](https://github.com/steipete/wacli/blob/v0.2.0/cmd/wacli/groups.go),
[JSON envelope](https://github.com/steipete/wacli/blob/v0.2.0/internal/out/out.go),
[connection behavior](https://github.com/steipete/wacli/blob/v0.2.0/internal/wa/client.go),
[JID serialization](https://github.com/tulir/whatsmeow/blob/fd6170ac96e5/types/jid.go).

isolated tests preserve fixture DB bytes through mocked commands. they prove the
wrapper does not replace state, not that native doctor/group commands never write.
