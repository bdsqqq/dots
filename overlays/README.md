# Overlays

This directory contains NixOS overlays for customizing the package set.

## Unstable Packages Overlay

The `unstable.nix` overlay provides access to bleeding-edge packages from `nixos-unstable` while keeping stable packages as the default.

### Usage

#### Stable packages (default)
```nix
# Uses stable version from nixpkgs-unstable
pkgs.packageName
```

#### Unstable packages
```nix
# Uses bleeding-edge version from nixos-unstable  
pkgs.unstable.packageName
```

### Examples

```nix
environment.systemPackages = [
  pkgs.vim              # Stable vim
  pkgs.unstable.neovim  # Latest neovim from unstable
  pkgs.git              # Stable git
  pkgs.unstable.zellij  # Latest zellij from unstable
];
```

### When to use unstable packages

- Latest features not yet in stable
- Bug fixes that haven't been backported
- Packages with frequent updates you want to track
- Development tools that benefit from latest versions

### Caution

Unstable packages may:
- Introduce breaking changes
- Have dependency conflicts
- Be less tested than stable versions

Use selectively for packages where you need the latest features.
