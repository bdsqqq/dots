{ config, pkgs, lib, isDarwin ? false, ... }:

{
  imports = [
    ./shell.nix
    ./development.nix
    ./neovim.nix
    ./applications.nix
    ./terminals.nix
    ./claude.nix
  ] ++ lib.optionals (!isDarwin) [ 
    ./waybar.nix
    ./notifications.nix
    ./launcher.nix
  ] ++ lib.optionals isDarwin [
    #
  ];

  home.username = "bdsqqq";
  home.homeDirectory = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  
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
      
      desktop = "${config.home.homeDirectory}/Desktop";
      templates = "${config.home.homeDirectory}/Templates";
      publicShare = "${config.home.homeDirectory}/Public";
    };
  };
  
  home.pointerCursor = lib.mkIf (!isDarwin) {
    gtk.enable = true;
    hyprcursor.enable = true;
    package = pkgs.apple-cursor;
    name = "macOS";
    size = 24;
  };

  sops = lib.mkIf (builtins.pathExists ../../secrets.yaml) {
    # age key file location (never commit this!)
    age.keyFile = "${config.home.homeDirectory}/.config/sops/age/keys.txt";

    defaultSopsFile = ../../secrets.yaml;

    secrets = {
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
