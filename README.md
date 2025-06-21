# nix-darwin config

personal macos setup with nix-darwin + home-manager.

## what's here

- **nix-darwin** system config
- **home-manager** user environment
- **nixvim** (kickstart fork) for neovim
- **sops-nix** encrypted secrets
- **chalice icons** custom font

## quick start

```bash
git clone <repo-url> ~/.config/nix-darwin
cd ~/.config/nix-darwin
sudo darwin-rebuild switch --flake .
```

**secrets setup**: see [SECRETS.md](./SECRETS.md)

## structure

```
configuration.nix    # system config
home.nix            # user config
flake.nix           # dependencies
.sops.yaml          # encryption config
secrets.yaml        # encrypted secrets
kickstart.nixvim/   # neovim setup
pkgs/               # custom packages
```

## secrets

uses sops-nix for encrypted secrets in git. quick setup:

```bash
age-keygen -o ~/.config/sops/age/keys.txt
age-keygen -y ~/.config/sops/age/keys.txt  # copy this
# update .sops.yaml with public key
sops secrets.yaml  # add secrets
sudo darwin-rebuild switch --flake .
```

full guide: [SECRETS.md](./SECRETS.md)

## daily commands

```bash
sudo darwin-rebuild switch --flake .    # rebuild
sops secrets.yaml                       # edit secrets
nix flake update                         # update packages
```

## customization

- **system**: edit `configuration.nix`
- **user**: edit `home.nix`
- **neovim**: see `kickstart.nixvim/README.md`
- **secrets**: see `SECRETS.md`

## references

- [nix-darwin](https://github.com/LnL7/nix-darwin)
- [home-manager](https://github.com/nix-community/home-manager)
- [sops-nix](https://github.com/Mic92/sops-nix)
- [nixvim](https://github.com/nix-community/nixvim)
