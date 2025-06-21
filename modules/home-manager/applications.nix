{ config, pkgs, lib, ... }:

{
  home.packages = with pkgs; [
    # Password management
    _1password-gui
    _1password-cli

    # Development tools
    docker
    blockbench
    tableplus

    # Media and entertainment  
    iina
    obsidian
    prismlauncher
    transmission-gtk

    # Note: Apps not available or broken on current nixpkgs:
    # - ghostty (marked as broken)
    # - obs-studio (not available on macOS in nixpkgs)
    # - figma-linux (Linux-specific)
    # - spotify (may require different package)
    # - steam (may require different package)
    # - linear-linear, notion-calendar (not found in nixpkgs)
  ] ++ lib.optionals (!pkgs.stdenv.isDarwin) [
    # Linux-only packages
    figma-linux
    obs-studio
    spotify
    steam
  ];
}
