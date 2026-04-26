{ lib, config, pkgs, ... }: {
  imports = [
    ../system/audio.nix
    ../system/bluetooth.nix
    ../system/flatpak.nix
    ../user/apps.nix
    ../user/1password.nix
    ../user/helium.nix
    ../user/helium-remotes.nix
    ../user/spicetify.nix
  ];
}

