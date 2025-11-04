{ lib, config, pkgs, ... }:
{
  imports = [
    ../system/nix.nix
    ../system/ssh.nix
    ../system/tailscale.nix
    ../system/sops.nix
    ../user/path-order.nix
    ../user/shell.nix
    ../system/fonts.nix
  ];
}


