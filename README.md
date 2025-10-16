# nix layout — system vs user, bundles, hosts

quick decision tree:

- need a root-managed service/daemon?
  - put it in `nix/system/<name>.nix` (e.g., `ssh.nix`, `tailscale.nix`, `syncthing.nix`, `nvidia.nix`, `bluetooth.nix`, `flatpak.nix`).
- need user-level app/dotfiles/home-manager config?
  - put it in `nix/user/<name>.nix` (e.g., `shell.nix`, `nvim.nix`, `firefox.nix`, `ghostty.nix`, `pnpm.nix`, `apps.nix`).
- want to share a set of capabilities across machines?
  - compose them in `nix/bundles/*.nix` (import-only):
    - `base.nix`: `system/ssh`, `system/tailscale`, `user/shell`, fonts.
    - `desktop.nix`: `user/firefox`, `user/ghostty`, `system/bluetooth`, `user/apps`.
    - `dev.nix`: `user/nvim`, languages, `user/pnpm`.
    - `headless.nix`: `system/syncthing`, backups.
    - `wm/hyprland.nix`: window manager–specific profile.
- host definition?
  - `hosts/<host>/default.nix` imports bundles + tiny overrides.
  - keep hardware in `hosts/<host>/hardware.nix` only.
  - host-only helpers (e.g., `syncthing-automerge`) are imported here, not in bundles.

notes:
- pnpm globals are managed via `user/pnpm.nix` using PNPM_HOME symlinks; `pnpm add -g` writes to `01_files/nix/pnpm-global-package.json`.
- prefer inline `lib.mkIf pkgs.stdenv.isDarwin` / `isLinux` for small divergences.