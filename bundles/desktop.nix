{ lib, config, pkgs, ... }:
{
  imports = [
    ../user/firefox.nix
    ../user/ghostty.nix
    ../system/bluetooth.nix
    ../user/apps.nix
  ];
}


