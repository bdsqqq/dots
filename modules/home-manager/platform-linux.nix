# platform-linux - linux-specific packages and configs
{ config, pkgs, lib, ... }:

{
  home.packages = with pkgs; [
    # linux system monitoring
    nvtopPackages.nvidia
  ];
  
  # linux-specific zsh config
  programs.zsh.initExtra = ''
    # linux-specific shell configurations
  '';
}