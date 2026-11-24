# dots

my machines, described with nix-darwin, NixOS, and Home Manager: three macs, a
handheld, and a few Hetzner boxes.

most nix setups make the store the source of truth, and every settings change
becomes a rebuild. I didn't want that. programs keep their config in ordinary
tracked files linked out of the repo, so Ghostty, Niri, or Pi can rewrite their
own settings and `pnpm add -g` just installs a package. Nix makes sure each
machine has what those programs need; the programs stay in charge of their own
files. [modules/README.md](modules/README.md) walks through how a module is
wired that way.

## finding things

each machine is one file, `hosts/<name>/default.nix`, that imports every
feature it runs. there are no shared `base` or `desktop` profiles, so that file
is the whole answer to "what's on this machine". each feature is one directory,
`modules/<feature>/`, holding its nix, native config, tests, secrets, and agent
skill.

| host          | platform       | role                                |
| ------------- | -------------- | ----------------------------------- |
| `mbp-m2`      | aarch64-darwin | main laptop                         |
| `mbp-m5`      | aarch64-darwin | work laptop                         |
| `mmn-m4`      | aarch64-darwin | household storage and media         |
| `lgo-z2e`     | x86_64-linux   | Legion Go handheld, Niri and Steam  |
| `htz-relay`   | x86_64-linux   | storage, Syncthing, app relay       |
| `htz-lab`     | x86_64-linux   | agent host                          |
| `htz-xfs-lab` | x86_64-linux   | agent host, XFS/VDO storage testing |

## keeping machines current

I push to `main` and mostly forget about it: every host rebuilds itself hourly
from the published flake ([modules/nix](modules/nix/README.md)). dependency
bumps show up as PRs from the flake-update workflow. apps that update
themselves, like Rex, Helium, or the Claude and Codex CLIs, work the other way
round: whichever machine updates first commits the version it got, and the
rest follow ([app-pins](modules/app-pins/README.md)).

when I don't want to wait for the hour:

```bash
sudo darwin-rebuild switch --flake .#mbp-m2
sudo nixos-rebuild switch --flake .#lgo-z2e
```

## services and secrets

services reachable over my tailnet are declared next to the feature that runs
them, in `tailnet-app.nix`. the Tailscale policy and Cloudflare config are
generated from those declarations with `nix run .#generate-tailnet-artifacts`.

secrets are sops-encrypted and also live with their feature, in
`secrets.yaml`. [SECRETS.md](SECRETS.md) covers keys and rotation.
