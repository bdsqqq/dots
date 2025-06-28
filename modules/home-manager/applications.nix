{ config, pkgs, lib, ... }:

{
  home.packages = with pkgs; [
    _1password-gui
    _1password-cli

    docker
    blockbench
    tableplus

    iina
    obsidian
    prismlauncher
    spicetify-cli
    spotify-player
    transmission_4
    rclone

    # Note: Apps not available or broken on current nixpkgs:
    # - ghostty (marked as broken)
    # - obs-studio (not available on macOS in nixpkgs)
    # - figma-linux (Linux-specific)
    # - linear-linear, notion-calendar (not found in nixpkgs)
  ];
}
