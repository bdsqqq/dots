# Linux-specific desktop features
{ config, pkgs, lib, ... }:

{
  imports = [
    # Linux-specific desktop modules
    ./waybar.nix
    ./notifications.nix
    ./launcher.nix
    ./pyprland.nix
    ./terminals.nix  # Ghostty config (stylix-dependent)
    ./applications-linux.nix  # GUI apps for Linux
  ];

  # XDG user directories (Linux desktop feature)
  xdg = {
    enable = true;
    userDirs = {
      enable = true;
      createDirectories = true;
      download = "${config.home.homeDirectory}/commonplace/00_inbox";
      documents = "${config.home.homeDirectory}/commonplace/00_inbox";
      pictures = "${config.home.homeDirectory}/commonplace/00_inbox";
      music = "${config.home.homeDirectory}/commonplace/00_inbox";
      videos = "${config.home.homeDirectory}/commonplace/00_inbox";
      desktop = "${config.home.homeDirectory}/Desktop";
      templates = "${config.home.homeDirectory}/Templates";
      publicShare = "${config.home.homeDirectory}/Public";
    };
  };

  # Cursor theme (Linux desktop-only)
  home.pointerCursor = {
    gtk.enable = true;
    hyprcursor.enable = true;
    package = pkgs.apple-cursor;
    name = "macOS";
    size = 24;
  };

  # Linux-specific desktop packages
  home.packages = with pkgs; [
    # Coding tools
    nodejs_22
    pnpm
    pscale
    go
    gofumpt
    golangci-lint
    gotools
    gopls
    gotests
    delve
    python3
    uv
    fnm
    oh-my-zsh
    cloc
    yazi
    httpie
    git-filter-repo
    graphite-cli

    # Media tools
    yt-dlp
    gallery-dl
    spotify-player
    ffmpeg
    exiftool
    fastfetch
    asciiquarium-transparent
    ctop
  ];
}