---
name: gog
description: "Use gog for bounded Gmail searches and Calendar queries, or explicitly requested Google account setup. Use for Gmail or Google Calendar CLI work; not WhatsApp, generic email drafting, Drive/Docs/Sheets, or bulk mailbox processing."
---

# gmail and calendar with gog

## start with the account and operation

1. Run `gog --version` and the relevant `--help`. The executable is `gog`,
   package name `gogcli`; options differ between releases. This module uses the
   pinned nixpkgs package. Use only Gmail and Calendar here.
2. Establish the intended account explicitly with `--account EMAIL`; do not
   infer it from a default or choose among accounts silently. For multiple OAuth
   clients, also use `--client NAME` consistently.
3. Bound reads by query/time range and result count. For example:
   `gog --account EMAIL gmail search 'newer_than:7d' --max 10 --json`.
   Inspect `gog calendar events --help` before choosing the calendar ID and date
   flags. Return only the requested information, not whole mail bodies or exports.
4. Stop on missing credentials, absent service scope, ambiguous identity, or an
   unexpected permission prompt. Report the missing prerequisite. Installation
   does not establish authentication or consent to access private data.

Sending mail, modifying messages, creating/updating events, inviting attendees,
and deleting data require authorization for the specific action. Inspect the
command help and concrete recipient/content/event before execution. A request
for search or a draft does not authorize a write.

## private auth lifecycle — only when requested

Safe setup inspection starts with help and filesystem metadata. Do not dump
`credentials*.json`, keyring entries, exported tokens, or mail contents. Even
`gog auth list` may unlock the keyring; use it only within authorized account
inspection, without `--check` unless a network token check was requested.

For explicit first-time authorization, the user supplies a Google OAuth desktop
client JSON outside the repository and completes browser consent:

```sh
gog auth credentials set /private/path/client.json
gog auth add EMAIL --services gmail,calendar --readonly
```

This requests Gmail/Calendar read-only scopes plus identity scopes; the v0.29.0
source maps these to `gmail.readonly` and `calendar.readonly`. Never omit
`--services`: its default includes other services. Do not upgrade scopes for a
failed write without approval. Write-capable Gmail/Calendar auth omits
`--readonly`, only after the user agrees to the broader access.

Inspect `gog auth keyring --help` before selecting a backend. macOS normally
uses Keychain; Linux backend selection depends on available keyring support.
`gog auth keyring file` stores encrypted tokens on disk and needs a private
`GOG_KEYRING_PASSWORD` for unattended use. Never store that password, client
secret, refresh token, or access token in plaintext tracked files or Nix values.
SOPS can provision private credential files; it must not overwrite newer
tool-written refresh state on every activation. Do not
export tokens for troubleshooting. For explicitly requested local removal:
`gog --account EMAIL auth remove EMAIL` (inspect help first). Local token removal
is distinct from revoking Google's grant; the user can revoke it in their Google
account's third-party access settings.

## writable state contract

Native config is `config.json` under:

- macOS: `~/Library/Application Support/gogcli/`
- Linux: `${XDG_CONFIG_HOME:-$HOME/.config}/gogcli/`

`gog config path` reports the actual path. Credentials live alongside config;
file-backend tokens live under `keyring/`, while Keychain tokens stay in Keychain.
Keep all of these private and native-writable. Config writes create a `.tmp`
file and rename it over `config.json`, replacing a file symlink. No tracked
config is installed: no nonsecret override is required, and symlinking the
whole credential directory into the repository would expose private state.
Recheck paths with installed help after a package upgrade.

## evidence and stop conditions

Report the binary version, account selected, bounded command, and sanitized
result or exact blocker. Auth, keyring access, API reads, and writes are separate
runtime checks; a successful help smoke check proves none of them.

Source contracts: [v0.29.0 config writer](https://github.com/openclaw/gogcli/blob/v0.29.0/internal/config/config.go),
[upstream usage](https://github.com/openclaw/gogcli/tree/v0.29.0),
and [scopes](https://github.com/openclaw/gogcli/blob/v0.29.0/internal/googleauth/service.go).
Installed help and `gog config path` are the command/path checks.
