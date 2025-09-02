# server - minimal config for headless servers like htz-far
{ config, pkgs, lib, ... }:

{
  imports = [
    ./base.nix
  ];

  # server-specific minimal packages
  home.packages = with pkgs; [
    # network diagnostics
    tcpdump
    netcat
    nmap
  ];
}