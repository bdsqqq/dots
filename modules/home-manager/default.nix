{ config, pkgs, lib, isDarwin ? false, ... }:

{
  imports = [
    # Core modules (cross-platform)
    ./shell.nix
    ./development.nix
    ./neovim.nix
    ./applications.nix
    ./terminals.nix
    ./claude.nix
    ./pnpm-global.nix
  ] ++ lib.optionals (!isDarwin) [
    # Linux-specific modules (Wayland/X11 desktop environment)
    ./waybar.nix
    ./notifications.nix
    ./launcher.nix
    ./pyprland.nix
    # Removed waybar-scripts.nix - replaced with native modules + pyprland
  ];

  # Home Manager needs a bit of information about you and the
  # paths it should manage.
  home.username = "bdsqqq";
  home.homeDirectory = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  
  # XDG user directories configuration
  # Route everything to inbox for processing into your organized system
  xdg = {
    enable = true;
    userDirs = lib.mkIf (!isDarwin) {
      enable = true;
      createDirectories = true;
      # Everything goes to inbox for processing
      download = "${config.home.homeDirectory}/commonplace/00_inbox";
      documents = "${config.home.homeDirectory}/commonplace/00_inbox";
      pictures = "${config.home.homeDirectory}/commonplace/00_inbox";
      music = "${config.home.homeDirectory}/commonplace/00_inbox";
      videos = "${config.home.homeDirectory}/commonplace/00_inbox";
      # Keep these minimal since you don't use them
      desktop = "${config.home.homeDirectory}/Desktop";
      templates = "${config.home.homeDirectory}/Templates";
      publicShare = "${config.home.homeDirectory}/Public";
    };
  };
  
  # Cursor theme configuration (traditional macOS-style cursor)
  home.pointerCursor = lib.mkIf (!isDarwin) {
    gtk.enable = true;
    hyprcursor.enable = true;
    package = pkgs.apple-cursor;  # Traditional macOS-style cursor
    name = "macOS";
    size = 24;
  };

  # sops-nix configuration for secrets management (optional)
  sops = lib.mkIf (builtins.pathExists ../../secrets.yaml) {
    # age key file location (never commit this!)
    age.keyFile = if isDarwin 
      then "/Users/bdsqqq/.config/sops/age/keys.txt"
      else "/home/bdsqqq/.config/sops/age/keys.txt";

    # default secrets file location
    defaultSopsFile = ../../secrets.yaml;

    # secrets definitions go here
    secrets = {
      # api keys
      anthropic_api_key = { };
    };
  };

  # This value determines the Home Manager release that your
  # configuration is compatible with. This helps avoid breakage
  # when a new Home Manager release introduces backwards
  # incompatible changes.
  #
  # You can update Home Manager without changing this value. See
  # the Home Manager release notes for a list of state version
  # changes in each release.
  home.stateVersion = "25.05";

  # Let Home Manager install and manage itself.
  programs.home-manager.enable = true;
}
