# gog auth provisioning

imports default to **package-only**, with `my.gog.enable = false`. installing
`gog` does not authenticate Gmail or Calendar. `gog-auth ready` fails in this
mode, with setup guidance; nothing chooses a work/personal account implicitly.

an operator must select `my.gog.account` (email), `my.gog.client` (normalized
named client; `default` is allowed when intentional), and enable `my.gog.enable`.
`my.gog.services` defaults to `[ "gmail" "calendar" ]`, supports only those
services, and cannot be empty when enabled.

`credential.nix` owns `gog_oauth_client` and, for file keyrings,
`gog_keyring_password`. `my.gog.credential.sopsFile` defaults to adjacent
`secrets.yaml` only when it exists; otherwise it is null. enabling auth without
that existing owner file fails evaluation. the operator supplies the actual
Google desktop OAuth client JSON as the encrypted `gog_oauth_client` value and
an encrypted password as `gog_keyring_password` when using a file keyring.
no credential values go into Nix options. see [secret ownership](../../SECRETS.md).

linux defaults to and requires the unattended `file` backend with a SOPS
password. macos defaults to native `keychain`, without a password requirement;
`file` is also available there with the SOPS password. keychain access can still
require the user's normal macos unlock/permission flow. no activation imports
clients, obtains consent, resets config or rewrites tokens/keyrings.

manual setup after provisioning the private runtime files:

```sh
gog-auth bootstrap-client
# deliberately authorize the declared account; EMAIL must match my.gog.account:
gog auth add EMAIL --services gmail,calendar --readonly
gog-auth ready
```

bootstrap imports only the static client with `auth credentials set`. it skips
an existing named client after privately checking its client ID; a different
existing client ID fails instead of replacing it. it never imports/removes
refresh tokens or starts consent. existing credentials needing deliberate
rotation require the native private setup flow. the integration wrapper pins
the configured account/client and loads the SOPS password process-locally.

## headless setup and recovery over SSH

use the same runner, Unix user, and configured client for both steps. the runner
never needs a browser, desktop session, public callback endpoint, or SSH port
forward. after the enabled host config is shipped to main and activated:

```sh
gog-auth bootstrap-client
gog auth add EMAIL --services gmail,calendar --readonly --force-consent --remote --step 1 --timeout 15m
```

open the printed Google URL in a browser on any device and select the declared
account. after approval, the browser's loopback redirect may fail to connect:
that is expected for this flow. copy the **entire resulting redirect URL** from
the address bar and finish in the SSH terminal:

```bash
set +x
read -r -s -p 'Paste the complete redirect URL: ' redirect_url
printf '\n'
gog auth add EMAIL --services gmail,calendar --readonly --force-consent --remote --step 2 --auth-url "$redirect_url"
unset redirect_url
gog-auth ready
```

do not paste that URL into chat, tickets, or shell command history: it contains
a short-lived authorization code. `read -s` keeps the pasted value out of the
terminal display/history, but the native CLI receives it briefly as an argument;
use the runner's private Unix account. an expired pending flow needs a new
step 1, not a new OAuth app. inspect `gog auth add --help` after CLI upgrades.

## what survives updates and reboots

there are two different things to preserve:

- **static prerequisites:** SOPS owns the desktop client JSON and file-keyring
  password. `secrets.yaml` is encrypted only to the personal owner and
  `htz-xfs-lab`, the selected runner. do not rotate the
  keyring password underneath an existing encrypted keyring.
- **native mutable authorization:** `gog` owns refresh tokens and its encrypted
  keyring on the runner. keep the configured user's home on persistent disk;
  for containers, mount that home (or all selected XDG config/data/state/cache
  directories) on persistent storage. `gog config path` reports the actual
  config location. pending remote-consent state must also survive between the
  two SSH commands.

keep private directories owner-only and exclude them from Git, the Nix store,
and deployment cleanup. back up native auth state privately, together with the
ability to recover its keyring password. restoring an old token snapshot on each
activation can undo native refreshes; bootstrap/activation must not do that.
macOS Keychain authorization stays on that Mac unless deliberately migrated:
shipping the static SOPS client does not transfer an account grant to Linux.

normal calls refresh short-lived access tokens automatically. browser consent
is for first authorization or recovery after Google invalidates the grant,
not routine deployments. the external OAuth project's **In production** status
avoids the testing-mode seven-day refresh-token limit, not every possible
revocation. see [Google's expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

after deployment, test `gog-auth ready` from the actual job user/environment.
the scheduler must surface a failed readiness check as an actionable auth
failure, rather than retry consent or silently broadening scopes. this module
does not install a schedule, notification destination, or remote runner.

readiness checks native credential client ID, resolved client/account/backend,
and stored OAuth services/scopes, then invokes `gmail search newer_than:1d
--max 1` and/or `calendar calendars --max 1` with `--json --no-input`. each
subprocess is bounded to 15 seconds; no all-pages or token-export operation is
used. it discards captured private responses and emits only a fixed summary.
these manual probes access private Google data and consume API quota; they
never run during evaluation, activation or verification. native token refresh
by an invoked Google read is normal; provisioning never overwrites that state.

Nix installs small exec wiring to the live absolute
`${my.paths.commonplace}/01_files/nix/modules/gog/auth.ts` and shared
`../tool-auth/process.ts`, using Node's native TypeScript support. native source
is not copied into the store. this checkout and helper must exist at that live
path; the evaluated package does not prove runtime/auth readiness.

flags and JSON shapes were traced to pinned gogcli v0.29.0:
[credentials](https://github.com/openclaw/gogcli/blob/v0.29.0/internal/cmd/auth_credentials.go),
[account status/list](https://github.com/openclaw/gogcli/blob/v0.29.0/internal/cmd/auth_accounts.go),
[list JSON](https://github.com/openclaw/gogcli/blob/v0.29.0/internal/cmd/auth_list_helpers.go),
[scopes](https://github.com/openclaw/gogcli/blob/v0.29.0/internal/googleauth/service.go),
[bounded calendars](https://github.com/openclaw/gogcli/blob/v0.29.0/internal/cmd/calendar_list_cmds.go),
and [bounded Gmail](https://github.com/openclaw/gogcli/blob/v0.29.0/internal/cmd/gmail_search.go).
verify flags again after a version change.

local verification: `node --test modules/gog/auth.test.ts
modules/goplaces/auth.test.ts`. `auth-eval.nix` is an isolated module assertion
fixture, not an encrypted secret or evidence of decryption/authentication.

```sh
GOG_TEST_BINARY="$(command -v gog)" node --test modules/gog/headless.test.ts
```

the native headless fixture uses synthetic credentials and a temporary home:
it checks offline/read-only scopes, persisted private PKCE state across CLI
processes, and rejection of a wrong callback without consuming that state.
it neither authorizes an account nor exercises the real code exchange.
