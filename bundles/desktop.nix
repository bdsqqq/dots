{ lib, config, pkgs, ... }:
{
  imports = [
    ../system/audio.nix
    ../system/bluetooth.nix
    ../system/flatpak.nix
    ../user/ghostty.nix
    ../user/apps.nix
    ../user/spicetify.nix
  ];
}


