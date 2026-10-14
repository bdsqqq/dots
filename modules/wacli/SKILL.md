---
name: wacli
description: "Use wacli for bounded searches of an existing local WhatsApp store, or explicitly requested WhatsApp pairing, sync, and sending. Use for WhatsApp CLI work; not Gmail/Calendar, generic message drafting, or background/bulk message ingestion."
---

# whatsapp with wacli

## choose the identity and bound the task

1. Check `wacli --version` and command help. This module's fallback is v0.2.0;
   never assume newer named-account flags exist. Select the intended private
   store explicitly with `--store DIR` when using multiple identities.
2. A bounded local search is
   `wacli --store DIR messages search 'QUERY' --limit 20 --json`.
   This reads already captured messages, not a complete remote archive.
   Do not start sync to fill a search gap without authorization.
3. Return only requested fields. Message text and chat names are private data;
   never dump databases or retain bulk output as debugging evidence.
4. Stop for missing pairing, a held store lock, ambiguous identity/recipient,
   or unavailable history. Do not remove a live lock, re-pair, or switch stores
   to bypass an error.

Search authorization does not authorize sending, group changes, downloads, or
sync. For an authorized send, inspect `wacli send text --help` and confirm the
concrete target identifier and content from the user's request. A request to
write a message draft does not authorize sending it.

## private pairing lifecycle — only when requested

v0.2.0 uses `~/.wacli` on macOS AND Linux, overridden with `--store DIR`.
It has no native settings file. Newer versions may change this; check installed
help. A store identifies one linked WhatsApp device/account and contains:

- `session.db`: device identity and encryption keys
- `wacli.db`: private chats/messages and search index
- `media/`: downloaded private media; `LOCK`: single-writer coordination

Keep this directory outside tracked files and the Nix store. Do not symlink
individual SQLite files: SQLite creates adjacent journals/WAL files and media
writes use temporary files plus rename. A private writable directory is the
native contract; no tracked config or credential placeholder is installed.

For explicitly requested pairing, explain that **auth also bootstraps sync**:

```sh
wacli --store /private/path/wacli auth
```

The user scans the QR in WhatsApp → Linked Devices. Do not capture or publish
QR output. Pairing grants linked-device access, not Google-style OAuth scopes;
there is no read-only pairing scope. Separate stores are required for separate
identities. Do not silently start `sync --follow` or create a daemon.

`wacli --store DIR auth status` and `wacli --store DIR doctor` do not connect by
default, but open/create databases and acquire the lock: they are NOT metadata-only
inspection. Run them only with permission to touch private local state.
`doctor --connect` also connects remotely. During setup-only work, use filesystem
metadata and `--help` instead. Never inspect session key values or database rows
just to establish whether files exist.

For explicitly requested logout, inspect and run
`wacli --store DIR auth logout`; it connects and invalidates the session. The
user can also unlink the device in WhatsApp → Linked Devices. Logout does not
promise deletion of the local message archive. Archive deletion needs separate
authorization; don't remove the store as troubleshooting.

## evidence and stop conditions

Report the binary version, selected store (redact private path if needed), query
bounds, and sanitized result/blocker. Help is a binary smoke check; pairing,
sync, remote access, and sending remain separate runtime checks.

Source contracts: [v0.2.0 store path](https://github.com/openclaw/wacli/blob/v0.2.0/internal/config/config.go),
[auth and logout](https://github.com/openclaw/wacli/blob/v0.2.0/cmd/wacli/auth.go),
[doctor side effects](https://github.com/openclaw/wacli/blob/v0.2.0/cmd/wacli/doctor.go),
[storage layout](https://github.com/openclaw/wacli/blob/v0.2.0/docs/spec.md).
