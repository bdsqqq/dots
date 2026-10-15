# tool setup: accounts, consent, and pairing

choose the execution host and account before authorizing a tool. provisioned
binaries are not authenticated access. publishing configuration does not activate
a host or complete account consent; the commands below are setup instructions,
not completed account checks.

## install first

use the synchronized live repository after the changes are integrated there,
not an unpublished worktree whose skill files are absent from the live paths.
activate the intended host through the normal Nix workflow:

```sh
# on the Mac, from its live checkout
sudo darwin-rebuild switch --flake .#mbp-m2

# alternatively, on the Linux execution host, from its live checkout
sudo nixos-rebuild switch --flake .#htz-xfs-lab
```

choose the applicable command, not both by default. check executable resolution
from the actual T3 provider environment afterward, then refresh skill discovery.
work and personal provider logins do not automatically separate tool accounts.

the agent module exposes the shared collection through four local aliases;
its CLI entrypoints link back to canonical skills beside each module. package
installation still requires explicit host imports. these links do not provision
credentials or complete consent. REA uses Pi's native installed-release path.

authorize Google/WhatsApp/X on the host that will run unattended work.
Reminders and Obsidian remain Mac/app capabilities. OpenHue needs LAN access to
a physical bridge; it is not the existing BLE service.

## Google: Gmail and Calendar

1. inspect the previous Google authorization before replacing it. an existing
   Workspace integration may use a different OAuth client or token format;
   do not assume its authorization transfers to `gog`.
2. use an approved Google Cloud project. enable **Gmail API** and
   **Google Calendar API**.
3. configure the OAuth consent screen/audience for the intended account. if the
   app is in testing, add that account as a test user. Workspace policy may
   require administrator approval.
4. create an OAuth client of type **Desktop app**, or reuse a compatible one.
   download its JSON into a private location, not tracked settings.
5. import it and authorize only the intended services. on Linux, configure the
   unattended keyring backend described below before running `auth add`;
   use `--manual` for a headless host.

```sh
ACCOUNT='you@example.com'
gog --client personal auth credentials set /private/path/client.json
gog --client personal auth add "$ACCOUNT" --services gmail,calendar --readonly
```

complete browser consent using the intended account. repeat with a separate
client name such as `work` when appropriate, and always select both client and
account for operational commands. start read-only; broader scopes are a separate
decision, not a fix for failed writes.

on a headless host, add `--manual` to the same `auth add` command. open the
printed URL in your browser and paste the resulting redirect URL into the
private terminal prompt. that URL contains an authorization code: do not put it
in chat, logs, or screenshots.

for unattended Linux use, configure the file backend with
`gog auth keyring file` and supply `GOG_KEYRING_PASSWORD` privately. persist that
password through SOPS and load its runtime file into the chosen process
environment. this owner/host wiring is still to be added; the CLI installation
does not currently provision it. macOS can use its native Keychain, but verify
that the actual execution process can unlock/read it without prompting.

test small reads in that same environment:

```sh
gog --client personal --account "$ACCOUNT" --no-input --json \
  gmail search 'newer_than:1d' --max 1
gog --client personal --account "$ACCOUNT" --no-input --json \
  calendar events primary --today --max 1
```

empty results can be valid. missing scopes, consent, or interactive keyring access
are blockers. do not copy private output into public artifacts.

Google refresh tokens for an external app in testing can expire after seven days;
Gmail/Calendar access is not covered by the basic-profile-only exception.
check [Google's expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration)
and the project's consent status before relying on recurring work. changing
publication status or requesting verification is a separate account action.

## WhatsApp

pick the final host and a private account-specific store:

```sh
STORE="$HOME/.local/share/wacli-personal"
wacli --store "$STORE" auth
```

on your phone: **WhatsApp → Settings → Linked Devices → Link a Device**.
scan the terminal QR. pairing also bootstraps sync; there is no read-only pairing
scope. keep the QR private.

after pairing, an explicitly requested one-shot catch-up is:

```sh
wacli --store "$STORE" sync --once
wacli --store "$STORE" --json messages search 'a known phrase' --limit 5
```

initial and backfilled history are best-effort, not a full archive. choose
`sync --follow` only when continuous sync is wanted, then wire its lifecycle
through the host's service manager. do not run two writers against one store.
the session/database is mutable device state, not a static token to distribute
to every host. keep it private; do not copy it between live processes.

## Google Places

in an approved Google Cloud project:

1. enable **Places API (New)** and billing.
2. create an API key with API restrictions for the required service and suitable
   server-side application restrictions. set quotas/budget alerts.
3. provide the key privately through SOPS. the existing module can consume it via
   `my.goplaces.apiKeyFile = config.sops.secrets.google_places_api_key.path`
   once that owner declares `google_places_api_key`. an owning credential
   declaration and encrypted value are still needed.

this is API-key access, not the Gmail OAuth grant. do not expose the key in a
tracked config, shell history, or Nix string. after provisioning:

```sh
goplaces search 'coffee in São Paulo' --limit 1 --json
```

requests may incur charges. Routes API is an additional prerequisite only if
route/directions work is requested.

## X

use an approved X developer app with OAuth2 user authentication enabled.
configure its permissions and callback URL; endpoint entitlement and billing
remain separate from OAuth success.

the pinned CLI registers an app with:

```sh
printf 'X client ID: '
IFS= read -r X_CLIENT_ID
printf 'X client secret: '
IFS= read -r -s X_CLIENT_SECRET
printf '\n'
xurl auth apps add personal --client-id "$X_CLIENT_ID" \
  --client-secret "$X_CLIENT_SECRET" \
  --redirect-uri http://localhost:8080/callback
unset X_CLIENT_ID X_CLIENT_SECRET
xurl --app personal auth oauth2
```

set that same callback URL in the developer portal. supply credentials through
private terminal input or an approved credential-provisioning path, not literal
values in copied commands. registration passes the client secret as a process
argument: shell variables avoid literal history entries, not process-argument
visibility. if that exposure is unacceptable, stop and establish a private
native-config provisioning path first; do not invent an unsupported stdin flag.

on a headless host, use `xurl --app personal auth oauth2 --headless`.
review the requested scopes before granting them; do not assume this flow is
read-only. retain refreshed tokens in the private writable native auth file.
use a separate app/account selection for work.

verify an approved bounded read with `xurl --app personal /2/users/me`.
do not print bearer/refresh tokens for diagnostics. authenticated does not mean
every X endpoint is available to that app.

## Hue Bridge

from a host on the bridge's LAN:

```sh
openhue setup
openhue get light
```

follow the prompt to press the physical bridge button. if discovery fails, use
`openhue setup --bridge BRIDGE_IP`. setup saves a private bridge key. inspect the
returned resources rather than treating exit status zero as proof of access.
if you only have BLE bulbs, this setup does not apply.

## Apple Reminders

on the Mac, in the execution context that should have access:

```sh
remindctl authorize
remindctl status --json
remindctl today --json
```

approve Reminders access. if needed, check **System Settings → Privacy & Security
→ Reminders** for the requesting executable/application. a grant to one terminal
is not proof that T3 or an SSH process can read the same data; test the actual
execution context afterward. no API token or repository settings file is needed.

## Obsidian and weather

- **Obsidian:** use a recent desktop installer (official CLI requires 1.12.7+),
  enable **Settings → General → Command line interface**, and keep the app running.
  then run `obsidian help` from the intended execution environment. the Mac module
  links the bundled helper; enabling the CLI and selecting a vault remain native
  app setup. ordinary Markdown reads do not require the app or an OAuth grant.
- **weather:** no account or token. existing `curl`/`jq` access is sufficient.

## what SOPS owns

static API keys, OAuth client credentials, keyring passwords, and intentional
credential exports can have stable owners under [the existing SOPS pattern](../SECRETS.md).
do not invent a plaintext tracked file or a fake encrypted value to finish setup.

refreshable native state stays writable. `gog` supports token export/import,
but exports contain secrets: use that only for an intentional encrypted
bootstrap/transfer, not troubleshooting. importing an old copy on every
activation can undo renewal. WhatsApp device state is not interchangeable with
an OAuth refresh token.

the SSD module now imports and requires `modules/backup/ssd-01/credential.nix`, consuming the
existing encrypted repository password through its SOPS runtime file. it does
not distribute SSH private identities: `my.ssd01Backup.sshKeyPath` and
`knownHostsPath` explicitly select existing host identity/trust. before canary
writes, the drive hook checks those files and authenticates a bounded, no-lock
repository-config read against the expected GUID. an absent drive still cancels
quietly. network/auth failures stop that backup, not system activation.

you choose accounts, approve scopes, scan the QR, press the bridge button, and
grant OS/app access. credential ownership, scoped recipients, runtime-file
adaptation, service wiring, and restart checks are implementation work—not
something you need to design manually.

commands above were checked against help for the packaged versions where
available. authentication, pairing, consent, and private API reads have not been
executed here. use the colocated skills for operation-specific boundaries.
