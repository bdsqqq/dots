# rex

the linux CLI follows the build bundled in the **Rex.app a mac accepted**, not
the upstream channel head. publishing the release decision is separate from
installing it; hosts never independently chase the moving upstream channel.

## publisher

[app-pins](../app-pins/README.md) watches `/Applications/Rex.app` on each mac.
when Sparkle replaces the bundle, it records the app build in `app-pin.json`
and reads the CLI commit from that build's signed appcast notes
("Rex … (`<commit>`)"). it then fetches that exact commit's linux archives
from `api/releases/rex/snapshot?commit=…` and advances `release.json` only when
the build is newer. the change stays uncommitted in the working tree, like a
pnpm edit; publishing it to `main` is an ordinary commit.

`release.json` records version, upstream commit, and canonical archive URLs and
hashes for both linux architectures. `flake.lock` still pins upstream's nix
module, terminfo, ssh fallback, and bootstrap archive; it is not the runtime
release authority. the former 15-minute Depot CI publisher is retired: it
committed whatever upstream published, whether or not anyone ran it.

## host apply

on every configured linux host, `rex-update.timer` polls the **published main record**
two minutes after boot and every 15 minutes after its last run finishes. it
checks the archive hash and exact build again before installing and restarting
a running login server. it does not wait for a host rebuild or modify git.

`/usr/local/bin/rex` is the single writable executable used by cli and systemd.
nix seeds it only when absent, from the upstream archive rather than a
store-patched executable. nix-ld and pam support later native replacements.
rebuilds preserve existing installations; backups do not embed old store loaders.

native edits remain intentional divergence: a newer manual installation is not
downgraded to the published pin, and a concurrent replacement is preserved.
`rex-apply.path` can validate/apply a native replacement offline. this is not a
claim that the mac client has a remote linux-update control.

apply/download jobs share a lock. publication briefly removes the executable
path before a no-replace link, as a native installer can; racing native writes
are retained. failed validation/restart attempts restore the last validated
executable. if publication and restoration both fail, the job fails and logs
the retained recovery path instead of deleting it.

only executable/receipt/recovery files are managed here, not account policy,
app settings, service drop-ins, or session data. stopped services stay stopped.
only the login server is restarted; upstream's account servers retain their
version until idle, preserving their sessions. installed convergence is therefore
not proof that every existing account server is already on the new version.

## observe and catch up

```bash
# record the installed Rex.app (and its CLI) on a mac
node modules/app-pins/pins.ts record "$PWD" rex

# on each activated linux host
sudo systemctl start rex-update.service
sudo /run/current-system/sw/bin/rex-update --status
systemctl status rex-update.service rex-apply.path rex-login-server rex-tailscale-serve
rex version
rex server status
tailscale serve status
```

the receipt can also be inspected directly:

```bash
sudo cat /var/lib/rex-update/applied.json
```

an apply receipt records the git-published release and installed binary hash.
a receipt is installation evidence, not a session/availability health check.
check the published record, installed version, receipt hash, running account
version, and service logs on **each** host. an offline host, failed apply, stopped
service, or newer manual install is not convergence.

## tailscale and credentials

linux runs the upstream login server. only `tailscale:igorbedesqui@gmail.com`
maps to `bdsqqq`; anonymous/public tcp listeners are disabled. rex reuses host
tailscaled through tailscale serve on https port 7297, leaving 443 mappings
alone. the tailnet must have https enabled. macs retain their app updater and
editable config link.

`credential.nix` owns encrypted `rex_netrc` in `secrets.yaml`. sops decrypts it
to a root-owned `0400` runtime file; `nix.settings.netrc-file` points there.
fetching the protected upstream nix flake needs it, including on macs whose ssh
fleet generation evaluates linux hosts. no plaintext token belongs in git,
a flake url, generated unit, store file, or github workflow.

before first activation, bootstrap a build with an available age key (bash;
this builds only, not activates):

```bash
(
  set -euo pipefail
  umask 077
  netrc=$(mktemp)
  trap 'rm -f "$netrc"' EXIT
  SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt" \
    sops --decrypt --extract '["rex_netrc"]' modules/rex/secrets.yaml > "$netrc"
  nix --option netrc-file "$netrc" build --no-link --no-write-lock-file \
    .#nixosConfigurations.htz-xfs-lab.config.system.build.toplevel
)
```

select the intended host; macs use `darwinConfigurations.<host>.system`.
root-run host upgrades use the runtime sops file after activation. the pilot
workflow must be merged to main and the service wiring activated once before
its timers can propagate releases.

## checks

```bash
node --test modules/rex/*.test.ts
nix eval --impure --expr 'import ./modules/rex/test.nix { flake = builtins.getFlake (toString ./.); }'
```

app-pins tests cover recording/installing the mac app. updater tests use isolated files/fake service commands. neither proves live
linux nix-ld/pam loading, tailscale enrollment, or session preservation.

upstream:
<https://www.superlogical.com/rex/docs/linux/installation>,
<https://www.superlogical.com/rex/docs/linux/upgrading>.
