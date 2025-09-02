{ config, pkgs, lib, isDarwin ? false, ... }:

{
  imports = [
    # Linux-specific desktop modules
    ./waybar.nix
    ./notifications.nix
    ./launcher.nix
    ./pyprland.nix
  ] ++ lib.optionals (!isDarwin) [
    # Desktop-specific GUI applications
    ./applications.nix  # GUI apps like fuzzel, blueman, pavucontrol
    ./terminals.nix  # Ghostty config (stylix-dependent)
  ];

  # XDG user directories (Linux desktop feature)
  xdg = {
    enable = true;
    userDirs = lib.mkIf (!isDarwin) {
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

  # Cursor theme (desktop-only)
  home.pointerCursor = lib.mkIf (!isDarwin) {
    gtk.enable = true;
    hyprcursor.enable = true;
    package = pkgs.apple-cursor;
    name = "macOS";
    size = 24;
  };
}