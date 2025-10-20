{ lib, config, pkgs, ... }:
{
  imports = [
    ../system/ssh.nix
    ../system/tailscale.nix
    ../user/shell.nix
    ../system/fonts.nix
  ];
}


