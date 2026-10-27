# depot

native Depot CLI installation plus an opt-in, sops-backed organization command.
`depot` keeps its user-owned login/config; `depot-org` supplies the organization
credential only to the requested process. no account switching, login, runner
enrollment, builds, or uploads run during activation.

## fill the credential

```bash
SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt" \
  sops modules/depot/secrets.yaml
```

replace the empty `depot_org_token` value with an organization token from your
**bedesqui** organization. the file is a real sops document with an intentionally
empty draft value, not a working credential. sops encrypts the value when saved;
`depot-org` rejects an empty/malformed runtime credential before invoking Depot.
never paste the token into chat, a command argument, or native `depot.yaml`.

`.sops.yaml` grants only the personal age recipient access to this owner file.
only `mbp-m2` currently requires the credential, decrypted as
`/run/secrets/depot_org_token`, owned by `bdsqqq`, mode `0400`. other macs still
install the native CLI but do not declare this secret or install `depot-org`.
no CI key or fleet host recipient is added.

## use after activation

activate the module on `mbp-m2` once to install the command and decrypt its
runtime credential. then a bounded, read-only authentication probe is:

```bash
depot-org jobs --repo bdsqqq/dots --page-size 1 --output json
```

a successful probe establishes API access, not that the GitHub App, runner
connection, capacity, or billing are configured. those remain separate steps.
use plain `depot login`/`depot org switch` to manage native user state.

for each invocation, the adapter sets `DEPOT_TOKEN` and `DEPOT_API_TOKEN`
(the CLI has two token consumers), supplies the explicitly configured
organization ID, and defaults a missing `XDG_CONFIG_HOME` to Home Manager's
config directory. an explicit config home is respected. it does not export
credentials into parent shells or rewrite native login files. explicit native
commands still retain their normal effects.

`auth.ts` is consumed from the editable commonplace checkout. after the initial
wiring activation, changing the adapter does not require rebuilding the host.
Homebrew owns normal CLI upgrades; this module owns the `depot/tap` prerequisite.

## checks

```bash
node --test modules/depot/auth.test.ts
nix eval --impure --expr 'let f = builtins.getFlake (toString ./.); in import ./modules/depot/test.nix { lib = f.inputs.nixpkgs.lib; }'
```

fixtures test empty/missing credentials, both token environment names, explicit
organization scope, and a child process without inherited XDG/auth exports.
no real API grant is claimed until a populated token is tested.
