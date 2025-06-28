# nix-darwin config

personal macos setup. declarative system management through nix-darwin + home-manager.

## components

- **nix-darwin**: system-level configuration
- **home-manager**: user environment management  
- **nixvim**: neovim configuration (kickstart-based)
- **sops-nix**: encrypted secrets management
- **claude integration**: custom commands from agent-guides
- **karabiner**: keyboard remapping via git submodule

## setup

```bash
git clone <repo-url> /private/etc/nix-darwin
cd /private/etc/nix-darwin
sudo darwin-rebuild switch --flake .
```

secrets require additional setup - see [SECRETS.md](./SECRETS.md).

## structure

```
flake.nix                           # entry point
hosts/mbp14.local/                  # host config
modules/
  ├── darwin/default.nix           # system defaults + homebrew
  └── home-manager/                # user environment
      ├── development.nix          # dev tools
      ├── shell.nix               # zsh + cli
      ├── neovim.nix              # editor
      └── claude.nix              # claude commands
config/karabiner/                   # keyboard config (submodule)
.sops.yaml                         # encryption setup
secrets.yaml                       # encrypted values
```

## secrets management

sops-nix handles encrypted secrets in version control:

```bash
age-keygen -o ~/.config/sops/age/keys.txt
age-keygen -y ~/.config/sops/age/keys.txt  # get public key
# add public key to .sops.yaml
sops secrets.yaml  # edit encrypted values
sudo darwin-rebuild switch --flake .
```

detailed process: [SECRETS.md](./SECRETS.md)

## maintenance

```bash
sudo darwin-rebuild switch --flake .    # apply changes
sops secrets.yaml                       # edit secrets  
nix flake update                         # update inputs
nix-collect-garbage -d                   # cleanup old generations
```

## customization points

- **system behavior**: `modules/darwin/default.nix`
- **development tools**: `modules/home-manager/development.nix`  
- **shell environment**: `modules/home-manager/shell.nix`
- **editor config**: `modules/home-manager/neovim.nix`
- **claude commands**: `modules/home-manager/claude.nix`

## tradeoffs

**benefits**: reproducible environments, version-controlled system state, encrypted secrets, modular configuration

**costs**: learning curve for nix expressions, occasional build failures from upstream changes, limited package availability compared to homebrew

**alternatives**: homebrew + dotfiles, ansible, chezmoi. nix provides stronger guarantees about system state but requires more investment to understand.

## references

- [nix-darwin](https://github.com/LnL7/nix-darwin) - macos system management
- [home-manager](https://github.com/nix-community/home-manager) - user environment
- [sops-nix](https://github.com/Mic92/sops-nix) - secrets management  
- [nixvim](https://github.com/nix-community/nixvim) - neovim configuration
- [agent-guides](https://github.com/tokenbender/agent-guides) - claude custom commands
