{ config, pkgs, lib, isDarwin ? false, isServer ? false, ... }:

{
  imports = [
    # core modules for all machines
    ./base.nix
    ./shell.nix
    ./claude.nix
    ./pnpm-global.nix
  ] ++ lib.optionals (!isDarwin && !isServer) [
    # nixvim only on linux non-server machines
    ./neovim.nix
  ] ++ lib.optionals (!isServer) [
    # workbench tools for non-server machines
    ./workbench.nix
  ] ++ lib.optionals (isDarwin && !isServer) [
    # macos desktop features
    ./desktop-darwin.nix
    ./platform-darwin.nix
  ] ++ lib.optionals (!isDarwin && !isServer) [
    # linux desktop features
    ./desktop-linux.nix
    ./platform-linux.nix
  ] ++ lib.optionals (!isDarwin && isServer) [
    # linux server-specific
    ./platform-linux.nix
    ./server.nix
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
