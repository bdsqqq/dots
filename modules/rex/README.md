# rex

linux hosts run the upstream login server as a system service. only
`tailscale:igorbedesqui@gmail.com` maps to `bdsqqq`; no anonymous or public tcp
listener is enabled. rex reuses host tailscaled through tailscale serve on https
port 7297, leaving existing 443 mappings alone. the tailnet must have https
enabled. without tailscale, only the local unix listener remains.

macs retain the editable app config. they also need the package credential:
ssh fleet generation evaluates linux hosts, which consumes the protected rex
flake input even during a mac rebuild.

## package credential and first build

`credential.nix` owns the encrypted `rex_netrc` in `secrets.yaml`. sops decrypts
it to a root-owned `0400` runtime file; `nix.settings.netrc-file` points there.
no token belongs in a flake url, nix string, generated unit, or store file.

before the first activation, that runtime file does not exist. bootstrap a
build with an owner/host age key already available to sops (bash):

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

select the intended host output; macs use `darwinConfigurations.<host>.system`.
this builds only, not activates. remote builders/evaluators need their own
runtime credential; do not copy it into the store. after activation, root-run
upgrades use the sops file automatically. to update the snapshot pin, run
`sudo nix flake update rex` on a configured host.

## checks and connection

```bash
nix eval --impure --expr 'import ./modules/rex/test.nix { flake = builtins.getFlake (toString ./.); }'
systemctl status rex-login-server rex-tailscale-serve
tailscale serve status
```

run the last two checks on enrolled hosts after deployment, for each linux
host. connect the rex client to `https://<host>.<tailnet>.ts.net:7297`. an evaluated unit is not evidence of enrollment, https readiness,
or a successful rex session. account policy reloads preserve permitted sessions.

upstream: <https://www.superlogical.com/rex/docs/linux/installation>.
