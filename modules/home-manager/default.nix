{ config, pkgs, lib, isDarwin ? false, ... }:

{
  imports = [
    # Core modules (cross-platform)
    ./shell.nix
    ./development.nix
    ./neovim.nix
    ./applications.nix
    ./terminals.nix
    ./firefox.nix
    ./claude.nix
  ] ++ lib.optionals (!isDarwin) [
    # Linux-specific modules (Wayland/X11 desktop environment)
    ./waybar.nix
    ./notifications.nix
    ./launcher.nix
    ./waybar-scripts.nix
  ];

  # Home Manager needs a bit of information about you and the
  # paths it should manage.
  home.username = "bdsqqq";
  home.homeDirectory = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";

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
