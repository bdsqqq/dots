{ lib, config, pkgs, ... }:
{
  imports = [
    ../user/ghostty.nix
    ../system/bluetooth.nix
    ../user/apps.nix
  ];
}


