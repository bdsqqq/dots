{ config, pkgs, lib, ... }:

{
  imports = [
    ./shell.nix
    ./development.nix  
    ./neovim.nix
  ];

  # Home Manager needs a bit of information about you and the
  # paths it should manage.
  home.username = "bdsqqq";
  home.homeDirectory = "/Users/bdsqqq";

  # sops-nix configuration for secrets management (optional)
  sops = lib.mkIf (builtins.pathExists ../../secrets.yaml) {
    # age key file location (never commit this!)
    age.keyFile = "/Users/bdsqqq/.config/sops/age/keys.txt";
    
    # default secrets file location
    defaultSopsFile = ../../secrets.yaml;
    
    # secrets definitions go here
    secrets = {
      # api keys
      anthropic_api_key = {};
      copilot_token = {};
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
