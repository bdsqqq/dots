{ lib, config, pkgs, ... }:
{
  imports = [
    ../system/nix.nix
    ../system/ssh.nix
    ../system/tailscale.nix
    ../user/shell.nix
    ../system/fonts.nix
  ];
}


