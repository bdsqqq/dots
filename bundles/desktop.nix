{ lib, config, pkgs, ... }:
{
  imports = [
    ../system/audio.nix
    ../system/bluetooth.nix
    ../system/flatpak.nix
    ../user/apps.nix
    ../user/spicetify.nix
  ];
}


