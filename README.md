# nix-darwin config

Personal macOS setup. Declarative system management through nix-darwin + home-manager.

## Prerequisites

- [Nix](https://nixos.org/download) (with flakes enabled)
- [nix-darwin](https://github.com/LnL7/nix-darwin)

## Setup

### 1. Clone the Repository

```bash
git clone <repo-url> /private/etc/nix-darwin
cd /private/etc/nix-darwin
```

### 2. Install nix-darwin (if not already installed)

```bash
# First-time setup
nix-build https://github.com/LnL7/nix-darwin/archive/master.tar.gz -A installer
./result/bin/darwin-installer

# Reload shell
exec $SHELL
```

### 3. Build and Activate Configuration

```bash
# Build and switch to the configuration
darwin-rebuild switch --flake .#mbp14
```

### 4. Optional: Secrets Management

```bash
# Generate age key
age-keygen -o ~/.config/sops/age/keys.txt

# Get public key
age-keygen -y ~/.config/sops/age/keys.txt

# Add public key to .sops.yaml
sops secrets.yaml  # Edit encrypted values
```

## Maintenance Commands

```bash
# Apply configuration changes
darwin-rebuild switch --flake .#mbp14

# Test configuration without switching
darwin-rebuild build --flake .#mbp14

# Update flake inputs
nix flake update

# Clean up old generations
nix-collect-garbage -d

# Check flake validity
nix flake check
```

## Components

- **nix-darwin**: System-level configuration
- **home-manager**: User environment management  
- **nixvim**: Neovim configuration
- **sops-nix**: Encrypted secrets management
- **Karabiner**: Keyboard remapping

## Customization Points

- System behavior: `modules/darwin/default.nix`
- Development tools: `modules/home-manager/development.nix`
- Shell environment: `modules/home-manager/shell.nix`
- Neovim config: `modules/home-manager/neovim.nix`

## Tradeoffs

**Benefits**:
- Reproducible environments
- Version-controlled system state
- Encrypted secrets
- Modular configuration

**Costs**:
- Learning curve for Nix expressions
- Occasional build failures
- Limited package availability compared to Homebrew

## Troubleshooting

- Ensure Nix and nix-darwin are correctly installed
- Check flake inputs are up to date
- Verify system compatibility
- Consult [nix-darwin documentation](https://github.com/LnL7/nix-darwin)

## References

- [nix-darwin](https://github.com/LnL7/nix-darwin)
- [home-manager](https://github.com/nix-community/home-manager)
- [sops-nix](https://github.com/Mic92/sops-nix)
- [nixvim](https://github.com/nix-community/nixvim)