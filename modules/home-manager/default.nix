{ config, pkgs, lib, isDarwin ? false, ... }:

{
  imports = [
    # Core modules (cross-platform)
    ./shell.nix
    ./essentials.nix
    ./neovim.nix
    ./claude.nix
    ./pnpm-global.nix
  ] ++ lib.optionals (!isDarwin) [
    # Desktop environment (GUI applications and desktop-specific modules)
    ./desktop.nix
  ];

  # Home Manager needs a bit of information about you and the
  # paths it should manage.
  home.username = "bdsqqq";
  home.homeDirectory = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  




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
