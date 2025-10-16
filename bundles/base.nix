{ lib, config, pkgs, ... }:
{
  imports = [
    ../system/ssh.nix
    ../system/tailscale.nix
    ../user/shell.nix
    ../modules/shared/fonts.nix
  ];
}


