# nix layout — system vs user, bundles, hosts

quick decision tree:

- need a root-managed service/daemon?
  - put it in `nix/system/<name>.nix` (e.g., `ssh.nix`, `tailscale.nix`, `syncthing.nix`, `nvidia.nix`, `bluetooth.nix`, `flatpak.nix`, `audio.nix`, `login.nix`, `fonts.nix`, `nix.nix`).
- need user-level app/dotfiles/home-manager config?
  - put it in `nix/user/<name>.nix` (e.g., `shell.nix`, `nvim.nix`, `ghostty.nix`, `bun.nix`, `apps.nix`, `hyprland.nix`).
- want to share a set of capabilities across machines?
  - compose them in `nix/bundles/*.nix` (import-only):
    - `base.nix`: `system/nix`, `system/ssh`, `system/tailscale`, `user/shell`, `system/fonts`.
    - `desktop.nix`: `system/audio`, `system/bluetooth`, `system/flatpak`, `user/ghostty`, `user/apps`.
    - `dev.nix`: `user/nvim`, languages, `user/bun`.
    - `headless.nix`: `system/syncthing`, backups.
    - `wm/hyprland.nix`: `system/login`, `user/hyprland`.
- host definition?
  - `hosts/<host>/default.nix` imports bundles + tiny overrides.
  - keep hardware in `hosts/<host>/hardware.nix` only.
  - host-only helpers (e.g., `syncthing-automerge`) are imported here, not in bundles.

notes:
- bun globals are managed via `user/bun.nix` using BUN_INSTALL symlinks; `bun add -g` writes to `01_files/nix/bun/global-package.json`.
- flatpak/zen-browser provided via `system/flatpak.nix` imported in `desktop.nix`.
- ghostty: brew cask in `user/ghostty.nix` (exception: broken nix pkg on darwin); linux uses nix package.

## platform-specific modules

for modules with platform-specific options (e.g., launchd on darwin, services.* on linux):

```nix
{ lib, hostSystem ? null, ... }:
if !(lib.hasInfix "linux" hostSystem) then {} else {
  # linux-only config
}
```

- `hostSystem` is passed via `specialArgs` at flake level (both system and home-manager contexts)
- use top-level `if-else` to return empty attrset for wrong platform
- avoids `pkgs.stdenv` recursion and `mkIf` structure evaluation issues
- examples: `system/syncthing.nix`, `system/audio.nix`, `user/hyprland.nix`