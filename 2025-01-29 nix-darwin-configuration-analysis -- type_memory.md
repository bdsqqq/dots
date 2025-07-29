---
title: 2025-01-29 nix-darwin-configuration-analysis
type: note
permalink: type-memory/2025-01-29-nix-darwin-configuration-analysis
---

# nix-darwin configuration analysis

technical analysis of bdsqqq's nix-darwin configuration located at `/private/etc/nix-darwin`

## architecture overview

the configuration implements a cross-platform nix setup supporting both darwin and linux systems. uses flake-parts for organization and specialArgs for parameter passing across modules.

## module organization

**shared/**: contains cross-platform functionality including fonts, theming, and basic packages
**darwin/**: contains macos-specific configuration including system defaults, homebrew, and kanata setup  
**home-manager/**: contains user-level configuration with conditional linux-specific imports
**nixos/**: contains linux system configuration with hardware support

conditional imports use `lib.optionals (!isDarwin)` pattern for platform separation.

## package management approach

the configuration implements three package management strategies:
- nix for most packages
- homebrew for mac-specific gui applications that lack nix packaging
- pnpm global packages managed through home-manager activation hooks

unstable overlay creates `pkgs.unstable` namespace while maintaining stable packages as default.

## theming implementation

single `polarity` variable controls light/dark themes across the system. coordinates three components:
- base16 color schemes (e-ink vs e-ink-light)
- wallpaper images (loupe-dark vs loupe-light)  
- stylix polarity setting

uses e-ink color schemes with 0.65 opacity for translucent elements.

## font configuration

berkeley mono configured as primary monospace font. fontconfig uses "strong" binding to override system defaults. explicitly blocks dejavu and liberation fonts using `<selectfont><rejectfont>` patterns.

## input management

uses kanata for cross-platform keyboard remapping. implements:
- homerow mods with smart typing detection
- 60-second test mode with automatic process cleanup
- hardware exclusions for corne and moonlander keyboards

timing configuration:
- 150ms tap timeout 
- 250ms fast typing window (disables homerow mods during rapid typing)
- 250ms hold timeout for tap-hold behavior

## network configuration

syncthing configured for tailscale-only operation:
- `globalAnnounceEnabled = false`
- `relaysEnabled = false` 
- `natEnabled = false`
- listens only on tailscale interface

devices defined declaratively with fixed tailscale ip addresses.

## development toolchain

includes cli alternatives (eza, bat, ripgrep, delta), language support (go, python, node with fnm), secret management with sops-nix, and ai tools (claude-code, opencode-ai, sourcegraph/amp).

## technical implementation details

### overlay mechanism
implemented in `overlays/unstable.nix`:
```nix
inputs: final: prev: {
  unstable = import inputs.nixpkgs-unstable {
    inherit (final) system;
    config.allowUnfree = true;
  };
}
```

### kanata smart typing detection
```kanata
(deftemplate charmod (char mod)
  (switch 
    ((key-timing 3 less-than 250)) $char break
    () (tap-hold-release-timeout 150 250 $char $mod $char) break
  )
)
```

### specialArgs configuration
```nix
specialArgs = {
  inherit inputs;
  inherit (inputs.nixpkgs.lib) systems;
  pkgsFor = system: import inputs.nixpkgs {
    inherit system;
    config.allowUnfree = true;
    overlays = [ (import ./overlays/unstable.nix inputs) ];
  };
};
```

### steam configuration
- macos: installed via homebrew cask
- linux: uses `programs.steam.enable = true` with `hardware.steam-hardware.enable = true`
- includes `SDL_JOYSTICK_HIDAPI_PS5_RUMBLE = "0"` environment variable for ps5 controller bluetooth compatibility

## system integration

implements launchd daemon setup for kanata, wireplumber audio routing configuration, nvidia wayland optimization, and font rendering control. uses apple cursor theme on linux.

## git history pattern

git log shows progression through phases: foundation setup, theming integration, input system refinement, toolchain optimization, and application-specific configuration.

## configuration dependencies

uses unstable nixpkgs and master branch inputs. includes bleeding-edge versions for pnpm packages. requires tailscale for syncthing functionality. assumes specific user setup (bdsqqq username, specific directory paths).