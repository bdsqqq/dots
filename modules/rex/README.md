# rex

rex is the pilot for **upstream → validated git pin → main → host apply**.
publishing the release decision is separate from installing it. hosts never
independently chase the moving upstream channel.

## publisher

`.github/workflows/rex-update.yml` runs every 15 minutes or on manual dispatch:

1. check out `main`, run the helper tests, and prepare `release.json` from the
   upstream snapshot feed. unchanged/older releases do not create a commit;
   changed hashes for an already pinned version fail closed.
2. freeze that candidate as one workflow artifact. native x64 and arm64 linux
   Depot GitHub Actions runners download its exact archives, verify sha256, and
   check `--help`, exact version, and commit. neither validator refetches the
   moving channel.
3. only after both pass, a write-scoped job commits **only** `release.json` and
   pushes directly to `main`. a moving main or protected-branch rejection fails;
   there is no force-push, rebase, or policy bypass. the next run can retry.

`release.json` records version, upstream commit, and canonical archive URLs and
hashes for both linux architectures. its initial entry matches the existing
bootstrap pin. `flake.lock` still pins upstream's nix module, terminfo, ssh
fallback, and bootstrap archive; it is not the runtime release authority.

the publisher needs no pre-release token: upstream's release feed and binary
artifacts are public. only its final job gets the repository's `GITHUB_TOKEN`
write permission. git remains the distribution boundary, so the publisher could
move to a designated local host without changing host consumers. github's
schedule is best effort, not a 15-minute delivery guarantee.

### depot runner connection

validation uses `depot-ubuntu-24.04` and `depot-ubuntu-24.04-arm`; preparation and
publication stay on GitHub-hosted runners. connect `bdsqqq/dots` to the personal
**bedesqui** Depot organization before enabling the schedule on main. the
organization token belongs only in `modules/depot/secrets.yaml` for local
management; managed runners do not need it copied into workflow secrets.

this is a public repository, so the Depot GitHub App/runner group must permit
this repository and public-repository jobs. a zero-length runner listing does
not prove that ephemeral runners are unconfigured. verify enrollment with the
organization API/dashboard and an actual validation run, not just a YAML label.
Depot's macOS runners are available for future Darwin build workflows; this
pilot publishes Linux server artifacts only.

## host apply

on all three linux hosts, `rex-update.timer` polls the **published main record**
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
# manually run the central publisher (after the workflow is merged)
gh workflow run rex-update.yml --ref main

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

publisher tests execute the actual workflow push gate against temporary local
bare repositories, including moving-main and unexpected-staged-file failures.
updater tests use isolated files/fake service commands. neither proves live
linux nix-ld/pam loading, tailscale enrollment, or session preservation.

upstream:
<https://www.superlogical.com/rex/docs/linux/installation>,
<https://www.superlogical.com/rex/docs/linux/upgrading>.
