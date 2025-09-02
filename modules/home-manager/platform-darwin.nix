# platform-darwin - macos-specific packages and configs
{ config, pkgs, lib, ... }:

{
  home.packages = with pkgs; [
    # macos system monitoring
    istat-menus
  ];
  
  # macos-specific zsh config
  programs.zsh.initExtra = ''
    eval "$(/opt/homebrew/bin/brew shellenv)"
  '';
}